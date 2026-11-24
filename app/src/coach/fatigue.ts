import type { StrokeMetrics, StrokeType } from '../domain/types';
import type { StrokeAssessment } from '../elements/assess';
import { median } from '../math/stats';

/**
 * Fatigue detector, per stroke type within one session (docs/metrics.md,
 * "Adaptive coach"). Compares the rolling median of the last 10 rated
 * strokes with the session's first 20. Every threshold is an engineering
 * choice, to be tuned on recorded long sessions.
 */
export interface FatigueConfig {
  /** Rated strokes of the type that form the early reference. */
  readonly earlyCount: number;
  /** Rated strokes in the rolling window. */
  readonly recentCount: number;
  /** Detection starts after this many rated strokes of the type… */
  readonly minStrokes: number;
  /** …or after this session time, with at least `minStrokesTimed` rated strokes. */
  readonly minSessionMs: number;
  readonly minStrokesTimed: number;
  /** Head-speed drop (fraction of the early median) that is required. */
  readonly speedDrop: number;
  /** Rise of the forward-swing time (fraction) that, with the speed drop, signals fatigue. */
  readonly forwardSwingRise: number;
  /** Or: the recent fault rate (faults per stroke) at least this × the early rate… */
  readonly faultRatio: number;
  /** …and at least this many faults per stroke (an early rate of 0 would otherwise make any fault count)… */
  readonly minFaultRate: number;
  /** …spread over at least this many different elements. */
  readonly minDistinctElements: number;
  /** Fatigue clears when the head-speed drop is back below this fraction. */
  readonly recoveredDrop: number;
  /** A gap between strokes this long is a break: fatigue clears and the rolling window restarts. */
  readonly breakMs: number;
}

export const DEFAULT_FATIGUE_CONFIG: FatigueConfig = {
  earlyCount: 20,
  recentCount: 10,
  minStrokes: 40,
  minSessionMs: 30 * 60_000,
  minStrokesTimed: 30,
  speedDrop: 0.08,
  forwardSwingRise: 0.1,
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

export interface TypeFatigue {
  /** First `earlyCount` rated strokes of the session. */
  readonly early: readonly FatigueSample[];
  /** Last `recentCount` rated strokes since the last break, newest last. */
  readonly recent: readonly FatigueSample[];
  /** Rated strokes of the type in the session. */
  readonly count: number;
  readonly active: boolean;
}

export interface FatigueState {
  readonly sessionStart: number | null;
  readonly lastStrokeAt: number | null;
  readonly byType: Readonly<Record<StrokeType, TypeFatigue>>;
}

const FRESH: TypeFatigue = { early: [], recent: [], count: 0, active: false };

export const initialFatigue = (sessionStart: number | null = null): FatigueState => ({
  sessionStart,
  lastStrokeAt: null,
  byType: { forehand: FRESH, backhand: FRESH, overhead: FRESH },
});

/** Measured comparison of the rolling window with the early reference. */
export interface FatigueReading {
  /** 1 − median(recent speed) / median(early speed). */
  readonly speedDrop: number;
  /** median(recent forward-swing time) / median(early) − 1; null when unknown. */
  readonly forwardSwingRise: number | null;
  readonly earlyFaultRate: number;
  readonly recentFaultRate: number;
  readonly distinctFaultElements: number;
}

const medianOf = (xs: readonly number[]): number | null => (xs.length === 0 ? null : median(xs));

export function readFatigue(t: TypeFatigue): FatigueReading | null {
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

/** Whether a reading shows fatigue (the activation rule). */
export function showsFatigue(r: FatigueReading, config: FatigueConfig): boolean {
  if (r.speedDrop < config.speedDrop) return false;
  const slower = r.forwardSwingRise !== null && r.forwardSwingRise >= config.forwardSwingRise;
  const sloppier =
    r.distinctFaultElements >= config.minDistinctElements &&
    r.recentFaultRate >= Math.max(config.faultRatio * r.earlyFaultRate, config.minFaultRate);
  return slower || sloppier;
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
 * previous stroke (any type) clears every type and restarts the rolling windows.
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
  const byType: Record<StrokeType, TypeFatigue> = rested
    ? {
        forehand: { ...state.byType.forehand, recent: [], active: false },
        backhand: { ...state.byType.backhand, recent: [], active: false },
        overhead: { ...state.byType.overhead, recent: [], active: false },
      }
    : { ...state.byType };
  const sample = fatigueSample(metrics, assessment);
  if (sample !== null) {
    const type = metrics.strokeType;
    const t = byType[type];
    const count = t.count + 1;
    const early = t.early.length < config.earlyCount ? [...t.early, sample] : t.early;
    const recent = [...t.recent, sample].slice(-config.recentCount);
    const next: TypeFatigue = { early, recent, count, active: t.active };
    const eligible =
      early.length >= config.earlyCount &&
      recent.length >= config.recentCount &&
      (count >= config.minStrokes ||
        (count >= config.minStrokesTimed && receivedAt - sessionStart >= config.minSessionMs));
    const reading = eligible ? readFatigue(next) : null;
    const active =
      reading === null
        ? false
        : t.active
          ? reading.speedDrop >= config.recoveredDrop
          : showsFatigue(reading, config);
    byType[type] = { ...next, active };
  }
  return { sessionStart, lastStrokeAt: receivedAt, byType };
}

export const isFatigued = (state: FatigueState, type?: StrokeType): boolean =>
  type === undefined
    ? state.byType.forehand.active || state.byType.backhand.active || state.byType.overhead.active
    : state.byType[type].active;
