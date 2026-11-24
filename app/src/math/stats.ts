/**
 * Error function, Abramowitz & Stegun 7.1.26 (absolute error ≤ 1.5 · 10⁻⁷).
 * Odd: erf(−x) = −erf(x).
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

/** Standard normal cumulative distribution Φ(z) = ½ (1 + erf(z / √2)). */
export const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/** Median of `values`; NaN for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] ?? NaN;
  return sorted.length % 2 === 1 ? upper : 0.5 * ((sorted[mid - 1] ?? NaN) + upper);
}

/** Median absolute deviation about `centre` (the median by default). */
export function medianAbsoluteDeviation(
  values: readonly number[],
  centre: number = median(values),
): number {
  return median(values.map((v) => Math.abs(v - centre)));
}

/** MAD → σ for normally distributed data. */
export const MAD_TO_SIGMA = 1.4826;
