import type { ImuSeries, MountCalibration } from '../domain/types';
import { fromColumns, orthonormalBasis, column, transpose } from '../math/mat3';
import { type Vec3, RAD_TO_DEG, add, angleBetween, norm, scale } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

/** Limits for accepting a static capture. */
export interface StaticCriteria {
  /** Max deviation of ‖a‖ from 1 g, in g. */
  readonly maxGravityErrorG: number;
  /** Max angular rate, rad/s. */
  readonly maxRateRadPerS: number;
  /** Accepted range for the angle between the two pose gravity vectors, degrees. */
  readonly poseAngleRangeDeg: readonly [number, number];
}

export const DEFAULT_STATIC_CRITERIA: StaticCriteria = {
  maxGravityErrorG: 0.05,
  maxRateRadPerS: 0.15,
  poseAngleRangeDeg: [70, 110],
};

export interface StaticPose {
  /** Mean specific force (points up when static), sensor frame, m/s². */
  readonly meanAccel: Vec3;
  /** Mean angular rate, sensor frame, rad/s. Equals the gyro bias when static. */
  readonly meanGyro: Vec3;
}

export type CalibrationResult =
  | { readonly ok: true; readonly calibration: MountCalibration }
  | { readonly ok: false; readonly reason: string };

export type PoseResult =
  | { readonly ok: true; readonly pose: StaticPose }
  | { readonly ok: false; readonly reason: string };

const mean = (vs: readonly Vec3[]): Vec3 =>
  scale(
    vs.reduce<Vec3>((acc, v) => add(acc, v), [0, 0, 0]),
    1 / vs.length,
  );

/** Averages a static capture and rejects it if the racket was moving. */
export function extractStaticPose(
  series: ImuSeries,
  criteria: StaticCriteria = DEFAULT_STATIC_CRITERIA,
): PoseResult {
  if (series.accel.length < 10) {
    return { ok: false, reason: 'Capture too short' };
  }
  for (let i = 0; i < series.accel.length; i++) {
    const a = series.accel[i] ?? [0, 0, 0];
    const g = series.gyro[i] ?? [0, 0, 0];
    if (Math.abs(norm(a) / STANDARD_GRAVITY - 1) > criteria.maxGravityErrorG) {
      return { ok: false, reason: 'Racket moved during capture (acceleration)' };
    }
    if (norm(g) > criteria.maxRateRadPerS) {
      return { ok: false, reason: 'Racket moved during capture (rotation)' };
    }
  }
  return { ok: true, pose: { meanAccel: mean(series.accel), meanGyro: mean(series.gyro) } };
}

/**
 * Two-pose mounting calibration.
 *
 * - `faceUp`: racket lying flat, forehand face pointing up → gives racket +z.
 * - `tipUp`: racket standing on its butt cap, tip up → gives racket +x.
 *
 * The face normal is taken as exact and the long axis is orthogonalised
 * against it, so a slightly tilted tip-up pose costs no accuracy in face
 * angle. The face-up pose is trusted because it is easy to repeat (the racket
 * lies flat on the ground or a bench), not because of where the sensor is
 * mounted; the sensor sits in the butt cap.
 */
export function calibrateMount(
  faceUp: StaticPose,
  tipUp: StaticPose,
  criteria: StaticCriteria = DEFAULT_STATIC_CRITERIA,
  now: () => Date = () => new Date(),
): CalibrationResult {
  const angleDeg = angleBetween(faceUp.meanAccel, tipUp.meanAccel) * RAD_TO_DEG;
  const [lo, hi] = criteria.poseAngleRangeDeg;
  if (angleDeg < lo || angleDeg > hi) {
    return {
      ok: false,
      reason: `The two poses should be ~90° apart, measured ${angleDeg.toFixed(0)}°. Repeat both steps.`,
    };
  }
  // Columns of orthonormalBasis(z, x) are [z, x', z × x'] = [z, x, y].
  const basis = orthonormalBasis(faceUp.meanAccel, tipUp.meanAccel);
  const zS = column(basis, 0);
  const xS = column(basis, 1);
  const yS = column(basis, 2);
  const sensorFromRacket = fromColumns(xS, yS, zS);

  return {
    ok: true,
    calibration: {
      version: 1,
      racketFromSensor: transpose(sensorFromRacket),
      gyroBias: scale(add(faceUp.meanGyro, tipUp.meanGyro), 0.5),
      createdAt: now().toISOString(),
    },
  };
}
