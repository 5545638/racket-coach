import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { MountCalibration, SessionInfo, StrokeRecord } from '../domain/types';
import type { Settings } from '../app/settings';

interface RacketCoachDb extends DBSchema {
  sessions: { key: string; value: SessionInfo };
  strokes: { key: string; value: StrokeRecord; indexes: { bySession: string } };
  kv: { key: string; value: unknown };
}

const DB_NAME = 'racket-coach';
const DB_VERSION = 1;
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

export class IndexedDbRepository implements Repository {
  private constructor(private readonly db: IDBPDatabase<RacketCoachDb>) {}

  static async open(name: string = DB_NAME): Promise<IndexedDbRepository> {
    const db = await openDB<RacketCoachDb>(name, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore('sessions', { keyPath: 'id' });
        const strokes = database.createObjectStore('strokes', { keyPath: 'id' });
        strokes.createIndex('bySession', 'sessionId');
        database.createObjectStore('kv');
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
    return strokes.sort((a, b) => a.capture.receivedAt - b.capture.receivedAt);
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
