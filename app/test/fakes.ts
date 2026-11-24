import type { Settings } from '../src/app/settings';
import type { MountCalibration, SessionInfo, StrokeRecord } from '../src/domain/types';
import type { Repository } from '../src/storage/repository';
import type { Scheduler } from '../src/transport/simulatedTransport';

export class InMemoryRepository implements Repository {
  readonly sessions = new Map<string, SessionInfo>();
  readonly strokes: StrokeRecord[] = [];
  readonly calibrations = new Map<string, MountCalibration>();
  settings: Settings | null = null;

  saveSession(session: SessionInfo) {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }
  listSessions() {
    return Promise.resolve([...this.sessions.values()]);
  }
  saveStroke(stroke: StrokeRecord) {
    this.strokes.push(stroke);
    return Promise.resolve();
  }
  strokesForSession(sessionId: string) {
    return Promise.resolve(this.strokes.filter((s) => s.sessionId === sessionId));
  }
  recentStrokes(limit: number) {
    const newestFirst = [...this.strokes].sort(
      (a, b) => b.capture.receivedAt - a.capture.receivedAt,
    );
    return Promise.resolve(newestFirst.slice(0, Math.max(0, limit)));
  }
  loadCalibration(deviceKey: string) {
    return Promise.resolve(this.calibrations.get(deviceKey) ?? null);
  }
  saveCalibration(deviceKey: string, calibration: MountCalibration) {
    this.calibrations.set(deviceKey, calibration);
    return Promise.resolve();
  }
  loadSettings() {
    return Promise.resolve(this.settings);
  }
  saveSettings(settings: Settings) {
    this.settings = settings;
    return Promise.resolve();
  }
}

/** Runs timeouts synchronously and never fires intervals on its own. */
export const immediateScheduler: Scheduler = {
  setInterval: () => 0,
  clearInterval: () => undefined,
  setTimeout: (fn) => {
    fn();
    return 0;
  },
};
