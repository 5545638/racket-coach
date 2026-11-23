import type { MountCalibration } from '../src/domain/types';
import { type Mat3, transpose } from '../src/math/mat3';
import { fromAxisAngle, rotate } from '../src/math/quat';
import type { Vec3 } from '../src/math/vec3';
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
