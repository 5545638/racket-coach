import {
  type Quat,
  fromRotationVector,
  fromTwoVectors,
  multiply,
  normalizeQuat,
} from '../math/quat';
import { type Vec3, UNIT_Z, add, norm, scale } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

export interface AttitudeAnchor {
  readonly index: number;
  /** |‖f‖ − g| at the anchor, in g. */
  readonly errorG: number;
}

/**
 * Finds the sample in `[from, to]` that is closest to static: specific force
 * magnitude nearest 1 g and low angular rate. During a swing the accelerometer
 * is dominated by centripetal acceleration (tens of g), so gravity – and hence
 * tilt – can only be observed in the quiet phase before the forward swing.
 */
export function findAttitudeAnchor(
  accel: readonly Vec3[],
  gyro: readonly Vec3[],
  from: number,
  to: number,
): AttitudeAnchor | null {
  let best: AttitudeAnchor | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, from); i <= Math.min(to, accel.length - 1); i++) {
    const a = accel[i];
    const w = gyro[i];
    if (!a || !w) continue;
    const errorG = Math.abs(norm(a) / STANDARD_GRAVITY - 1);
    // 1 rad/s of rotation is weighted like 0.1 g of gravity error.
    const cost = errorG + 0.1 * norm(w);
    if (cost < bestCost) {
      bestCost = cost;
      best = { index: i, errorG };
    }
  }
  return best;
}

/**
 * Attitude of the body in a gravity-aligned world frame (z up) at the anchor.
 * Heading (yaw) is unobservable without a magnetometer and is set to an
 * arbitrary value; every metric derived from it uses elevations only.
 */
export function attitudeFromGravity(specificForce: Vec3): Quat {
  return fromTwoVectors(specificForce, UNIT_Z);
}

/**
 * Propagates attitude `q_WB` from sample `from` to sample `to` (to ≥ from)
 * using body-frame angular rates and trapezoidal rate averaging.
 */
export function propagateAttitude(
  start: Quat,
  gyro: readonly Vec3[],
  from: number,
  to: number,
  sampleRateHz: number,
): Quat {
  if (to < from) {
    throw new RangeError('propagateAttitude only integrates forwards in time');
  }
  const dt = 1 / sampleRateHz;
  let q = start;
  for (let i = from; i < to; i++) {
    const w0 = gyro[i];
    const w1 = gyro[i + 1];
    if (!w0 || !w1) break;
    const wMid = scale(add(w0, w1), 0.5);
    q = normalizeQuat(multiply(q, fromRotationVector(wMid, dt)));
  }
  return q;
}
