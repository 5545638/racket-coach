import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import {
  IndexedDbRepository,
  MIGRATIONS,
  type Migration,
  applyMigrations,
  normaliseStroke,
} from '../../src/storage/repository';
import { SKEWED_MOUNT } from '../helpers';
import type { StrokeRecord } from '../../src/domain/types';
import { DEFAULT_ANALYSIS_PARAMS } from '../../src/metrics/analyzeSwing';
import { GOOD_FOREHAND } from '../fixtures';
import { DEFAULT_SETTINGS } from '../../src/app/settings';

describe('IndexedDbRepository', () => {
  it('persists calibration per device, settings, sessions and strokes', async () => {
    const repo = await IndexedDbRepository.open(`test-${String(Math.random())}`);
    expect(await repo.loadCalibration('A')).toBeNull();
    await repo.saveCalibration('A', SKEWED_MOUNT);
    expect(await repo.loadCalibration('A')).toEqual(SKEWED_MOUNT);
    expect(await repo.loadCalibration('B')).toBeNull();

    await repo.saveSettings(DEFAULT_SETTINGS);
    expect(await repo.loadSettings()).toEqual(DEFAULT_SETTINGS);

    await repo.saveSession({ id: 'old', startedAt: 1, label: 'old' });
    await repo.saveSession({ id: 'new', startedAt: 2, label: 'new' });
    expect((await repo.listSessions()).map((s) => s.id)).toEqual(['new', 'old']);
  });
});

const uniqueName = () => `test-${String(Math.random())}`;

const legacyStroke = (id: string, receivedAt: number): StrokeRecord => ({
  id,
  sessionId: 'sess',
  capture: {
    kind: 'swing',
    sequence: 1,
    sampleRateHz: 104,
    accelGPerLsb: 0.000488,
    gyroDpsPerLsb: 0.07,
    triggerIndex: 0,
    samples: Int16Array.of(1, 2, 3, 4, 5, 6),
    receivedAt,
  },
  metrics: GOOD_FOREHAND,
  cue: { ruleId: 'x', severity: 'good', text: 'Good' },
});

/** Creates a database exactly as app version 1 did, filled with old-format data. */
async function createV1Database(name: string): Promise<void> {
  const db = await openDB(name, 1, {
    upgrade(database) {
      database.createObjectStore('sessions', { keyPath: 'id' });
      database
        .createObjectStore('strokes', { keyPath: 'id' })
        .createIndex('bySession', 'sessionId');
      database.createObjectStore('kv');
    },
  });
  await db.put('sessions', { id: 'sess', startedAt: 5, label: 'old session' });
  await db.put('strokes', legacyStroke('b', 20));
  await db.put('strokes', legacyStroke('a', 10));
  await db.put('kv', SKEWED_MOUNT, 'calibration:A');
  await db.put('kv', DEFAULT_SETTINGS, 'settings');
  db.close();
}

