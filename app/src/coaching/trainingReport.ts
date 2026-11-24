import type { CoachMode, StrokeRecord, StrokeType } from '../domain/types';
import type { CorrectionId } from './corrections';
import {
  type Consistency,
  type SpeedEstimate,
  consistencyByType,
  overallConsistency,
  speedEstimate,
} from './consistency';
import { type StrokeVerdict, tallyCorrections, verdictCounts } from './strokeFacts';

/**
 * The numbers of the session report (docs/metrics.md, "Session report").
 * Pure: strokes in, plain numbers out; the UI turns them into text.
 */

export const REPORT_STROKE_TYPES: readonly StrokeType[] = ['forehand', 'backhand', 'overhead'];

/** Most strengths / errors listed. */
export const REPORT_TOP = 3;
/** A strength: judged on at least this many strokes… */
export const STRENGTH_MIN_ASSESSED = 10;
/** …and inside its band on at least this share of them. */
export const STRENGTH_MIN_SHARE = 0.7;
/** An error is listed once it happened at least this often. */
export const ERROR_MIN_COUNT = 2;
/** Improvement within a session needs at least this many strokes. */
export const IMPROVEMENT_MIN_STROKES = 20;
/** A fault rate must move by at least this much (absolute) to get an arrow. */
export const RATE_STEP = 0.05;
/** A consistency score must move by at least this many points. */
export const SCORE_STEP = 5;
/** Strokes per half needed for a half's fault rate / consistency. */
const HALF_MIN_ASSESSED = 3;

export type Direction = 'better' | 'worse' | 'same';

export interface ErrorRow {
  readonly correctionId: CorrectionId;
  readonly count: number;
  /** Fault share of the strokes it was judged on (0–1). */
  readonly share: number;
  readonly assessed: number;
}

export interface StrengthRow {
  readonly correctionId: CorrectionId;
  readonly share: number;
  readonly assessed: number;
}

export interface ErrorTrend {
  readonly correctionId: CorrectionId;
  readonly first: number | null;
  readonly second: number | null;
  readonly direction: Direction | null;
}

export interface Improvement {
  /** False below {@link IMPROVEMENT_MIN_STROKES} strokes. */
  readonly enough: boolean;
  readonly strokes: number;
  readonly errors: readonly ErrorTrend[];
  readonly consistency: {
    readonly first: number | null;
    readonly second: number | null;
    readonly direction: Direction | null;
  } | null;
}

export interface TrainingReport {
  readonly totals: Readonly<Record<'all' | StrokeType, number>>;
  /** Mean estimated racket speed per stroke type with strokes. */
  readonly speed: Readonly<Partial<Record<StrokeType, SpeedEstimate>>>;
  readonly consistency: Readonly<Partial<Record<StrokeType, Consistency>>>;
  readonly overallConsistency: { readonly score: number; readonly n: number } | null;
  readonly verdicts: Readonly<Record<StrokeVerdict, number>>;
  readonly strengths: readonly StrengthRow[];
  readonly errors: readonly ErrorRow[];
  readonly improvement: Improvement;
  /** First to last stroke, ms; null with fewer than two strokes. */
  readonly durationMs: number | null;
  /** Most used coaching mode of the strokes; null when none is recorded. */
  readonly mode: CoachMode | null;
}

const byTime = (a: StrokeRecord, b: StrokeRecord): number =>
  a.capture.receivedAt - b.capture.receivedAt;

function direction(
  first: number | null,
  second: number | null,
  step: number,
  lowerIsBetter: boolean,
): Direction | null {
  if (first === null || second === null) return null;
  const delta = second - first;
  if (Math.abs(delta) < step) return 'same';
  return delta < 0 === lowerIsBetter ? 'better' : 'worse';
}

