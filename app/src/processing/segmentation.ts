import { type Vec3, norm, sub } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

/**
 * Detects ball contact near the peak of the swing.
 *
 * Contact is a near-step of tens of g in specific force, but a very fast swing
 * also changes its centripetal acceleration by several g per sample while it
 * speeds up. Searching only within `halfWindow` samples of peak racket rate
 * (where centripetal acceleration is momentarily constant) separates the two.
 * Returns the onset of the largest jump, or null for shadow swings and misses.
 */
export function detectImpact(
  accel: readonly Vec3[],
  peakIndex: number,
  halfWindow: number,
  thresholdG: number,
): number | null {
  const from = Math.max(1, peakIndex - halfWindow);
  const to = Math.min(accel.length - 1, peakIndex + halfWindow);
  const jump = (i: number): number => {
    const a0 = accel[i - 1];
    const a1 = accel[i];
    return a0 && a1 ? norm(sub(a1, a0)) / STANDARD_GRAVITY : 0;
  };
  let largest = 0;
  for (let i = from; i <= to; i++) largest = Math.max(largest, jump(i));
  if (largest <= thresholdG) return null;
  // Onset: first sample of the impact transient, not its strongest ringing.
  const onsetLevel = Math.max(thresholdG, 0.5 * largest);
  for (let i = from; i <= to; i++) {
    if (jump(i) >= onsetLevel) return i;
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