describe('schema migrations', () => {
  it('opens a v1 database with old-format records and keeps all data', async () => {
    const name = uniqueName();
    await createV1Database(name);
    const repo = await IndexedDbRepository.open(name);

    expect((await repo.listSessions()).map((s) => s.id)).toEqual(['sess']);
    const strokes = await repo.strokesForSession('sess');
    expect(strokes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(strokes[0]?.analysisVersion).toBeUndefined();
    expect(strokes[0]?.calibration).toBeUndefined();
    expect(strokes[0]?.analysisParams).toBeUndefined();
    expect(strokes[0]?.capture.samples).toEqual(Int16Array.of(1, 2, 3, 4, 5, 6));
    expect(await repo.loadCalibration('A')).toEqual(SKEWED_MOUNT);
    expect(await repo.loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('upgrades a v1 database through a later step without touching existing data', async () => {
    const name = uniqueName();
    await createV1Database(name);
    const applied: number[] = [];
    const v2: Migration = {
      version: 2,
      apply(_database, transaction) {
        applied.push(2);
        // Rebuild an index: the stored records must survive and stay queryable.
        const strokes = transaction.objectStore('strokes');
        strokes.deleteIndex('bySession');
        strokes.createIndex('bySession', 'sessionId');
      },
    };
    const repo = await IndexedDbRepository.open(name, { migrations: [...MIGRATIONS, v2] });
    expect(applied).toEqual([2]);
    expect(await repo.strokesForSession('sess')).toHaveLength(2);
    expect(await repo.loadCalibration('A')).toEqual(SKEWED_MOUNT);
  });

  it('applies every step on a fresh database, in version order, and skips applied ones', () => {
    const calls: number[] = [];
    const step = (version: number): Migration => ({
      version,
      apply: () => calls.push(version),
    });
    const db = {} as never;
    const tx = {} as never;
    applyMigrations(db, tx, 0, [step(3), step(1), step(2)]);
    expect(calls).toEqual([1, 2, 3]);
    calls.length = 0;
    applyMigrations(db, tx, 2, [step(1), step(2), step(3)]);
    expect(calls).toEqual([3]);
    calls.length = 0;
    applyMigrations(db, tx, 3, [step(1), step(2), step(3)]);
    expect(calls).toEqual([]);
  });

  it('closes its connection when another tab wants to upgrade, and reports blocked upgrades', async () => {
    const name = uniqueName();
    const onBlocking = vi.fn();
    const onBlocked = vi.fn();
    await IndexedDbRepository.open(name, { onBlocking });
    const v2: Migration = { version: 2, apply: () => undefined };
    const upgraded = await IndexedDbRepository.open(name, {
      migrations: [...MIGRATIONS, v2],
      onBlocked,
    });
    expect(onBlocking).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
    await upgraded.saveSession({ id: 'x', startedAt: 1, label: 'x' });
  });

  it('reports a blocked upgrade while an older connection stays open', async () => {
    const name = uniqueName();
    // Plain connection that ignores versionchange, as a stuck old tab would.
    const stuck = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('kv');
      },
    });
    const onBlocked = vi.fn();
    const pending = IndexedDbRepository.open(name, {
      migrations: [{ version: 2, apply: () => undefined }],
      onBlocked,
    });
    await vi.waitFor(() => {
      expect(onBlocked).toHaveBeenCalled();
    });
    stuck.close();
    await pending;
  });
});

describe('stroke provenance', () => {
  const full: StrokeRecord = {
    ...legacyStroke('full', 1),
    analysisVersion: 2,
    analysisParams: { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: 1.2 },
    calibration: SKEWED_MOUNT,
  };

  it('round-trips version, parameters and the calibration snapshot', async () => {
    const repo = await IndexedDbRepository.open(uniqueName());
    await repo.saveCalibration('A', SKEWED_MOUNT);
    await repo.saveStroke(full);
    // Recalibration overwrites the device calibration, not the stroke's snapshot.
    await repo.saveCalibration('A', { ...SKEWED_MOUNT, createdAt: 'later' });
    const [loaded] = await repo.strokesForSession('sess');
    expect(loaded?.analysisVersion).toBe(2);
    expect(loaded?.analysisParams?.leverRadiusM).toBe(1.2);
    expect(loaded?.calibration).toEqual(SKEWED_MOUNT);
  });

  it('drops malformed provenance but keeps the stroke', () => {
    const broken = {
      ...full,
      analysisVersion: 'two',
      analysisParams: { leverRadiusM: 'x' },
      calibration: { version: 7 },
    } as unknown as StrokeRecord;
    const normalised = normaliseStroke(broken);
    expect(normalised.id).toBe('full');
    expect('analysisVersion' in normalised).toBe(false);
    expect('analysisParams' in normalised).toBe(false);
    expect('calibration' in normalised).toBe(false);
  });

  it('leaves valid and legacy records unchanged', () => {
    expect(normaliseStroke(full)).toEqual(full);
    const legacy = legacyStroke('l', 1);
    expect(normaliseStroke(legacy)).toEqual(legacy);
  });
});
