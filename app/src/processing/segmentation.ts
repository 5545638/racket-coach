import { type Vec3, norm, sub } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

/**
 * Reference interval of the per-interval thresholds, s: one sample at 104 Hz,
 * the v1 rate for which they were chosen. At other rates jumps are measured
 * over the same time (round(f_s / 104) samples), so the smooth part of the
 * swing contributes the same change per jump whatever the rate.
 */
export const REFERENCE_INTERVAL_S = 1 / 104;

/** Samples spanning `seconds` at `sampleRateHz`, at least 1. */
export const samplesFor = (seconds: number, sampleRateHz: number): number =>
  Math.max(1, Math.round(seconds * sampleRateHz));

export interface ImpactThresholds {
  /** Change in specific force over one reference interval that counts as impact-like, g. */
  readonly accelG: number;
  /** Change in angular rate over one reference interval that counts as impact-like, rad/s. */
  readonly gyroRadPerS: number;
  /** Jump span, samples (default 1: the v1 behaviour at 104 Hz). */
  readonly spanSamples?: number;
  /**
   * When both channels are usable, the other one must show at least this
   * fraction of its own threshold for a candidate to count (default 0: no
   * consistency check).
   */
  readonly confirmFraction?: number;
  /**
   * Candidates within this many samples before the strongest jump belong to
   * the same impact; the onset is searched only there (default: the whole window).
   */
  readonly refractorySamples?: number;
  /**
   * Measure the gyro jump against the preceding trend (second difference:
   * Δω(i) − Δω(i − span)) instead of as a plain difference. A ball impact is
   * a step in rate, which both see in full, while the steep but smooth rise
   * and fall of a fast swing cancel in the second difference. Default false
   * (v1 behaviour).
   */
  readonly detrendGyro?: boolean;
}

/** Per-sample flags that make a channel unusable for impact detection. */
export interface ImpactFlags {
  /** Accelerometer clipped: its jumps are lower bounds, distorted by the part's overload recovery. */
  readonly accelSaturated?: readonly boolean[];
  /**
   * Gyro clipped and not reconstructed. Without `detrendGyro` such samples
   * cannot confirm; with it, only a drop in ‖ω‖ counts there.
   */
  readonly gyroUnreliable?: readonly boolean[];
  /** No data (long gap): no jump involving it is evaluated. */
  readonly gap?: readonly boolean[];
}

/**
 * Detects ball contact near the peak of the swing.
 *
 * Contact is a near-step of tens of g in specific force, but a very fast swing
 * also changes its centripetal acceleration by several g per sample while it
 * speeds up. Searching only within `halfWindow` samples of peak racket rate
 * (where centripetal acceleration is momentarily constant) separates the two.
 *
 * The impact also jolts the racket's rotation, so a jump in angular rate
 * counts as well. That matters for a sensor in the handle, where the
 * acceleration transient is much weaker than on the string bed.
 *
 * Signal path v2 (all optional, defaults give the v1 behaviour):
 * - jumps are taken over `spanSamples` (one reference interval of 1/104 s),
 *   so the thresholds mean the same at 104, 208 and 416 Hz;
 * - with `detrendGyro` the gyro jump is measured against the preceding trend
 *   (second difference), so the steep flanks of a fast swing do not look
 *   like a step;
 * - accelerometer jumps that involve a clipped sample are not trusted on
 *   their own: they count only when the gyro confirms them, and they never
 *   confirm a gyro candidate. Where the gyro is clipped (not reconstructed)
 *   only a drop in ‖ω‖ counts as gyro evidence: clipping can only understate
 *   a drop, never invent one;
 * - consistency: an accelerometer-led candidate must be confirmed by a gyro
 *   jump of at least `confirmFraction` of its threshold (the ball always
 *   takes rate away or jolts the racket), a gyro-led one by an accelerometer
 *   jump likewise, each when that channel is usable. Frame vibration (accel
 *   only) and ground bounces without a rate change are thereby rejected;
 * - refractory window: the onset is searched only within `refractorySamples`
 *   before the strongest jump, so an earlier unrelated transient cannot be
 *   taken as its onset.
 *
 * Returns the onset of the strongest jump, or null for shadow swings and
 * misses. The jump at sample i compares samples i − span and i, so the
 * returned sample already contains the impact; the ball arrived somewhere in
 * the interval before it. See `contactReference`.
 */
