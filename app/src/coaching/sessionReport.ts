import type { StrokeRecord, StrokeType } from '../domain/types';

export interface FaultShare {
  readonly ruleId: string;
  readonly cue: string;
  readonly count: number;
  /** Share of the rated strokes of this type that got this cue. */
  readonly share: number;
}

export interface StrokeTypeReport {
  readonly strokeType: StrokeType;
  /** Strokes with a rating (good or a correction); "no reading" is excluded. */
  readonly rated: number;
  readonly goodShare: number;
  /** Corrections, most frequent first. */
  readonly faults: readonly FaultShare[];
}

export interface SessionReport {
  readonly totalStrokes: number;
  readonly unrated: number;
  readonly byStroke: readonly StrokeTypeReport[];
  /**
   * The one thing to work on next: the most frequent correction of the
   * session, if it is frequent enough to be a pattern rather than noise.
   */
  readonly focus: (FaultShare & { readonly strokeType: StrokeType }) | null;
}

/** A fault is a pattern when it shows up at least this often… */
const MIN_FOCUS_COUNT = 5;
/** …and in at least this share of the rated strokes of that type. */
const MIN_FOCUS_SHARE = 0.25;

const STROKE_TYPES: readonly StrokeType[] = ['forehand', 'backhand', 'overhead'];

/** What a coach would say after the session: where the strokes stand and what to fix first. */
export function buildSessionReport(records: readonly StrokeRecord[]): SessionReport {
  const byStroke = STROKE_TYPES.map((strokeType): StrokeTypeReport => {
    const rated = records.filter(
      (r) => r.metrics.strokeType === strokeType && r.cue.severity !== 'none',
    );
    const counts = new Map<string, { cue: string; count: number }>();
    for (const r of rated) {
      if (r.cue.severity !== 'fix') continue;
      const entry = counts.get(r.cue.ruleId) ?? { cue: r.cue.text, count: 0 };
      entry.count += 1;
      counts.set(r.cue.ruleId, entry);
    }
    const faults = [...counts.entries()]
      .map(([ruleId, { cue, count }]) => ({ ruleId, cue, count, share: count / rated.length }))
      .sort((a, b) => b.count - a.count);
    return {
      strokeType,
      rated: rated.length,
      goodShare: rated.length
        ? rated.filter((r) => r.cue.severity === 'good').length / rated.length
        : 0,
      faults,
    };
  }).filter((s) => s.rated > 0);

  const candidates = byStroke.flatMap((s) =>
    s.faults
      .filter((f) => f.count >= MIN_FOCUS_COUNT && f.share >= MIN_FOCUS_SHARE)
      .map((f) => ({ ...f, strokeType: s.strokeType })),
  );
  candidates.sort((a, b) => b.count - a.count);

  return {
    totalStrokes: records.length,
    unrated: records.filter((r) => r.cue.severity === 'none').length,
    byStroke,
    focus: candidates[0] ?? null,
  };
}
