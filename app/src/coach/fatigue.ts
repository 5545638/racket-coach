import type { StrokeMetrics, StrokeType, SwingSize, SwingStyle } from '../domain/types';
import type { StrokeAssessment } from '../elements/assess';
import { median } from '../math/stats';

/**
 * Fatigue detector, per stroke type within one session (docs/metrics.md,
 * "Adaptive coach"). Strokes are compared like with like: per stroke type,
 * swing size and swing style, the rolling median of the last 10 rated
 * strokes against the first 20 of the same kind. Every threshold is an
 * engineering choice, to be tuned on recorded long sessions.
 */
export interface FatigueConfig {
  /** Rated strokes of the bucket that form the early reference. */
  readonly earlyCount: number;
  /** Rated strokes in the rolling window. */
  readonly recentCount: number;
  /** Detection starts after this many rated strokes of the bucket… */
  readonly minStrokes: number;
  /** …and this much time since the session start (or the end of the last break). */
  readonly minSessionMs: number;
  /** Head-speed drop (fraction of the early median) that is required… */
  readonly speedDrop: number;
  /** …together with: the recent fault rate (faults per stroke) at least this × the early rate… */
  readonly faultRatio: number;
  /** …and at least this many faults per stroke (an early rate of 0 would otherwise make any fault count)… */
  readonly minFaultRate: number;
  /** …spread over at least this many different elements. */
  readonly minDistinctElements: number;
  /** Fatigue clears when the head-speed drop is back below this fraction. */
  readonly recoveredDrop: number;
  /**
   * A gap between strokes this long is a break: fatigue clears and every
   * reference and window restarts (the strokes after it are a new warm-up).
   */
  readonly breakMs: number;
}

export const DEFAULT_FATIGUE_CONFIG: FatigueConfig = {
  earlyCount: 20,
  recentCount: 10,
  minStrokes: 30,
  minSessionMs: 15 * 60_000,
  speedDrop: 0.08,
  faultRatio: 2,
  minFaultRate: 0.3,
  minDistinctElements: 2,
  recoveredDrop: 0.04,
  breakMs: 3 * 60_000,
};

export interface FatigueSample {
  readonly headSpeedMps: number;
  readonly forwardSwingMs: number | null;
  /** Element keys at fault. */
  readonly faults: readonly string[];
}

/** Strokes of one kind: stroke type × swing size × swing style (unknown style = drive). */
export type FatigueBucketKey = `${SwingSize}-${SwingStyle}`;

export const fatigueBucketOf = (
  m: Pick<StrokeMetrics, 'swingSize' | 'swingStyle'>,
): FatigueBucketKey => `${m.swingSize}-${m.swingStyle ?? 'drive'}`;

export interface FatigueBucket {
  /** First `earlyCount` rated strokes of the bucket since the session start or the last break. */
  readonly early: readonly FatigueSample[];
  /** Last `recentCount` rated strokes, newest last. */
  readonly recent: readonly FatigueSample[];
  /** Rated strokes of the bucket since the session start or the last break. */
  readonly count: number;
}

export interface TypeFatigue {
  readonly buckets: Readonly<Partial<Record<FatigueBucketKey, FatigueBucket>>>;
  readonly active: boolean;
}

export interface FatigueState {
  readonly sessionStart: number | null;
  /** Start of the current stretch of play: the session start, or the first stroke after a break. */
  readonly windowStart: number | null;
  readonly lastStrokeAt: number | null;
  readonly byType: Readonly<Record<StrokeType, TypeFatigue>>;
}

const FRESH: TypeFatigue = { buckets: {}, active: false };
const EMPTY_BUCKET: FatigueBucket = { early: [], recent: [], count: 0 };

export const initialFatigue = (sessionStart: number | null = null): FatigueState => ({
  sessionStart,
  windowStart: sessionStart,
  lastStrokeAt: null,
  byType: { forehand: FRESH, backhand: FRESH, overhead: FRESH },
});

/** Measured comparison of the rolling window with the early reference. */
export interface FatigueReading {
  /** 1 − median(recent speed) / median(early speed). */
  readonly speedDrop: number;
  /** median(recent forward-swing time) / median(early) − 1; null when unknown. Shown only. */
  readonly forwardSwingRise: number | null;
  readonly earlyFaultRate: number;
  readonly recentFaultRate: number;
  readonly distinctFaultElements: number;
}

const medianOf = (xs: readonly number[]): number | null => (xs.length === 0 ? null : median(xs));

