import type { StrokeRecord, StrokeType } from '../domain/types';
import { S_MIN } from '../elements/catalog';
import { medianAbsoluteDeviation } from '../math/stats';

/**
 * Consistency score, 0–100 (docs/metrics.md, "Session report"): how little a
 * player's swing path, face angle and racket speed vary from stroke to
 * stroke, relative to what the sensor itself cannot resolve.
 */

/** MAD → standard deviation of a normal distribution. */
const MAD_TO_SD = 1.4826;

/** Spread at or below the noise floor scores 100; the score halves-ish every… */
const DECAY_FLOORS = 4;

/** Fewest strokes a metric needs before it is scored. */
export const MIN_CONSISTENCY_STROKES = 5;

/**
 * Noise floors: the engine's own minimum spreads for face and path (S_MIN,
 * elements/catalog.ts); for speed an engineering choice of ≈ 10 % of a
 * typical 15 m/s estimate, the model uncertainty of the speed estimate.
 */
export const NOISE_FLOORS = {
  faceDeg: S_MIN.faceDeg,
  pathDeg: S_MIN.pathDeg,
  speedMps: 1.5,
} as const;

export type ConsistencyMetric = 'face' | 'path' | 'speed';

/** Robust spread (MAD × 1.4826) of the values; null below the minimum count. */
export function robustSpread(values: readonly number[]): number | null {
  if (values.length < MIN_CONSISTENCY_STROKES) return null;
  return MAD_TO_SD * medianAbsoluteDeviation(values);
}

/**
 * 100 · exp(−max(0, s/floor − 1) / 4): 100 while the spread s is within the
 * noise floor, ≈ 78 at twice the floor, ≈ 37 at five times, ≈ 5 at 13 times.
 */
export function spreadScore(spread: number, floor: number): number {
  return 100 * Math.exp(-Math.max(0, spread / floor - 1) / DECAY_FLOORS);
}

export interface Consistency {
  /** 0–100, the mean of the scored metrics. */
  readonly score: number;
  /** Strokes that contributed at least one value. */
  readonly n: number;
  /** Per-metric scores; null when that metric had too few values. */
  readonly parts: Readonly<Record<ConsistencyMetric, number | null>>;
}

const finite = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);

/**
 * Consistency of strokes of ONE stroke type. Face and path use drive strokes
 * only (slices have opposite ideals); speed uses strokes with contact, no
 * signal gap and no clipped gyro (a clipped speed is only a lower bound).
 */
export function consistencyOf(records: readonly StrokeRecord[]): Consistency | null {
  const face: number[] = [];
  const path: number[] = [];
  const speed: number[] = [];
  let n = 0;
  for (const r of records) {
    const m = r.metrics;
    let used = false;
    if (m.swingStyle !== 'slice') {
      if (finite(m.faceTiltDeg)) {
        face.push(m.faceTiltDeg);
        used = true;
      }
      if (finite(m.swingPathDeg)) {
        path.push(m.swingPathDeg);
        used = true;
      }
    }
    if (
      m.impactDetected &&
      m.quality.signalGap !== true &&
      !m.quality.gyroSaturated &&
      finite(m.headSpeedMps)
    ) {
      speed.push(m.headSpeedMps);
      used = true;
    }
    if (used) n++;
  }
  const score = (values: number[], floor: number): number | null => {
    const s = robustSpread(values);
    return s === null ? null : spreadScore(s, floor);
  };
  const parts = {
    face: score(face, NOISE_FLOORS.faceDeg),
    path: score(path, NOISE_FLOORS.pathDeg),
    speed: score(speed, NOISE_FLOORS.speedMps),
  };
  const scored = Object.values(parts).filter(finite);
  if (scored.length === 0) return null;
  return { score: scored.reduce((a, b) => a + b, 0) / scored.length, n, parts };
}

const TYPES: readonly StrokeType[] = ['forehand', 'backhand', 'overhead'];

/** Consistency per stroke type that has enough strokes. */
export function consistencyByType(
  records: readonly StrokeRecord[],
): Partial<Record<StrokeType, Consistency>> {
  const out: Partial<Record<StrokeType, Consistency>> = {};
  for (const type of TYPES) {
    const c = consistencyOf(records.filter((r) => r.metrics.strokeType === type));
    if (c) out[type] = c;
  }
  return out;
}

/** One number for a whole session: the per-type scores weighted by their stroke counts. */
export function overallConsistency(
  records: readonly StrokeRecord[],
): { readonly score: number; readonly n: number } | null {
  const per = Object.values(consistencyByType(records));
  const n = per.reduce((a, c) => a + c.n, 0);
  if (per.length === 0 || n === 0) return null;
  return { score: per.reduce((a, c) => a + c.score * c.n, 0) / n, n };
}

/** Mean estimated head speed of one stroke type; `lowerBound` when any value was clipped. */
export interface SpeedEstimate {
  readonly meanMps: number;
  readonly n: number;
  readonly lowerBound: boolean;
}

export function speedEstimate(records: readonly StrokeRecord[]): SpeedEstimate | null {
  const used = records.filter(
    (r) =>
      r.metrics.impactDetected &&
      r.metrics.quality.signalGap !== true &&
      finite(r.metrics.headSpeedMps),
  );
  if (used.length === 0) return null;
  return {
    meanMps: used.reduce((a, r) => a + r.metrics.headSpeedMps, 0) / used.length,
    n: used.length,
    lowerBound: used.some((r) => r.metrics.quality.gyroSaturated),
  };
}
