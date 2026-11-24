import type { ImuSeries, RawCapture } from '../domain/types';
import { type Vec3, DEG_TO_RAD } from '../math/vec3';
import { AXES_PER_SAMPLE } from '../protocol/constants';

/** Standard gravity, m/s². */
export const STANDARD_GRAVITY = 9.80665;

/**
 * Accelerometer counts at or beyond this magnitude are treated as clipped. At
 * ±16 g the accelerometer's full scale fills the int16 range, so clipping
 * shows up just below the int16 limits.
 */
export const ACCEL_SATURATION_COUNTS = 32767 - 64;

/**
 * Gyro counts at or beyond this magnitude are treated as clipped.
 *
 * At ±2000 dps and 70 mdps/LSB the nominal full scale is 2000 / 0.070 ≈ 28571
 * counts, well short of the int16 limit (32767 counts ≈ 2293 dps). Where the
 * part really stops responding between those two values is not specified, so
 * a threshold near the int16 limit could miss clipping anywhere between 2000
 * and ~2290 dps. 28000 counts (1960 dps) sits just below the nominal full
 * scale: it may flag a few unclipped samples, never miss a clipped one.
 * Engineering choice; the real clip point must be measured during bring-up
 * (docs/bring-up.md) and this value adjusted.
 */
export const GYRO_SATURATION_COUNTS = 28000;

/**
 * Converts raw counts to SI units. The result stays in the sensor frame; gyro
 * bias correction belongs to the calibration step, not here.
 */
export function toImuSeries(capture: RawCapture): ImuSeries {
  const n = capture.samples.length / AXES_PER_SAMPLE;
  if (!Number.isInteger(n)) {
    throw new RangeError(`Sample buffer length ${capture.samples.length} is not a multiple of 6`);
  }
  const aScale = capture.accelGPerLsb * STANDARD_GRAVITY;
  const gScale = capture.gyroDpsPerLsb * DEG_TO_RAD;
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
    gyroSaturated.push(anyClipped(GYRO_SATURATION_COUNTS, gx, gy, gz));
  }

  return {
    sampleRateHz: capture.sampleRateHz,
    accel,
    gyro,
    accelSaturated,
    gyroSaturated,
    triggerIndex: capture.triggerIndex,
  };
}

const anyClipped = (limit: number, ...counts: readonly number[]): boolean =>
  counts.some((c) => Math.abs(c) >= limit);
