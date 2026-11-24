import type { ImuSeries, TimebaseQuality } from '../domain/types';
import type { Vec3 } from '../math/vec3';

/**
 * Timing of the sensor samples (signal path v2, docs/metrics.md).
 *
 * Protocol v2 may deliver per-sample IMU timestamps. From them this step
 * estimates the true sample rate, locates missing samples and the timing
 * jitter, unwraps the timer and resamples everything onto a uniform grid at
 * the nominal rate, so that every later step can keep assuming uniform
 * sampling. Without timestamps the capture is taken as uniform at its
 * nominal rate (the v1 behaviour).
 */
export interface TimebaseParams {
  /**
   * An interval longer than this multiple of the median interval holds
   * missing samples. Engineering choice: 1.5 sits halfway between one and
   * two intervals, so neither jitter nor a ±5 % rate error trips it.
   */
  readonly gapFactor: number;
  /**
   * Missing stretches up to this long are bridged by linear interpolation;
   * longer ones are marked as gaps and analysis withholds anything whose
   * window crosses them, s. Engineering choice: 10 ms bridges one lost sample
   * at 104 Hz, up to two at 208 Hz and four at 416 Hz.
   */
  readonly maxInterpolatedGapS: number;
  /**
   * The value of an interpolated sample is attributed to an input sample (its
   * saturation and reconstruction flags carry over) when that sample's
   * interpolation weight is at least this. Engineering choice.
   */
  readonly flagWeight: number;
}

export const DEFAULT_TIMEBASE_PARAMS: TimebaseParams = {
  gapFactor: 1.5,
  maxInterpolatedGapS: 0.01,
  flagWeight: 0.1,
};

/** Default timestamp wrap modulus: a uint32 counter of µs. */
export const DEFAULT_TIMESTAMP_WRAP_US = 2 ** 32;

/**
 * Timestamps relative to the first one, µs, with timer wrap removed: every
 * interval is taken modulo `wrapUs`, so a counter that wrapped (or a
 * firmware that reports the IMU's 24-bit counter in µs) still gives positive
 * intervals. Intervals must be shorter than one wrap period.
 */
export function unwrapTimes(
  times: readonly number[],
  wrapUs: number = DEFAULT_TIMESTAMP_WRAP_US,
): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < times.length; i++) {
    if (i > 0) {
      const d = ((((times[i] ?? 0) - (times[i - 1] ?? 0)) % wrapUs) + wrapUs) % wrapUs;
      t += d;
    }
    out.push(t);
  }
  return out;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? NaN) : 0.5 * ((s[m - 1] ?? 0) + (s[m] ?? 0));
};

/** A run of missing samples between input samples `after` and `after + 1`. */
export interface TimestampGap {
  readonly after: number;
  readonly missing: number;
  /** Time not covered by samples, µs (interval minus one regular period). */
  readonly durationUs: number;
}

export interface TimebaseEstimate {
  /** Regular sample interval, µs. */
  readonly periodUs: number;
  readonly measuredRateHz: number;
  /** RMS deviation of regular intervals from `periodUs`, µs. */
  readonly jitterUs: number;
  readonly gaps: readonly TimestampGap[];
}

/**
 * Sample interval, jitter and gaps from unwrapped timestamps.
 *
 * The regular interval is the median of all intervals (robust against gaps
 * and outliers); when more than half of them are gaps the median is not
 * representative and the nominal interval is used instead. The rate is then
 * refined over the whole capture: (t_last − t_first) / (intervals + missing).
 */
export function estimateTimebase(
  unwrappedUs: readonly number[],
  nominalRateHz: number,
  params: TimebaseParams = DEFAULT_TIMEBASE_PARAMS,
): TimebaseEstimate {
  const nominalUs = 1e6 / nominalRateHz;
  const diffs: number[] = [];
  for (let i = 1; i < unwrappedUs.length; i++) {
    diffs.push((unwrappedUs[i] ?? 0) - (unwrappedUs[i - 1] ?? 0));
  }
  if (diffs.length === 0) {
    return { periodUs: nominalUs, measuredRateHz: nominalRateHz, jitterUs: 0, gaps: [] };
  }
  let period = median(diffs);
  if (!(period > 0) || period > params.gapFactor * nominalUs) period = nominalUs;
  const gaps: TimestampGap[] = [];
  let sq = 0;
  let regular = 0;
  diffs.forEach((d, i) => {
    if (d > params.gapFactor * period) {
      const missing = Math.max(1, Math.round(d / period) - 1);
      gaps.push({ after: i, missing, durationUs: d - period });
    } else {
      sq += (d - period) ** 2;
      regular++;
    }
  });
  const totalIntervals = diffs.length + gaps.reduce((acc, g) => acc + g.missing, 0);
  const span = (unwrappedUs[unwrappedUs.length - 1] ?? 0) - (unwrappedUs[0] ?? 0);
  const refined = span / totalIntervals;
  // Use the refined value only when it agrees with the median (a mis-counted
  // gap would otherwise bias it).
  const periodUs = Math.abs(refined - period) < 0.02 * period ? refined : period;
  return {
    periodUs,
    measuredRateHz: 1e6 / periodUs,
    jitterUs: regular > 0 ? Math.sqrt(sq / regular) : 0,
    gaps,
  };
}

