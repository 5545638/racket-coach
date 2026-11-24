import {
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
  openDB,
} from 'idb';
import type { MountCalibration, SessionInfo, Settings, StrokeRecord } from '../domain/types';
import type { AnalysisParams } from '../metrics/analyzeSwing';

interface RacketCoachDb extends DBSchema {
  sessions: { key: string; value: SessionInfo };
  strokes: { key: string; value: StrokeRecord; indexes: { bySession: string } };
  kv: { key: string; value: unknown };
}

const DB_NAME = 'racket-coach';
const KEY_CALIBRATION = 'calibration';
const KEY_SETTINGS = 'settings';

/** Persistence boundary. Everything stays on the device. */
export interface Repository {
  saveSession(session: SessionInfo): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  saveStroke(stroke: StrokeRecord): Promise<void>;
  strokesForSession(sessionId: string): Promise<StrokeRecord[]>;
  /** Calibrations are per sensor: each sensor sits on one racket. */
  loadCalibration(deviceKey: string): Promise<MountCalibration | null>;
  saveCalibration(deviceKey: string, calibration: MountCalibration): Promise<void>;
  loadSettings(): Promise<Partial<Settings> | null>;
  saveSettings(settings: Settings): Promise<void>;
}

/** One schema step: brings a database from `version - 1` to `version`. */
export interface Migration {
  readonly version: number;
  readonly apply: (
    database: IDBPDatabase<RacketCoachDb>,
    transaction: IDBPTransaction<RacketCoachDb, StoreNames<RacketCoachDb>[], 'versionchange'>,
  ) => void;
}

/**
 * Ordered schema history; the database version is the last entry's version.
 *
 * Append a new entry for every schema change and never edit old ones: a
 * database at any earlier version walks through all later steps in order.
 * Per-stroke provenance fields (analysisVersion, analysisParams, calibration)
 * are optional properties of existing records and need no schema change, so
 * the schema is still at version 1.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    apply(database) {
      database.createObjectStore('sessions', { keyPath: 'id' });
      const strokes = database.createObjectStore('strokes', { keyPath: 'id' });
      strokes.createIndex('bySession', 'sessionId');
      database.createObjectStore('kv');
    },
  },
];

/** Runs every migration newer than `oldVersion`, in ascending order. */
export function applyMigrations(
  database: IDBPDatabase<RacketCoachDb>,
  transaction: IDBPTransaction<RacketCoachDb, StoreNames<RacketCoachDb>[], 'versionchange'>,
  oldVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (oldVersion < migration.version) migration.apply(database, transaction);
  }
}

/** Hooks for the two multi-tab upgrade situations; both default to logging. */
export interface OpenOptions {
  /** Test seam: schema history to apply. Defaults to {@link MIGRATIONS}. */
  readonly migrations?: readonly Migration[];
  /** Another tab holds an older version open and blocks our upgrade. */
  readonly onBlocked?: () => void;
  /** This connection blocks another tab's upgrade; it is closed automatically. */
  readonly onBlocking?: () => void;
}

export class IndexedDbRepository implements Repository {
  private constructor(private readonly db: IDBPDatabase<RacketCoachDb>) {}

  static async open(
    name: string = DB_NAME,
    options: OpenOptions = {},
  ): Promise<IndexedDbRepository> {
    const migrations = options.migrations ?? MIGRATIONS;
    const version = Math.max(...migrations.map((m) => m.version));
    const db = await openDB<RacketCoachDb>(name, version, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        applyMigrations(database, transaction, oldVersion, migrations);
      },
      blocked() {
        if (options.onBlocked) options.onBlocked();
        else console.warn('Database upgrade blocked by another tab');
      },
      blocking() {
        // Release the connection so the other tab's upgrade can proceed.
        db.close();
        options.onBlocking?.();
      },
    });
    return new IndexedDbRepository(db);
  }

  async saveSession(session: SessionInfo): Promise<void> {
    await this.db.put('sessions', session);
  }

  async listSessions(): Promise<SessionInfo[]> {
    const all = await this.db.getAll('sessions');
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async saveStroke(stroke: StrokeRecord): Promise<void> {
    await this.db.put('strokes', stroke);
  }

  async strokesForSession(sessionId: string): Promise<StrokeRecord[]> {
    const strokes = await this.db.getAllFromIndex('strokes', 'bySession', sessionId);
    return strokes.map(normaliseStroke).sort((a, b) => a.capture.receivedAt - b.capture.receivedAt);
  }

  async loadCalibration(deviceKey: string): Promise<MountCalibration | null> {
    const value = await this.db.get('kv', `${KEY_CALIBRATION}:${deviceKey}`);
    return isCalibration(value) ? value : null;
  }

  async saveCalibration(deviceKey: string, calibration: MountCalibration): Promise<void> {
    await this.db.put('kv', calibration, `${KEY_CALIBRATION}:${deviceKey}`);
  }

  async loadSettings(): Promise<Partial<Settings> | null> {
    const value = await this.db.get('kv', KEY_SETTINGS);
    // Contents are validated field by field in resolveSettings().
    return typeof value === 'object' && value !== null ? value : null;
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.db.put('kv', settings, KEY_SETTINGS);
  }
}

/** Guards against stale or corrupted data from older app versions. */
function isCalibration(value: unknown): value is MountCalibration {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const isTriple = (x: unknown): x is unknown[] => Array.isArray(x) && x.length === 3;
  return (
    v.version === 1 &&
    isTriple(v.racketFromSensor) &&
    v.racketFromSensor.every(isTriple) &&
    isTriple(v.gyroBias)
  );
}

/**
 * Upgrades a stored stroke on read. Records written before provenance was
 * kept have no `analysisVersion`, `analysisParams` or `calibration`; they load
 * unchanged. Provenance fields that are present but malformed are dropped
 * rather than trusted, so callers can rely on a field being valid if it exists.
 */
export function normaliseStroke(stroke: StrokeRecord): StrokeRecord {
  const { analysisVersion, analysisParams, calibration, ...rest } = stroke;
  const base: StrokeRecord = rest;
  return {
    ...base,
    ...(isPositiveInteger(analysisVersion) ? { analysisVersion } : {}),
    ...(isAnalysisParams(analysisParams) ? { analysisParams } : {}),
    ...(isCalibration(calibration) ? { calibration } : {}),
  };
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** A non-empty record of finite numbers; individual keys evolve with the analysis. */
function isAnalysisParams(value: unknown): value is AnalysisParams {
  if (typeof value !== 'object' || value === null) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((x) => typeof x === 'number' && Number.isFinite(x));
}
