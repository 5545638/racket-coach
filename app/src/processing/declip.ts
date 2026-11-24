import type { Vec3 } from '../math/vec3';

/**
 * Gyro clipping reconstruction (signal path v2, docs/metrics.md).
 *
 * A gyro axis that exceeds the full scale reads a flat plateau. Near the peak
 * of a swing the true rate is smooth, so a short plateau can be bridged by a
 * curve fitted through the unclipped samples on both sides of it. The curve
 * is a parabola in ln|ω| (a Gaussian peak, which it reproduces exactly):
 * unlike a parabola in ω it stays positive and does not run away when the
 * support is short. The reconstruction is refused when
 * - the run is longer than `maxRunS` (the extrapolated peak would be a guess),
 * - fewer than `minSupportSamples` unclipped, evenly spaced samples exist on
 *   either side,
 * - the fit is not a maximum inside the plateau, exceeds `maxPeakFactor` ×
 *   the clip level, leaves a residual above `maxResidualLog`, or falls below
 *   the clip level anywhere inside the plateau (e.g. the ball impact steps
 *   the rate down inside the support).
 *
 * Accelerometer clipping is never reconstructed: the impact transient and
 * the frame vibration are not smooth, so no curve through the neighbours
 * says anything about the clipped values.
 */
export interface DeclipParams {
  /** Longest clipped run that is reconstructed, s (run length = samples × interval). Engineering choice. */
  readonly maxRunS: number;
  /** Support on each side, s (rounded to samples, at least `minSupportSamples`). Engineering choice. */
  readonly supportS: number;
  /** Fewest unclipped samples needed on each side. Engineering choice. */
  readonly minSupportSamples: number;
  /** Reconstructed peaks above this multiple of the clip level are refused. Engineering choice. */
  readonly maxPeakFactor: number;
  /** Largest RMS residual of the fit, in ln(rate) (≈ relative error). Engineering choice. */
  readonly maxResidualLog: number;
  /** Intervals longer than this multiple of the median interval break the support (missing samples). */
  readonly gapFactor: number;
  /**
   * Degree of the polynomial in ln|ω| when ≥ 3 support samples exist on each
   * side: 3 (cubic) follows the asymmetric peak of a swing (faster rise than
   * fall); 2 is a Gaussian. Engineering choice.
   */
  readonly maxDegree: number;
}

export const DEFAULT_DECLIP_PARAMS: DeclipParams = {
  maxRunS: 0.1,
  supportS: 0.03,
  minSupportSamples: 2,
  maxPeakFactor: 1.6,
  maxResidualLog: 0.03,
  gapFactor: 1.5,
  maxDegree: 3,
};

export type DeclipRefusal =
  | 'too-long'
  | 'no-support'
  | 'not-a-peak'
  | 'peak-too-high'
  | 'poor-fit'
  /** A barrier (detected ball contact) lies inside the plateau: before and after are different curves. */
  | 'impact';

/** One clipped run on one gyro axis. */
export interface ClippedRun {
  readonly axis: 0 | 1 | 2;
  /** Inclusive sample range of the plateau. */
  readonly start: number;
  readonly end: number;
  /** Plateau length, s. */
  readonly durationS: number;
  /** Reconstructed peak |ω| on that axis, rad/s; null when refused. */
  readonly peakRadPerS: number | null;
  readonly refused: DeclipRefusal | null;
}

export interface DeclipResult {
  /** Gyro with every accepted run replaced by its reconstruction (sensor frame). */
  readonly gyro: readonly Vec3[];
  /** True where any axis carries a reconstructed value. */
  readonly reconstructed: readonly boolean[];
  /** True where any axis clipped and was not reconstructed (the value is a lower bound). */
  readonly unrecovered: readonly boolean[];
  readonly runs: readonly ClippedRun[];
}

/**
 * Least-squares polynomial y = Σ c_k x^k, k = 0…degree (x centred by the
 * caller), via the normal equations and Gaussian elimination with partial
 * pivoting. Null when the system is singular.
 */