/** A series on a uniform grid at its nominal rate, with per-sample provenance. */
export interface UniformSeries {
  /** Uniform at `sampleRateHz`; carries no `sampleTimesUs`. */
  readonly series: ImuSeries;
  /** Synthesised by interpolation across a short gap. */
  readonly interpolated: readonly boolean[];
  /** Inside a long gap (or a capture with lost samples that cannot be located): no data. */
  readonly gap: readonly boolean[];
  /** Carries a reconstructed (de-clipped) gyro value. */
  readonly reconstructed: readonly boolean[];
  /** Carries a gyro axis that clipped and was not reconstructed. */
  readonly unrecovered: readonly boolean[];
  readonly quality: TimebaseQuality;
}

/** Series fields that describe the capture rather than individual samples. */
const passThrough = (
  series: ImuSeries,
): Pick<ImuSeries, 'temperatureC' | 'baseRateHz' | 'lostBeforeStart'> => ({
  ...(series.temperatureC !== undefined ? { temperatureC: series.temperatureC } : {}),
  ...(series.baseRateHz !== undefined ? { baseRateHz: series.baseRateHz } : {}),
  ...(series.lostBeforeStart ? { lostBeforeStart: true } : {}),
});

const lerp3 = (a: Vec3, b: Vec3, w: number): Vec3 => [
  a[0] + (b[0] - a[0]) * w,
  a[1] + (b[1] - a[1]) * w,
  a[2] + (b[2] - a[2]) * w,
];

/**
 * Puts a series onto a uniform grid at its nominal rate.
 *
 * - No timestamps: returned as is (uniform assumed). If the firmware reported
 *   lost samples, every sample is marked `gap`, because their positions are
 *   unknown and every integral and time difference may be off.
 * - Timestamps: grid t_k = t_0 + k / f_nominal over the capture. Accel and
 *   gyro are interpolated linearly between the two input samples that
 *   bracket t_k. Inside a short gap (≤ `maxInterpolatedGapS` missing) the
 *   output samples more than half an interval from both neighbours are
 *   flagged `interpolated`; inside a long gap they are flagged `gap` (the
 *   values are still filled linearly so arrays stay continuous, but must not
 *   be used). Saturation and reconstruction flags carry over from every input
 *   sample with weight ≥ `flagWeight`.
 *
 * A clock error (true rate ≠ nominal) is thereby corrected: times come from
 * the timestamps, not from the sample count.
 *
 * `barriersS` (s from the first sample) are times no interpolation may
 * straddle: the ball contact, a step in rate and acceleration. A grid point
 * between the two native samples around a barrier is extrapolated linearly
 * from the two samples on its own side.
 */
