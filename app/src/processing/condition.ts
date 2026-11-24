import type { ImuSeries, TimebaseQuality } from '../domain/types';
import type { Vec3 } from '../math/vec3';
import { type ClippedRun, type DeclipParams, DEFAULT_DECLIP_PARAMS, declipGyro } from './declip';
import {
  type TimebaseParams,
  DEFAULT_TIMEBASE_PARAMS,
  resampleUniform,
  unwrapTimes,
} from './timebase';

/**
 * A series ready for analysis: uniform at its nominal rate, gyro clipping
 * reconstructed where possible, with per-sample provenance flags.
 * `gyroSaturated` still marks every sample that clipped at the sensor,
 * reconstructed or not.
 */
export interface ConditionedSeries extends ImuSeries {
  /** Gyro value reconstructed by `declipGyro` (still also flagged saturated). */
  readonly gyroReconstructed: readonly boolean[];
  /** The gyro as clipped, before reconstruction (same grid); equals `gyro` where nothing was reconstructed. */
  readonly gyroClipped: readonly Vec3[];
  /** A gyro axis clipped here and was not reconstructed: the rate is a lower bound. */
  readonly gyroUnrecovered: readonly boolean[];
  /** Synthesised by interpolation across a short gap. */
  readonly interpolated: readonly boolean[];
  /** No data here (long gap or unlocated sample loss): windows crossing it are withheld. */
  readonly gap: readonly boolean[];
  readonly timebase: TimebaseQuality;
  /** Every clipped gyro run, reconstructed or refused. */
  readonly clippedRuns: readonly ClippedRun[];
}

/** True when `series` was already conditioned (idempotence of `conditionSeries`). */
/** Sample times of a series, s from its first sample (timestamps when present). */
export function sampleTimesS(series: ImuSeries): number[] {
  return series.sampleTimesUs !== undefined
    ? unwrapTimes(series.sampleTimesUs, series.sampleTimesWrapUs).map((t) => t / 1e6)
    : Array.from({ length: series.gyro.length }, (_, i) => i / series.sampleRateHz);
}

export const isConditioned = (series: ImuSeries): series is ConditionedSeries =>
  'gap' in series && 'timebase' in series;

export interface ConditionOptions {
  readonly declip?: DeclipParams;
  readonly timebase?: TimebaseParams;
  /** False: skip gyro reconstruction (clipped values stay as measured). Default true. */
  readonly reconstruct?: boolean;
  /**
   * Times (s from the first sample) that neither a reconstruction nor a
   * resampling interpolation may straddle: the detected ball contact.
   */
  readonly barriersS?: readonly number[];
}

/**
 * Signal path v2 between unit conversion and analysis: gyro de-clipping on
 * the native samples (their true times), then resampling onto the uniform
 * nominal grid. A v1 series without timestamps or clip level comes out
 * unchanged, with all flags false.
 */
export function conditionSeries(
  series: ImuSeries,
  options: ConditionOptions = {},
): ConditionedSeries {
  if (isConditioned(series)) return series;
  const declipParams = options.declip ?? DEFAULT_DECLIP_PARAMS;
  const timebaseParams = options.timebase ?? DEFAULT_TIMEBASE_PARAMS;
  const n = series.gyro.length;
  const timesS = sampleTimesS(series);
  const declipped =
    series.gyroClipRadPerS !== undefined && options.reconstruct !== false
      ? declipGyro(
          series.gyro,
          timesS,
          series.gyroClipRadPerS,
          declipParams,
          options.barriersS ?? [],
        )
      : {
          gyro: series.gyro,
          reconstructed: new Array<boolean>(n).fill(false),
          unrecovered:
            series.gyroClipRadPerS !== undefined
              ? series.gyro.map((w) =>
                  w.some((v) => Math.abs(v) >= (series.gyroClipRadPerS ?? Infinity)),
                )
              : series.gyroSaturated,
          runs: [],
        };
  const barriers = options.barriersS ?? [];
  // Possibly clipped samples whose values do not show it (v2 flags): clipped
  // and not reconstructable.
  const suspect = series.gyroSuspect;
  const flags = suspect
    ? {
        reconstructed: declipped.reconstructed,
        unrecovered: declipped.unrecovered.map((u, i) => u || (suspect[i] ?? false)),
      }
    : declipped;
  const input: ImuSeries = suspect
    ? { ...series, gyroSaturated: series.gyroSaturated.map((s, i) => s || (suspect[i] ?? false)) }
    : series;
  const uniform = resampleUniform(
    { ...input, gyro: declipped.gyro },
    flags,
    timebaseParams,
    barriers,
  );
  const gyroClipped = declipped.reconstructed.some(Boolean)
    ? resampleUniform(input, flags, timebaseParams, barriers).series.gyro
    : uniform.series.gyro;
  return {
    ...uniform.series,
    gyroReconstructed: uniform.reconstructed,
    gyroUnrecovered: uniform.unrecovered,
    gyroClipped,
    interpolated: uniform.interpolated,
    gap: uniform.gap,
    timebase: uniform.quality,
    clippedRuns: declipped.runs,
  };
}
