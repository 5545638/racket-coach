import type { ImuSeries, RawCapture } from '../domain/types';
import { type Vec3, DEG_TO_RAD } from '../math/vec3';
import { AXES_PER_SAMPLE } from '../protocol/constants';

/** Standard gravity, m/s². */
export const STANDARD_GRAVITY = 9.80665;

/** A raw count this close to the int16 limits is treated as clipped. */
const SATURATION_COUNTS = 32767 - 64;

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
    accelSaturated.push(isClipped(ax) || isClipped(ay) || isClipped(az));
    gyroSaturated.push(isClipped(gx) || isClipped(gy) || isClipped(gz));
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

const isClipped = (count: number): boolean => Math.abs(count) >= SATURATION_COUNTS;
