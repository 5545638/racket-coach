import type { ImuSeries } from '../domain/types';
import {
  type Quat,
  IDENTITY_QUAT,
  conjugate,
  fromRotationVector,
  fromTwoVectors,
  multiply,
  normalizeQuat,
  rotate,
} from '../math/quat';
import { type Vec3, UNIT_Z, add, norm, scale, sub } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

/**
 * The samples the anchor search needs: accelerometer and bias-corrected gyro
 * in the same body frame.
 */
export type AnchorInput = Pick<
  ImuSeries,
  'accel' | 'gyro' | 'accelSaturated' | 'gyroSaturated' | 'sampleRateHz'
>;

/** Limits a stretch of samples must meet to serve as the attitude anchor. */
export interface AnchorCriteria {
  /** Length of the quiet window, samples (≈ 100 ms). */
  readonly windowSamples: number;
  /** Every sample in the window must rotate slower than this, rad/s. */
  readonly maxRateRadPerS: number;
  /** Max standard deviation of each specific-force axis within the window, g. */
  readonly maxAccelStdG: number;
  /**
   * Max change of each specific-force axis across the window (mean of the
   * second half minus mean of the first half), g. Catches the slow ramp of
   * tangential acceleration at the onset of a swing, which the spread alone
   * lets through: rate and acceleration of a starting swing grow roughly
   * exponentially, so a window can end with ~0.1 g of tangential acceleration
   * while its spread is still under 0.03 g.
   */
  readonly maxAccelDriftG: number;
  /** Max |‖mean specific force‖ − 1 g| over the window, g. */
  readonly maxGravityErrorG: number;
}

export interface AttitudeAnchor {
  /** Last sample of the quiet window; the attitude is anchored here. */
  readonly index: number;
  /** First sample of the quiet window. */
  readonly start: number;
  /** Mean specific force over the window, in the frame of sample `index`, m/s². */
  readonly gravity: Vec3;
  /** |‖gravity‖ − g|, in g. */
  readonly errorG: number;
  /** Population standard deviation of each specific-force axis over the window, g. */
  readonly accelStdG: Vec3;
  /** Number of samples in the window. */
  readonly samples: number;
}

/**
 * Finds the quiet window used to anchor absolute tilt: the latest run of
 * `windowSamples` samples ending at or before `to` (and starting at or after
 * `from`) in which the racket is demonstrably static.
 *
 * Why a window and not a single sample: when the racket is static the
 * accelerometer reads gravity alone, but a norm check on one sample cannot
 * tell gravity from gravity plus a perpendicular acceleration. 0.66 g
 * sideways changes ‖f‖ by only 0.2 g yet tilts the apparent "up" by 33°, and
 * exactly that happens at the onset of a swing, where tangential
 * acceleration grows while the rate is still small. Requiring a whole window
 * with low rate, a steady specific force (small per-axis spread and drift) and
 * a mean magnitude close to 1 g rejects such moments; averaging also reduces
 * noise.
 *
 * Remaining blind spot: a specific force that is steady for the whole window
 * and perpendicular to gravity. It passes when √(1 + a⊥²) − 1 ≤
 * `maxGravityErrorG`, i.e. a⊥ ≤ 0.32 g at 0.05 g, which would tilt gravity by
 * up to 18°. A hand that accelerates steadily for 100 ms without rotating the
 * racket is unusual in the ready position, but not impossible.
 *
 * Samples are rotated into the frame of the window's last sample (using the
 * gyro) before averaging, so slow rotation inside the window does not blur the
 * gravity estimate. Saturated samples disqualify a window.
 *
 * Returns null when no window qualifies; the caller must then withhold every
 * gravity-referenced angle.
 */
export function findAttitudeAnchor(
  imu: AnchorInput,
  from: number,
  to: number,
  criteria: AnchorCriteria,
): AttitudeAnchor | null {
  const w = Math.max(2, Math.round(criteria.windowSamples));
  const first = Math.max(0, from);
  const last = Math.min(to, imu.accel.length - 1, imu.gyro.length - 1);
  for (let end = last; end - w + 1 >= first; end--) {
    const window = quietWindow(imu, end - w + 1, end, criteria);
    if (window) return window;
  }
  return null;
}

/** Evaluates one candidate window `[start, end]`; null if it is not quiet. */
function quietWindow(
  imu: AnchorInput,
  start: number,
  end: number,
  criteria: AnchorCriteria,
): AttitudeAnchor | null {
  for (let i = start; i <= end; i++) {
    const w = imu.gyro[i];
    if (!w || imu.accelSaturated[i] || imu.gyroSaturated[i]) return null;
    if (norm(w) >= criteria.maxRateRadPerS) return null;
  }
  const local = derotateToLast(
    imu.accel.slice(start, end + 1),
    imu.gyro.slice(start, end + 1),
    imu.sampleRateHz,
  );
  const gravity = meanVec(local);
  const stdG = scale(axisStd(local, gravity), 1 / STANDARD_GRAVITY);
  if (stdG.some((s) => s > criteria.maxAccelStdG)) return null;
  const driftG = halfDrift(local).map((d) => Math.abs(d) / STANDARD_GRAVITY);
  if (driftG.some((d) => d > criteria.maxAccelDriftG)) return null;
  const errorG = Math.abs(norm(gravity) / STANDARD_GRAVITY - 1);
  if (errorG > criteria.maxGravityErrorG) return null;
  return { index: end, start, gravity, errorG, accelStdG: stdG, samples: end - start + 1 };
}

/**
 * Expresses every specific-force sample in the body frame of the last sample,
 * using the attitude change integrated from the gyro: f_last = q_{last←i} f_i.
 */
function derotateToLast(
  accel: readonly Vec3[],
  gyro: readonly Vec3[],
  sampleRateHz: number,
): Vec3[] {
  const lastIndex = accel.length - 1;
  const relative = attitudeSeries(IDENTITY_QUAT, gyro, lastIndex, sampleRateHz);
  return accel.map((a, i) => rotate(relative[i] ?? IDENTITY_QUAT, a));
}

function meanVec(vs: readonly Vec3[]): Vec3 {
  return scale(
    vs.reduce<Vec3>((acc, v) => add(acc, v), [0, 0, 0]),
    1 / vs.length,
  );
}

/** Mean of the second half of `vs` minus the mean of the first half; an odd middle sample is skipped. */
function halfDrift(vs: readonly Vec3[]): Vec3 {
  const h = Math.floor(vs.length / 2);
  return sub(meanVec(vs.slice(vs.length - h)), meanVec(vs.slice(0, h)));
}

/** Population standard deviation of each axis about `mean`. */
function axisStd(vs: readonly Vec3[], mean: Vec3): Vec3 {
  const sq = vs.reduce<Vec3>(
    (acc, v) => {
      const d = sub(v, mean);
      return [acc[0] + d[0] * d[0], acc[1] + d[1] * d[1], acc[2] + d[2] * d[2]];
    },
    [0, 0, 0],
  );
  return [Math.sqrt(sq[0] / vs.length), Math.sqrt(sq[1] / vs.length), Math.sqrt(sq[2] / vs.length)];
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
