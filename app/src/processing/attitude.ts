import {
  type Quat,
  conjugate,
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
  accelSaturated: readonly boolean[],
  from: number,
  to: number,
): AttitudeAnchor | null {
  let best: AttitudeAnchor | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, from); i <= Math.min(to, accel.length - 1); i++) {
    const a = accel[i];
    const w = gyro[i];
    if (!a || !w || accelSaturated[i]) continue;
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
 * Attitude `q_WB` for every sample, integrated forwards and backwards from the
 * anchor using body-frame angular rates and trapezoidal rate averaging. Gyro
 * drift grows with distance from the anchor; the anchor lies in the quiet
 * phase before the forward swing, so the stroke stays within about a second
 * of it.
 */
export function attitudeSeries(
  anchorAttitude: Quat,
  gyro: readonly Vec3[],
  anchorIndex: number,
  sampleRateHz: number,
): Quat[] {
  if (anchorIndex < 0 || anchorIndex >= gyro.length) {
    throw new RangeError('Attitude anchor outside the capture');
  }
  const dt = 1 / sampleRateHz;
  const step = (i: number): Quat => {
    const w0 = gyro[i] ?? [0, 0, 0];
    const w1 = gyro[i + 1] ?? w0;
    return fromRotationVector(scale(add(w0, w1), 0.5), dt);
  };
  const out: Quat[] = Array.from({ length: gyro.length }, () => anchorAttitude);
  for (let i = anchorIndex; i < gyro.length - 1; i++) {
    out[i + 1] = normalizeQuat(multiply(out[i] ?? anchorAttitude, step(i)));
  }
  for (let i = anchorIndex; i > 0; i--) {
    out[i - 1] = normalizeQuat(multiply(out[i] ?? anchorAttitude, conjugate(step(i - 1))));
  }
  return out;
}