export function resampleUniform(
  series: ImuSeries,
  gyroFlags: {
    readonly reconstructed: readonly boolean[];
    readonly unrecovered: readonly boolean[];
  },
  params: TimebaseParams = DEFAULT_TIMEBASE_PARAMS,
  barriersS: readonly number[] = [],
): UniformSeries {
  const n = series.gyro.length;
  const fs = series.sampleRateHz;
  const dropped = series.droppedSamples ?? 0;
  const { reconstructed, unrecovered } = gyroFlags;
  const times = series.sampleTimesUs;
  if (times === undefined || n < 2) {
    const unlocated = dropped > 0;
    const base: ImuSeries = {
      sampleRateHz: fs,
      accel: series.accel,
      gyro: series.gyro,
      accelSaturated: series.accelSaturated,
      gyroSaturated: series.gyroSaturated,
      triggerIndex: series.triggerIndex,
      ...passThrough(series),
      ...(series.gyroMeasured ? { gyroMeasured: series.gyroMeasured } : {}),
      ...(series.accelMeasured ? { accelMeasured: series.accelMeasured } : {}),
    };
    const gap = new Array<boolean>(n).fill(unlocated);
    if (series.lostBeforeStart && n > 0) gap[0] = true;
    return {
      series: base,
      interpolated: new Array<boolean>(n).fill(false),
      gap,
      reconstructed: Array.from({ length: n }, (_, i) => reconstructed[i] ?? false),
      unrecovered: Array.from({ length: n }, (_, i) => unrecovered[i] ?? false),
      quality: {
        timestamped: false,
        measuredRateHz: fs,
        maxGapSamples: 0,
        jitterUs: 0,
        interpolatedSamples: 0,
        gapSamples: gap.filter(Boolean).length,
        droppedSamples: dropped,
      },
    };
  }

  const t = unwrapTimes(times, series.sampleTimesWrapUs);
  const barriersUs = barriersS.map((b) => b * 1e6);
  const est = estimateTimebase(t, fs, params);
  const stepUs = 1e6 / fs;
  const span = t[n - 1] ?? 0;
  // The last grid point may lie up to 5 % of an interval past the last sample
  // (timestamp quantisation); it then takes the last sample's value.
  const count = Math.floor(span / stepUs + 0.05) + 1;
  const longGap = (j: number): boolean => {
    const d = (t[j + 1] ?? 0) - (t[j] ?? 0);
    return (
      d > params.gapFactor * est.periodUs && d - est.periodUs > params.maxInterpolatedGapS * 1e6
    );
  };
  const shortGap = (j: number): boolean => {
    const d = (t[j + 1] ?? 0) - (t[j] ?? 0);
    return d > params.gapFactor * est.periodUs && !longGap(j);
  };

  const accel: Vec3[] = [];
  const gyro: Vec3[] = [];
  const accelSaturated: boolean[] = [];
  const gyroSaturated: boolean[] = [];
  const recon: boolean[] = [];
  const unrec: boolean[] = [];
  const interpolated: boolean[] = [];
  const gap: boolean[] = [];
  const gyroMeasured: boolean[] = [];
  const accelMeasured: boolean[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const tk = k * stepUs;
    while (j < n - 2 && (t[j + 1] ?? 0) <= tk) j++;
    const t0 = t[j] ?? 0;
    const t1 = t[j + 1] ?? t0;
    let w = t1 > t0 ? Math.max(0, Math.min(1, (tk - t0) / (t1 - t0))) : 0;
    // Never interpolate across a barrier (ball contact): extrapolate from the
    // pair of samples on the grid point's own side instead, so no grid sample
    // mixes the racket before and after the impact.
    const barrier = barriersUs.find((b) => b > t0 && b <= t1);
    let lo = j;
    if (barrier !== undefined && j > 0 && tk < barrier) {
      lo = j - 1;
    } else if (barrier !== undefined && j + 2 < n && tk >= barrier) {
      lo = j + 1;
    }
    if (lo !== j) {
      const s0 = t[lo] ?? 0;
      const s1 = t[lo + 1] ?? s0;
      w = s1 > s0 ? (tk - s0) / (s1 - s0) : 0;
    }
    const a0 = series.accel[lo] ?? [0, 0, 0];
    const a1 = series.accel[lo + 1] ?? a0;
    const g0 = series.gyro[lo] ?? [0, 0, 0];
    const g1 = series.gyro[lo + 1] ?? g0;
    accel.push(lerp3(a0, a1, w));
    gyro.push(lerp3(g0, g1, w));
    const from0 = 1 - w >= params.flagWeight;
    const from1 = w >= params.flagWeight;
    const flag = (f: readonly boolean[]): boolean =>
      (from0 && (f[lo] ?? false)) || (from1 && (f[lo + 1] ?? false));
    accelSaturated.push(flag(series.accelSaturated));
    gyroSaturated.push(flag(series.gyroSaturated));
    recon.push(flag(reconstructed));
    unrec.push(flag(unrecovered));
    // Measured only when every input sample that contributes was measured.
    const measured = (f: readonly boolean[] | undefined): boolean =>
      (!from0 || (f?.[lo] ?? true)) && (!from1 || (f?.[lo + 1] ?? true));
    gyroMeasured.push(measured(series.gyroMeasured));
    accelMeasured.push(measured(series.accelMeasured));
    const inside = tk - t0 > 0.5 * est.periodUs && t1 - tk > 0.5 * est.periodUs;
    interpolated.push(inside && shortGap(j));
    gap.push(inside && longGap(j));
  }
  // Losses the firmware counted but the timestamps do not show (v2 frame
  // times are derived from one period, so a FIFO reset inside the window is
  // invisible in them) cannot be located: every sample is suspect.
  const located = est.gaps.reduce((acc, g) => acc + g.missing, 0);
  if (dropped > located) gap.fill(true);
  if (series.lostBeforeStart && gap.length > 0) gap[0] = true;
  const triggerUs = t[Math.max(0, Math.min(n - 1, series.triggerIndex))] ?? 0;
  return {
    series: {
      sampleRateHz: fs,
      accel,
      gyro,
      accelSaturated,
      gyroSaturated,
      triggerIndex: Math.max(0, Math.min(count - 1, Math.round(triggerUs / stepUs))),
      ...passThrough(series),
      ...(series.gyroMeasured ? { gyroMeasured } : {}),
      ...(series.accelMeasured ? { accelMeasured } : {}),
    },
    interpolated,
    gap,
    reconstructed: recon,
    unrecovered: unrec,
    quality: {
      timestamped: true,
      measuredRateHz: est.measuredRateHz,
      maxGapSamples: est.gaps.reduce((acc, g) => Math.max(acc, g.missing), 0),
      jitterUs: est.jitterUs,
      interpolatedSamples: interpolated.filter(Boolean).length,
      gapSamples: gap.filter(Boolean).length,
      droppedSamples: dropped,
    },
  };
}
