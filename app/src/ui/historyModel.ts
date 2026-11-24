import type { CorrectionId } from '../coaching/corrections';
import { overallConsistency, speedEstimate } from '../coaching/consistency';
import { faultRate, tallyCorrections } from '../coaching/strokeFacts';
import type { SessionInfo, StrokeRecord, StrokeType } from '../domain/types';
import { dayMonth } from './charts';

/**
 * Multi-session history (Profile tab). Pure: the sessions and strokes come
 * from the repository (listSessions + strokesForSession), the aggregation is
 * one pass over the strokes.
 */

export const HISTORY_MAX_SESSIONS = 20;
/** Weaknesses drawn as small multiples. */
export const HISTORY_WEAKNESSES = 3;
/** A session's fault rate needs at least this many strokes judged on the correction. */
export const HISTORY_MIN_JUDGED = 5;

const TYPES: readonly StrokeType[] = ['forehand', 'backhand', 'overhead'];

export interface SpeedPoint {
  readonly meanMps: number;
  readonly lowerBound: boolean;
}

export interface HistorySession {
  readonly id: string;
  readonly startedAt: number;
  /** "dd.mm" */
  readonly label: string;
  readonly total: number;
  readonly byType: Readonly<Record<StrokeType, number>>;
  readonly speed: Readonly<Record<StrokeType, SpeedPoint | null>>;
  /** Session consistency 0–100 (see coaching/consistency.ts); null with too few strokes. */
  readonly consistency: number | null;
  /** Fault rate (0–1) per weakness; null when judged on too few strokes. */
  readonly faultRates: Readonly<Partial<Record<CorrectionId, number | null>>>;
}

export interface SessionHistory {
  /** Oldest first, only sessions with strokes. */
  readonly sessions: readonly HistorySession[];
  /** The most frequent faults over the shown sessions, most frequent first. */
  readonly weaknesses: readonly CorrectionId[];
}

export function sessionHistory(
  sessions: readonly SessionInfo[],
  strokes: readonly StrokeRecord[],
  limit = HISTORY_MAX_SESSIONS,
): SessionHistory {
  const bySession = new Map<string, StrokeRecord[]>();
  for (const s of strokes) {
    const list = bySession.get(s.sessionId);
    if (list) list.push(s);
    else bySession.set(s.sessionId, [s]);
  }
  const shown = sessions
    .filter((s) => (bySession.get(s.id)?.length ?? 0) > 0)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-limit);

  const faultTotals = new Map<CorrectionId, number>();
  const tallies = shown.map((s) => {
    const t = tallyCorrections(bySession.get(s.id) ?? []);
    for (const row of t) {
      faultTotals.set(row.correctionId, (faultTotals.get(row.correctionId) ?? 0) + row.faults);
    }
    return new Map(t.map((row) => [row.correctionId, row]));
  });
  const weaknesses = [...faultTotals.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, HISTORY_WEAKNESSES)
    .map(([id]) => id);

  return {
    weaknesses,
    sessions: shown.map((s, i): HistorySession => {
      const own = bySession.get(s.id) ?? [];
      const ofType = (t: StrokeType) => own.filter((r) => r.metrics.strokeType === t);
      const byType = {
        forehand: ofType('forehand').length,
        backhand: ofType('backhand').length,
        overhead: ofType('overhead').length,
      };
      const speed = Object.fromEntries(
        TYPES.map((t) => {
          const e = speedEstimate(ofType(t));
          return [t, e ? { meanMps: e.meanMps, lowerBound: e.lowerBound } : null];
        }),
      ) as Record<StrokeType, SpeedPoint | null>;
      const tally = tallies[i];
      return {
        id: s.id,
        startedAt: s.startedAt,
        label: dayMonth(s.startedAt),
        total: own.length,
        byType,
        speed,
        consistency: overallConsistency(own)?.score ?? null,
        faultRates: Object.fromEntries(
          weaknesses.map((id) => [id, faultRate(tally?.get(id), HISTORY_MIN_JUDGED)]),
        ),
      };
    }),
  };
}