export function readFatigue(t: FatigueBucket): FatigueReading | null {
  const earlySpeed = medianOf(t.early.map((s) => s.headSpeedMps));
  const recentSpeed = medianOf(t.recent.map((s) => s.headSpeedMps));
  if (earlySpeed === null || recentSpeed === null || earlySpeed <= 0) return null;
  const fwd = (xs: readonly FatigueSample[]) =>
    medianOf(xs.map((s) => s.forwardSwingMs).filter((x): x is number => x !== null));
  const earlyFwd = fwd(t.early);
  const recentFwd = fwd(t.recent);
  const faults = (xs: readonly FatigueSample[]) => xs.reduce((n, s) => n + s.faults.length, 0);
  return {
    speedDrop: 1 - recentSpeed / earlySpeed,
    forwardSwingRise:
      earlyFwd === null || recentFwd === null || earlyFwd <= 0 ? null : recentFwd / earlyFwd - 1,
    earlyFaultRate: faults(t.early) / t.early.length,
    recentFaultRate: faults(t.recent) / t.recent.length,
    distinctFaultElements: new Set(t.recent.flatMap((s) => s.faults)).size,
  };
}

/**
 * Whether a reading shows fatigue (the activation rule): slower **and**
 * sloppier. A slower swing alone may be a deliberate control drill.
 */
export function showsFatigue(r: FatigueReading, config: FatigueConfig): boolean {
  if (r.speedDrop < config.speedDrop) return false;
  return (
    r.distinctFaultElements >= config.minDistinctElements &&
    r.recentFaultRate >= Math.max(config.faultRatio * r.earlyFaultRate, config.minFaultRate)
  );
}

/** One rated stroke's sample, or null when the stroke does not count. */
export function fatigueSample(
  metrics: StrokeMetrics,
  assessment: StrokeAssessment,
): FatigueSample | null {
  if (!assessment.contact || metrics.quality.signalGap === true) return null;
  if (!assessment.elements.some((e) => e.status === 'ok' || e.status === 'fault')) return null;
  if (!Number.isFinite(metrics.headSpeedMps) || metrics.headSpeedMps <= 0) return null;
  return {
    headSpeedMps: metrics.headSpeedMps,
    forwardSwingMs: metrics.features?.forwardSwingMs ?? null,
    faults: assessment.faults.map((f) => f.key),
  };
}

/**
 * Adds one stroke. Pure; O(window) per stroke. A gap of `breakMs` since the
 * previous stroke (any type) clears every type and restarts every reference
 * and window: the strokes after a break are a new warm-up.
 */
export function updateFatigue(
  state: FatigueState,
  metrics: StrokeMetrics,
  assessment: StrokeAssessment,
  receivedAt: number,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG,
): FatigueState {
  const sessionStart = state.sessionStart ?? receivedAt;
  const rested = state.lastStrokeAt !== null && receivedAt - state.lastStrokeAt >= config.breakMs;
  const windowStart = rested ? receivedAt : (state.windowStart ?? sessionStart);
  const byType: Record<StrokeType, TypeFatigue> = rested
    ? { forehand: FRESH, backhand: FRESH, overhead: FRESH }
    : { ...state.byType };
  const sample = fatigueSample(metrics, assessment);
  if (sample !== null) {
    const type = metrics.strokeType;
    const key = fatigueBucketOf(metrics);
    const t = byType[type];
    const b = t.buckets[key] ?? EMPTY_BUCKET;
    const count = b.count + 1;
    const early = b.early.length < config.earlyCount ? [...b.early, sample] : b.early;
    const recent = [...b.recent, sample].slice(-config.recentCount);
    const next: FatigueBucket = { early, recent, count };
    const eligible =
      early.length >= config.earlyCount &&
      recent.length >= config.recentCount &&
      count >= config.minStrokes &&
      receivedAt - windowStart >= config.minSessionMs;
    const reading = eligible ? readFatigue(next) : null;
    // Only a reading of this stroke's own kind decides; other kinds leave the flag alone.
    const active =
      reading === null
        ? t.active
        : t.active
          ? reading.speedDrop >= config.recoveredDrop
          : showsFatigue(reading, config);
    byType[type] = { buckets: { ...t.buckets, [key]: next }, active };
  }
  return { sessionStart, windowStart, lastStrokeAt: receivedAt, byType };
}

export const isFatigued = (state: FatigueState, type?: StrokeType): boolean =>
  type === undefined
    ? state.byType.forehand.active || state.byType.backhand.active || state.byType.overhead.active
    : state.byType[type].active;
