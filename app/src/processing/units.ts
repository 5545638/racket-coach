import type { ImuSeries, RawCapture } from '../domain/types';
import { type Vec3, DEG_TO_RAD } from '../math/vec3';
import { AXES_PER_SAMPLE } from '../protocol/constants';

/** Standard gravity, m/s². */
export const STANDARD_GRAVITY = 9.80665;

/**
 * LSM6DS3TR-C gyroscope sensitivity per full scale, mdps/LSB (datasheet,
 * Table 3 "Mechanical characteristics", G_So).
 */
export const GYRO_SENSITIVITY_MDPS_PER_LSB: Readonly<Record<number, number>> = {
  125: 4.375,
  250: 8.75,
  500: 17.5,
  1000: 35,
  2000: 70,
};

/**
 * LSM6DS3TR-C accelerometer sensitivity per full scale, mg/LSB (datasheet,
 * Table 3, LA_So).
 */
export const ACCEL_SENSITIVITY_MG_PER_LSB: Readonly<Record<number, number>> = {
  2: 0.061,
  4: 0.122,
  8: 0.244,
  16: 0.488,
};

/** Full scales the v1 firmware configures, and the defaults when a capture does not say. */
export const DEFAULT_GYRO_RANGE_DPS = 2000;
export const DEFAULT_ACCEL_RANGE_G = 16;

/**
 * Share of the nominal gyro full scale at which a sample counts as clipped.
 * Engineering choice (see `gyroSaturationCounts`).
 */
export const GYRO_SATURATION_FRACTION = 0.98;

/**
 * Gyro counts at or beyond which a sample is treated as clipped, for the
 * full scale `rangeDps`: nominal full-scale counts × 0.98.
 *
 * At every LSM6DS3TR-C range the nominal full scale is the same count,
 * range / sensitivity = 28571 (e.g. 2000 / 0.070, 125 / 0.004375), well short of
 * the int16 limit (32767 counts ≈ 2293 dps at ±2000 dps). Where the part
 * really stops responding between those two values is not specified, so a
 * threshold near the int16 limit could miss clipping anywhere between 2000
 * and ~2290 dps. 0.98 × 28571 = 28000 counts (1960 dps at ±2000 dps) sits
 * just below the nominal full scale: it may flag a few unclipped samples,
 * never miss a clipped one. Engineering choice; the real clip point must be
 * measured during bring-up (docs/bring-up.md) and this value adjusted.
 */
export function gyroSaturationCounts(rangeDps: number = DEFAULT_GYRO_RANGE_DPS): number {
  const sensitivity = GYRO_SENSITIVITY_MDPS_PER_LSB[rangeDps];
  if (sensitivity === undefined) throw new RangeError(`Unsupported gyro range ±${rangeDps} dps`);
  return Math.round(((rangeDps * 1000) / sensitivity) * GYRO_SATURATION_FRACTION);
}

/** Gyro clip threshold at the default ±2000 dps: 28000 counts (1960 dps). */
export const GYRO_SATURATION_COUNTS = gyroSaturationCounts(DEFAULT_GYRO_RANGE_DPS);

/**
 * Accelerometer counts at or beyond this magnitude are treated as clipped. At
 * every LSM6DS3TR-C range the nominal full scale fills the int16 range
 * (e.g. 16 / 0.000488 ≈ 32787 counts), so clipping shows up at the int16
 * limits whatever the range; 64 counts of margin is an engineering choice.
 */
export const ACCEL_SATURATION_COUNTS = 32767 - 64;

/** Scale factors actually used for a capture: from the ranges when present, else the header's per-LSB values. */
export function captureScales(capture: RawCapture): {
  readonly accelGPerLsb: number;
  readonly gyroDpsPerLsb: number;
  readonly gyroClipCounts: number;
} {
  let accelGPerLsb = capture.accelGPerLsb;
  if (capture.accelRangeG !== undefined) {
    const mg = ACCEL_SENSITIVITY_MG_PER_LSB[capture.accelRangeG];
    if (mg === undefined) throw new RangeError(`Unsupported accel range ±${capture.accelRangeG} g`);
    accelGPerLsb = mg / 1000;
  }
  let gyroDpsPerLsb = capture.gyroDpsPerLsb;
  if (capture.gyroRangeDps !== undefined) {
    const mdps = GYRO_SENSITIVITY_MDPS_PER_LSB[capture.gyroRangeDps];
    if (mdps === undefined)
      throw new RangeError(`Unsupported gyro range ±${capture.gyroRangeDps} dps`);
    gyroDpsPerLsb = mdps / 1000;
  }
  return {
    accelGPerLsb,
    gyroDpsPerLsb,
    gyroClipCounts: gyroSaturationCounts(capture.gyroRangeDps ?? DEFAULT_GYRO_RANGE_DPS),
  };
}

/**
 * Converts raw counts to SI units. The result stays in the sensor frame; gyro
 * bias correction belongs to the calibration step, not here. Timestamps and
 * the lost-sample count are passed through for the timebase step
 * (processing/timebase.ts), the per-axis clip level for clipping
 * reconstruction (processing/declip.ts).
 */
export function toImuSeries(capture: RawCapture): ImuSeries {
  const n = capture.samples.length / AXES_PER_SAMPLE;
  if (!Number.isInteger(n)) {
    throw new RangeError(`Sample buffer length ${capture.samples.length} is not a multiple of 6`);
  }
  if (capture.sampleTimesUs !== undefined && capture.sampleTimesUs.length !== n) {
    throw new RangeError(`${capture.sampleTimesUs.length} timestamps for ${n} samples`);
  }
  const scales = captureScales(capture);
  const aScale = scales.accelGPerLsb * STANDARD_GRAVITY;
  const gScale = scales.gyroDpsPerLsb * DEG_TO_RAD;
  const gyroClip = scales.gyroClipCounts;
  const s = capture.samples;

  const accel: Vec3[] = [];
  const gyro: Vec3[] = [];
  const accelSaturated: boolean[] = [];
  const gyroSaturated: boolean[] = [];

  for (let i = 0; i < n; i++) {
    const o = i * AXES_PER_SAMPLE;
    const ax = s[o] ?? 0;
    const ay = s[o + 1] ?? 0;
    const az = s[o + 2] ?? 0;
    const gx = s[o + 3] ?? 0;
    const gy = s[o + 4] ?? 0;
    const gz = s[o + 5] ?? 0;
    accel.push([ax * aScale, ay * aScale, az * aScale]);
    gyro.push([gx * gScale, gy * gScale, gz * gScale]);
    accelSaturated.push(anyClipped(ACCEL_SATURATION_COUNTS, ax, ay, az));
    gyroSaturated.push(anyClipped(gyroClip, gx, gy, gz));
  }

  return {
    sampleRateHz: capture.sampleRateHz,
    accel,
    gyro,
    accelSaturated,
    gyroSaturated,
    triggerIndex: capture.triggerIndex,
    gyroClipRadPerS: gyroClip * gScale,
    ...(capture.sampleTimesUs !== undefined
      ? { sampleTimesUs: Array.from(capture.sampleTimesUs) }
      : {}),
    ...(capture.sampleTimesWrapUs !== undefined
      ? { sampleTimesWrapUs: capture.sampleTimesWrapUs }
      : {}),
    ...(capture.droppedSamples !== undefined ? { droppedSamples: capture.droppedSamples } : {}),
  };
}

const anyClipped = (limit: number, ...counts: readonly number[]): boolean =>
  counts.some((c) => Math.abs(c) >= limit);
