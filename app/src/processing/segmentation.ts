import { type Vec3, norm, sub } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

/**
 * Detects ball contact near the peak of the swing.
 *
 * Contact is a near-step of tens of g in specific force, but a very fast swing
 * also changes its centripetal acceleration by several g per sample while it
 * speeds up. Searching only within `halfWindow` samples of peak racket rate
 * (where centripetal acceleration is momentarily constant) separates the two.
 *
 * The impact also jolts the racket's rotation, so a sample-to-sample jump in
 * angular rate counts as well. That matters for a sensor in the handle, where
 * the acceleration transient is much weaker than on the string bed.
 *
 * Returns the onset of the largest jump, or null for shadow swings and misses.
 * The jump at sample i compares samples i − 1 and i, so the returned sample
 * already contains the impact; the ball arrived somewhere in the interval
 * before it. See `contactReference`.
 */
export function detectImpact(
  accel: readonly Vec3[],
  gyro: readonly Vec3[],
  peakIndex: number,
  halfWindow: number,
  thresholds: { readonly accelG: number; readonly gyroRadPerS: number },
): number | null {
  const from = Math.max(1, peakIndex - halfWindow);
  const to = Math.min(accel.length - 1, peakIndex + halfWindow);
  /** Jump at sample i as a multiple of the threshold; > 1 means "impact-like". */
  const jump = (i: number): number => {
    const a0 = accel[i - 1];
    const a1 = accel[i];
    const w0 = gyro[i - 1];
    const w1 = gyro[i];
    const a = a0 && a1 ? norm(sub(a1, a0)) / STANDARD_GRAVITY / thresholds.accelG : 0;
    const w = w0 && w1 ? norm(sub(w1, w0)) / thresholds.gyroRadPerS : 0;
    return Math.max(a, w);
  };
  let largest = 0;
  for (let i = from; i <= to; i++) largest = Math.max(largest, jump(i));
  if (largest <= 1) return null;
  // Onset: first sample of the impact transient, not its strongest ringing.
  const onsetLevel = Math.max(1, 0.5 * largest);
  for (let i = from; i <= to; i++) {
    if (jump(i) >= onsetLevel) return i;
  }
  return null;
}

/** Where in the capture contact kinematics and contact time are taken from. */
export interface ContactReference {
  /** Last sample not yet disturbed by the impact; kinematics are read here. */
  readonly sampleIndex: number;
  /**
   * Best estimate of the contact time as a fractional sample index. Timing
   * metrics are measured from here.
   */
  readonly time: number;
}

/**
 * Chooses the contact reference.
 *
 * With an impact at sample k, contact happened in (t[k−1], t[k]]: sample k
 * already shows the post-impact racket, whose rate has dropped to roughly
 * 80 % (Elliott et al. 1989, docs/research/racket-dynamics.md §1.2), and the
 * impact transient. Kinematics are therefore read from sample k − 1, the last
 * clean one, and the contact time is taken as the middle of the interval,
 * k − 0.5, which halves the worst-case timing error (±½ sample ≈ ±4.8 ms at
 * 104 Hz).
 *
 * Without an impact (shadow swing or miss) the peak of racket rate stands in
 * for contact.
 */
export function contactReference(impactIndex: number | null, peakIndex: number): ContactReference {
  if (impactIndex === null) return { sampleIndex: peakIndex, time: peakIndex };
  return { sampleIndex: Math.max(0, impactIndex - 1), time: impactIndex - 0.5 };
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

/**
 * Start of the preparation: the first sample after the last quiet period
 * (‖ω‖ below `quietRate` for at least `minQuietSamples`) before `before`.
 * Returns null when the capture holds no such period, i.e. the preparation
 * started before the recorded window.
 */
export function findPreparationStart(
  gyro: readonly Vec3[],
  before: number,
  quietRate: number,
  minQuietSamples: number,
): number | null {
  let run = 0;
  for (let i = Math.min(before, gyro.length - 1); i >= 0; i--) {
    const w = gyro[i];
    if (w && norm(w) < quietRate) {
      run++;
      if (run >= minQuietSamples) return i + run;
    } else {
      run = 0;
    }
  }
  return null;
}

/** Longest run of samples in `[from, to)` with ‖ω‖ below `quietRate`. */
export function longestQuietRun(
  gyro: readonly Vec3[],
  from: number,
  to: number,
  quietRate: number,
): number {
  let longest = 0;
  let run = 0;
  for (let i = from; i < to; i++) {
    const w = gyro[i];
    run = w && norm(w) < quietRate ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