export function fitPolynomial(
  xs: readonly number[],
  ys: readonly number[],
  degree: number,
): number[] | null {
  const m = degree + 1;
  const a: number[][] = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0));
  xs.forEach((x, k) => {
    const basis = Array.from({ length: m }, (_, p) => x ** p);
    const y = ys[k] ?? 0;
    for (let r = 0; r < m; r++) {
      const row = a[r] ?? [];
      for (let c = 0; c < m; c++) row[c] = (row[c] ?? 0) + (basis[r] ?? 0) * (basis[c] ?? 0);
      row[m] = (row[m] ?? 0) + (basis[r] ?? 0) * y;
    }
  });
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(a[r]?.[col] ?? 0) > Math.abs(a[pivot]?.[col] ?? 0)) pivot = r;
    }
    const tmp = a[col] ?? [];
    a[col] = a[pivot] ?? [];
    a[pivot] = tmp;
    const p = a[col]?.[col] ?? 0;
    if (Math.abs(p) < 1e-300) return null;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = (a[r]?.[col] ?? 0) / p;
      const row = a[r] ?? [];
      for (let c = col; c <= m; c++) row[c] = (row[c] ?? 0) - f * (a[col]?.[c] ?? 0);
    }
  }
  return Array.from({ length: m }, (_, r) => (a[r]?.[m] ?? 0) / (a[r]?.[r] ?? 1));
}

const evaluate = (c: readonly number[], x: number): number =>
  c.reduceRight((acc, ck) => acc * x + ck, 0);

/**
 * Reconstructs short clipped gyro runs, axis by axis.
 *
 * @param gyro sensor-frame angular rate, rad/s
 * @param timesS sample times, s (uniform or from timestamps)
 * @param clipRadPerS per-axis clip level: |ω_axis| ≥ it is clipped
 * @param barriersS times (s, same origin as `timesS`) that neither a plateau
 *   nor its support may straddle: the detected ball contact, where the rate
 *   steps down and the curve before it says nothing about the curve after it
 */
