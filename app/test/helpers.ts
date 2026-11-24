import { expect } from 'vitest';
import type { ImuSeries, MountCalibration } from '../src/domain/types';
import { type Mat3, mulVec, transpose } from '../src/math/mat3';
import { conjugate, fromAxisAngle, rotate } from '../src/math/quat';
import { type Vec3, UNIT_Z, add, norm, scale, sub } from '../src/math/vec3';
import { attitudeFromGravity, attitudeSeries } from '../src/processing/attitude';
import { type SimulationSetup } from '../src/simulation/swingModel';

/** Rotation matrix for `angleRad` about `axis`. */
export function rotationMatrix(axis: Vec3, angleRad: number): Mat3 {
  const q = fromAxisAngle(axis, angleRad);
  // Columns are the rotated basis vectors; transpose of the row form.
  return transpose([rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])]);
}

/** A deliberately awkward mounting: the sensor is not aligned with the racket. */
export const SKEWED_MOUNT: MountCalibration = {
  version: 1,
  racketFromSensor: rotationMatrix([0.3, -0.5, 0.8], 2.1),
  gyroBias: [0.01, -0.02, 0.015],
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const SETUP: SimulationSetup = {
  sampleRateHz: 104,
  durationS: 1.6,
  contactTimeS: 0.9,
  mount: SKEWED_MOUNT,
  triggerRadPerS: (300 * Math.PI) / 180,
};

/** Asserts `actual` is a number within `tolerance` of `expected`. */
export function expectNear(actual: number | null, expected: number, tolerance: number): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThan(tolerance);
}

/** Gyro and accelerometer of a capture in the racket frame, gyro bias removed. */
export function racketFrame(
  series: ImuSeries,
  mount: MountCalibration = SKEWED_MOUNT,
): { readonly gyro: Vec3[]; readonly accel: Vec3[] } {
  const R = mount.racketFromSensor;
  return {
    gyro: series.gyro.map((w) => mulVec(R, sub(w, mount.gyroBias))),
    accel: series.accel.map((a) => mulVec(R, a)),
  };
}

/**
 * True "up" in the racket frame for every sample of a noise-free simulated
 * capture, from an anchor at `staticIndex` (which must be truly static) and
 * gyro integration.
 */
export function trueUpInRacket(series: ImuSeries, staticIndex: number): Vec3[] {
  const { gyro, accel } = racketFrame(series);
  const attitude = attitudeSeries(
    attitudeFromGravity(accel[staticIndex] ?? UNIT_Z),
    gyro,
    staticIndex,
    series.sampleRateHz,
  );
  return attitude.map((q) => rotate(conjugate(q), UNIT_Z));
}

/**
 * Makes the ready position "slightly noisy": until the swing first reaches
 * `untilRateRadPerS`, the racket also turns back and forth about the vertical
 * at ±`rateRadPerS` (alternating sign every sample). Rotation about the
 * vertical changes neither the gravity seen by the accelerometer nor any
 * elevation, so the true face, path and tip angles are unchanged; only the
 * gyro never reads quiet.
 */
export function jiggleAboutVertical(
  series: ImuSeries,
  rateRadPerS: number,
  untilRateRadPerS: number,
): ImuSeries {
  const up = trueUpInRacket(series, 5);
  const { gyro } = racketFrame(series);
  const onset = gyro.findIndex((w) => norm(w) >= untilRateRadPerS);
  const sensorFromRacket = transpose(SKEWED_MOUNT.racketFromSensor);
  return {
    ...series,
    gyro: series.gyro.map((w, i) => {
      if (i >= onset) return w;
      const turn = scale(up[i] ?? UNIT_Z, i % 2 === 0 ? rateRadPerS : -rateRadPerS);
      return add(w, mulVec(sensorFromRacket, turn));
    }),
  };
}