export function topErrors(records: readonly StrokeRecord[], limit = REPORT_TOP): ErrorRow[] {
  return tallyCorrections(records)
    .filter((t) => t.faults >= ERROR_MIN_COUNT)
    .map((t) => ({
      correctionId: t.correctionId,
      count: t.faults,
      share: t.faults / t.assessed,
      assessed: t.assessed,
    }))
    .sort(
      (a, b) =>
        b.count - a.count || b.share - a.share || a.correctionId.localeCompare(b.correctionId),
    )
    .slice(0, limit);
}

export function topStrengths(records: readonly StrokeRecord[], limit = REPORT_TOP): StrengthRow[] {
  return tallyCorrections(records)
    .filter(
      (t) => t.assessed >= STRENGTH_MIN_ASSESSED && t.inBand / t.assessed >= STRENGTH_MIN_SHARE,
    )
    .map((t) => ({
      correctionId: t.correctionId,
      share: t.inBand / t.assessed,
      assessed: t.assessed,
    }))
    .sort(
      (a, b) =>
        b.share - a.share ||
        b.assessed - a.assessed ||
        a.correctionId.localeCompare(b.correctionId),
    )
    .slice(0, limit);
}

/** First half against second half of the session, by stroke order. */
export function improvementWithin(
  records: readonly StrokeRecord[],
  errors: readonly ErrorRow[],
): Improvement {
  if (records.length < IMPROVEMENT_MIN_STROKES) {
    return { enough: false, strokes: records.length, errors: [], consistency: null };
  }
  const sorted = [...records].sort(byTime);
  const mid = Math.floor(sorted.length / 2);
  const halves = [sorted.slice(0, mid), sorted.slice(mid)] as const;
  const tallies = halves.map((h) => new Map(tallyCorrections(h).map((t) => [t.correctionId, t])));
  const rate = (i: 0 | 1, id: CorrectionId): number | null => {
    const t = tallies[i]?.get(id);
    return t && t.assessed >= HALF_MIN_ASSESSED ? t.faults / t.assessed : null;
  };
  const score = (h: readonly StrokeRecord[]): number | null => {
    const c = overallConsistency(h);
    return c ? c.score : null;
  };
  const cFirst = score(halves[0]);
  const cSecond = score(halves[1]);
  return {
    enough: true,
    strokes: records.length,
    errors: errors.map((e) => {
      const first = rate(0, e.correctionId);
      const second = rate(1, e.correctionId);
      return {
        correctionId: e.correctionId,
        first,
        second,
        direction: direction(first, second, RATE_STEP, true),
      };
    }),
    consistency:
      cFirst === null && cSecond === null
        ? null
        : {
            first: cFirst,
            second: cSecond,
            direction: direction(cFirst, cSecond, SCORE_STEP, false),
          },
  };
}

function dominantMode(records: readonly StrokeRecord[]): CoachMode | null {
  const counts = new Map<CoachMode, number>();
  for (const r of records) {
    const m = r.coach?.mode;
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best: CoachMode | null = null;
  let bestN = 0;
  for (const [m, n] of counts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}

export function buildTrainingReport(records: readonly StrokeRecord[]): TrainingReport {
  const ofType = (t: StrokeType) => records.filter((r) => r.metrics.strokeType === t);
  const speed: Partial<Record<StrokeType, SpeedEstimate>> = {};
  for (const t of REPORT_STROKE_TYPES) {
    const s = speedEstimate(ofType(t));
    if (s) speed[t] = s;
  }
  const errors = topErrors(records);
  const times = records.map((r) => r.capture.receivedAt);
  return {
    totals: {
      all: records.length,
      forehand: ofType('forehand').length,
      backhand: ofType('backhand').length,
      overhead: ofType('overhead').length,
    },
    speed,
    consistency: consistencyByType(records),
    overallConsistency: overallConsistency(records),
    verdicts: verdictCounts(records),
    strengths: topStrengths(records),
    errors,
    improvement: improvementWithin(records, errors),
    durationMs: records.length < 2 ? null : Math.max(...times) - Math.min(...times),
    mode: dominantMode(records),
  };
}
