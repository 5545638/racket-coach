import { type Vec3, norm, sub } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

/**
 * Detects ball contact as the first sample after `from` where the specific
 * force jumps by more than `thresholdG` between consecutive samples.
 *
 * Swing acceleration changes smoothly (a few g per sample at ~100 Hz); the
 * string-bed impact is a near-step of tens of g, which also saturates the
 * accelerometer. Returns null for shadow swings and clean misses.
 */
export function detectImpact(
  accel: readonly Vec3[],
  from: number,
  thresholdG: number,
): number | null {
  for (let i = Math.max(1, from); i < accel.length; i++) {
    const a0 = accel[i - 1];
    const a1 = accel[i];
    if (!a0 || !a1) continue;
    if (norm(sub(a1, a0)) / STANDARD_GRAVITY > thresholdG) {
      return i;
    }
  }
  return null;
}

export function argMax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? -Infinity) > (values[best] ?? -Infinity)) best = i;
  }
  return best;
}

/**
 * Expands from `index` in both directions while `values` stays above
 * `threshold`. Returns the inclusive bounds of the active phase.
 */
export function activeRange(
  values: readonly number[],
  index: number,
  threshold: number,
): { readonly start: number; readonly end: number } {
  let start = index;
  while (start > 0 && (values[start - 1] ?? 0) > threshold) start--;
  let end = index;
  while (end < values.length - 1 && (values[end + 1] ?? 0) > threshold) end++;
  return { start, end };
}

/** Integrates ‖ω‖ over `[from, to)`, i.e. the total rotation path length, radians. */
export function rotationPath(
  gyro: readonly Vec3[],
  from: number,
  to: number,
  sampleRateHz: number,
): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const w = gyro[i];
    if (w) sum += norm(w);
  }
  return sum / sampleRateHz;
}