export function declipGyro(
  gyro: readonly Vec3[],
  timesS: readonly number[],
  clipRadPerS: number,
  params: DeclipParams = DEFAULT_DECLIP_PARAMS,
  barriersS: readonly number[] = [],
): DeclipResult {
  const n = gyro.length;
  const out: [number, number, number][] = gyro.map((w) => [w[0], w[1], w[2]]);
  const reconstructed = new Array<boolean>(n).fill(false);
  const unrecovered = new Array<boolean>(n).fill(false);
  const runs: ClippedRun[] = [];
  const clippedAnywhere = (i: number): boolean =>
    (gyro[i] ?? [0, 0, 0]).some((v) => Math.abs(v) >= clipRadPerS);
  if (n < 3 || !(clipRadPerS > 0)) {
    for (let i = 0; i < n; i++) unrecovered[i] = clipRadPerS > 0 && clippedAnywhere(i);
    return { gyro: out, reconstructed, unrecovered, runs };
  }

  const intervals: number[] = [];
  for (let i = 1; i < n; i++) intervals.push((timesS[i] ?? 0) - (timesS[i - 1] ?? 0));
  const sorted = [...intervals].sort((a, b) => a - b);
  const period = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (!(period > 0)) {
    for (let i = 0; i < n; i++) unrecovered[i] = clippedAnywhere(i);
    return { gyro: out, reconstructed, unrecovered, runs };
  }
  const regular = (i: number): boolean => (intervals[i] ?? Infinity) <= params.gapFactor * period;
  const support = Math.max(params.minSupportSamples, Math.round(params.supportS / period));

  for (const axis of [0, 1, 2] as const) {
    const value = (i: number): number => gyro[i]?.[axis] ?? 0;
    const clipped = (i: number): boolean => Math.abs(value(i)) >= clipRadPerS;
    let i = 0;
    while (i < n) {
      if (!clipped(i)) {
        i++;
        continue;
      }
      const sign = Math.sign(value(i));
      let end = i;
      while (end + 1 < n && clipped(end + 1) && Math.sign(value(end + 1)) === sign) end++;
      const start = i;
      i = end + 1;
      const durationS = (end - start + 1) * period;
      const refuse = (refused: DeclipRefusal): void => {
        runs.push({ axis, start, end, durationS, peakRadPerS: null, refused });
        for (let k = start; k <= end; k++) unrecovered[k] = true;
      };
      if (durationS > params.maxRunS + 1e-9) {
        refuse('too-long');
        continue;
      }
      /** True when a barrier lies in (t_a, t_b]. */
      const barrierBetween = (a: number, b: number): boolean =>
        barriersS.some((x) => x > (timesS[a] ?? 0) && x <= (timesS[b] ?? 0));
      if (barrierBetween(start, end)) {
        refuse('impact');
        continue;
      }
      // Gather contiguous, unclipped support on each side (no missing samples in between).
      const left: number[] = [];
      for (let k = start - 1; k >= 0 && left.length < support; k--) {
        if (clipped(k) || !regular(k) || Math.sign(value(k)) !== sign) break;
        if (barrierBetween(k, start)) break;
        left.push(k);
      }
      const right: number[] = [];
      for (let k = end + 1; k < n && right.length < support; k++) {
        if (clipped(k) || !regular(k - 1) || Math.sign(value(k)) !== sign) break;
        if (barrierBetween(end, k)) break;
        right.push(k);
      }
      let runRegular = true;
      for (let k = start; k < end; k++) runRegular &&= regular(k);
      if (
        left.length < params.minSupportSamples ||
        right.length < params.minSupportSamples ||
        !runRegular
      ) {
        refuse('no-support');
        continue;
      }
      left.reverse();
      const tMid = 0.5 * ((timesS[start] ?? 0) + (timesS[end] ?? 0));
      // Fit with the full support first; if that fails, retry with fewer
      // samples per side (the nearest ones), down to the minimum: a step at
      // the far end of the support (e.g. the impact) then drops out.
      /** One fit attempt over the support samples `idx`; a refusal reason on failure. */
      const fitRun = (
        idx: readonly number[],
        degree: number,
      ): { fit: (x: number) => number; peak: number } | DeclipRefusal => {
        const xs = idx.map((k) => (timesS[k] ?? 0) - tMid);
        const ys = idx.map((k) => Math.log(Math.abs(value(k))));
        const c = fitPolynomial(xs, ys, degree);
        if (!c) return 'not-a-peak';
        const fit = (x: number): number => evaluate(c, x);
        const lo = (timesS[start - 1] ?? 0) - tMid;
        const hi = (timesS[end + 1] ?? 0) - tMid;
        // Peak: the maximum of the fit over the blind interval, on a fine
        // grid; it must lie strictly inside (a maximum at the edge is not a peak).
        const steps = 200;
        let xPeak = lo;
        for (let k = 1; k <= steps; k++) {
          const x = lo + ((hi - lo) * k) / steps;
          if (fit(x) > fit(xPeak)) xPeak = x;
        }
        if (xPeak <= lo || xPeak >= hi || !(fit(xPeak) > Math.log(clipRadPerS))) {
          return 'not-a-peak';
        }
        const residual = Math.sqrt(
          xs.reduce((acc, x, k) => acc + (fit(x) - (ys[k] ?? 0)) ** 2, 0) / xs.length,
        );
        if (residual > params.maxResidualLog) return 'poor-fit';
        // Every clipped sample is truly at or above the clip level: a fit that
        // dips below it inside the run contradicts the data (e.g. the support
        // straddles a ball impact).
        for (let k = start; k <= end; k++) {
          if (fit((timesS[k] ?? 0) - tMid) < Math.log(clipRadPerS) - params.maxResidualLog) {
            return 'poor-fit';
          }
        }
        const peak = Math.exp(fit(xPeak));
        if (peak > params.maxPeakFactor * clipRadPerS) return 'peak-too-high';
        return { fit, peak };
      };
      let accepted: { fit: (x: number) => number; peak: number } | null = null;
      let reason: DeclipRefusal = 'poor-fit';
      for (let m = Math.min(left.length, right.length); m >= params.minSupportSamples; m--) {
        const outcome = fitRun(
          [...left.slice(left.length - m), ...right.slice(0, m)],
          m >= 3 ? params.maxDegree : 2,
        );
        if (typeof outcome === 'string') {
          reason = outcome;
          continue;
        }
        accepted = outcome;
        break;
      }
      if (!accepted) {
        refuse(reason);
        continue;
      }
      const { fit, peak } = accepted;
      for (let k = start; k <= end; k++) {
        const v = Math.max(clipRadPerS, Math.exp(fit((timesS[k] ?? 0) - tMid)));
        const w = out[k];
        if (w) w[axis] = sign * v;
        reconstructed[k] = true;
      }
      runs.push({ axis, start, end, durationS, peakRadPerS: peak, refused: null });
    }
  }
  return { gyro: out, reconstructed, unrecovered, runs };
}