export function detectImpact(
  accel: readonly Vec3[],
  gyro: readonly Vec3[],
  peakIndex: number,
  halfWindow: number,
  thresholds: ImpactThresholds,
  flags: ImpactFlags = {},
): number | null {
  const span = Math.max(1, thresholds.spanSamples ?? 1);
  const confirm = thresholds.confirmFraction ?? 0;
  const from = Math.max(span, peakIndex - halfWindow);
  const to = Math.min(accel.length - 1, peakIndex + halfWindow);
  const usable = (f: readonly boolean[] | undefined, i: number): boolean =>
    !(f?.[i] ?? false) && !(f?.[i - span] ?? false);
  /**
   * Jumps at i as multiples of their thresholds: `a` from an unclipped
   * accelerometer (null when clipped or missing), `aClipped` the same jump
   * when a clipped sample is involved, `w` the gyro (null when missing).
   */
  const parts = (
    i: number,
  ): { readonly a: number | null; readonly aClipped: number | null; readonly w: number | null } => {
    if (!usable(flags.gap, i)) return { a: null, aClipped: null, w: null };
    const a0 = accel[i - span];
    const a1 = accel[i];
    const w0 = gyro[i - span];
    const w1 = gyro[i];
    const aj = a0 && a1 ? norm(sub(a1, a0)) / STANDARD_GRAVITY / thresholds.accelG : null;
    const clipped = !usable(flags.accelSaturated, i);
    let w: number | null = null;
    if (w0 && w1) {
      const wPrev = gyro[i - 2 * span];
      const clippedGyro =
        !usable(flags.gyroUnreliable, i) || (flags.gyroUnreliable?.[i - 2 * span] ?? false);
      if (!thresholds.detrendGyro) {
        w = norm(sub(w1, w0));
      } else if (clippedGyro) {
        // A clipped sample understates the rate, so only a drop in rate is
        // evidence (and then a lower bound of the true drop); a trend
        // through clipped samples would be meaningless.
        w = Math.max(0, norm(w0) - norm(w1));
      } else if (wPrev && !(flags.gap?.[i - 2 * span] ?? false)) {
        w = norm(sub(sub(w1, w0), sub(w0, wPrev)));
      } else {
        w = norm(sub(w1, w0));
      }
      w /= thresholds.gyroRadPerS;
    }
    return { a: clipped ? null : aj, aClipped: clipped ? aj : null, w };
  };
  const gyroUsable = (i: number): boolean =>
    thresholds.detrendGyro === true || usable(flags.gyroUnreliable, i);
  /** Largest usable jump of one channel in the neighbourhood of i, for confirmation. */
  const near = (i: number, pick: 'a' | 'w'): number | null => {
    let best: number | null = null;
    for (let k = i - 1; k <= i + span; k++) {
      if (k < span || k >= accel.length) continue;
      if (pick === 'w' && !gyroUsable(k)) continue;
      const v = parts(k)[pick];
      if (v !== null) best = Math.max(best ?? 0, v);
    }
    return best;
  };
  /** Jump at sample i as a multiple of the threshold; > 1 means "impact-like". */
  const jump = (i: number): number => {
    const { a, aClipped, w } = parts(i);
    const wj = w ?? 0;
    if (confirm <= 0) return Math.max(a ?? aClipped ?? 0, wj);
    // A jump involving a clipped accelerometer sample is not trusted on its
    // own (overload recovery of the part is unspecified): it counts only
    // when the gyro confirms it, and it never confirms a gyro candidate.
    const gyroAgrees = (): boolean => {
      const other = near(i, 'w');
      return other !== null && other >= confirm;
    };
    const clippedLead = aClipped !== null && aClipped > 1 && gyroAgrees() ? aClipped : 0;
    const aj = Math.max(a ?? 0, clippedLead);
    const score = Math.max(aj, wj);
    if (score <= 1) return score;
    if (aj > 1 && wj > 1) return score;
    if (aj > 1) {
      if (clippedLead > 0) return score;
      // Accel-led: the gyro must agree when it is usable here.
      if (!gyroUsable(i)) return score;
      return gyroAgrees() ? score : 0;
    }
    // Gyro-led: an unclipped accelerometer must agree; a clipped one cannot say.
    if (a === null) return score;
    const other = near(i, 'a');
    return other === null || other >= confirm ? score : 0;
  };
  let largest = 0;
  let strongest = -1;
  for (let i = from; i <= to; i++) {
    const j = jump(i);
    if (j > largest) {
      largest = j;
      strongest = i;
    }
  }
  if (largest <= 1) return null;
  // Onset: first sample of the impact transient, not its strongest ringing.
  const onsetLevel = Math.max(1, 0.5 * largest);
  const onsetFrom =
    thresholds.refractorySamples === undefined
      ? from
      : Math.max(from, strongest - thresholds.refractorySamples);
  for (let i = onsetFrom; i <= strongest; i++) {
    if (jump(i) >= onsetLevel) return i;
  }
  return strongest;
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
