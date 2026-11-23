import type { Mat3 } from './mat3';
import { type Vec3, cross, dot, norm, normalize } from './vec3';

/**
 * Unit quaternion `[w, x, y, z]` (Hamilton convention).
 * `q_AB` rotates vectors expressed in frame B into frame A: v_A = q_AB ⊗ v_B ⊗ q_AB*.
 */
export type Quat = readonly [number, number, number, number];

export const IDENTITY_QUAT: Quat = [1, 0, 0, 0];

export function multiply(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export const conjugate = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];

export function normalizeQuat(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-12) {
    throw new RangeError('Cannot normalize a zero quaternion');
  }
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotates vector `v` by unit quaternion `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w(u×v) + 2u×(u×v), with u = vector part of q.
  const u: Vec3 = [q[1], q[2], q[3]];
  const w = q[0];
  const t = cross(u, v);
  const t2: Vec3 = [2 * t[0], 2 * t[1], 2 * t[2]];
  const ut2 = cross(u, t2);
  return [v[0] + w * t2[0] + ut2[0], v[1] + w * t2[1] + ut2[1], v[2] + w * t2[2] + ut2[2]];
}

export function fromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const a = normalize(axis);
  const s = Math.sin(angleRad / 2);
  return [Math.cos(angleRad / 2), a[0] * s, a[1] * s, a[2] * s];
}

/**
 * Exact quaternion increment for a constant body-frame angular rate `omega`
 * (rad/s) applied over `dt` seconds.
 */
export function fromRotationVector(omega: Vec3, dt: number): Quat {
  const rate = norm(omega);
  const angle = rate * dt;
  if (angle < 1e-12) {
    return normalizeQuat([1, (omega[0] * dt) / 2, (omega[1] * dt) / 2, (omega[2] * dt) / 2]);
  }
  return fromAxisAngle(omega, angle);
}

/** Shortest-arc rotation taking unit direction `from` onto unit direction `to`. */
export function fromTwoVectors(from: Vec3, to: Vec3): Quat {
  const f = normalize(from);
  const t = normalize(to);
  const d = dot(f, t);
  if (d < -1 + 1e-9) {
    // Opposite vectors: rotate π about any axis orthogonal to `from`.
    const ortho = Math.abs(f[0]) < 0.9 ? cross(f, [1, 0, 0]) : cross(f, [0, 1, 0]);
    return fromAxisAngle(ortho, Math.PI);
  }
  const c = cross(f, t);
  return normalizeQuat([1 + d, c[0], c[1], c[2]]);
}

/** Converts a rotation matrix to a unit quaternion (Shepperd's method). */
export function fromMatrix(m: Mat3): Quat {
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return normalizeQuat(q);
}

/** Rotation angle of `q` in radians, in [0, π]. */
export function rotationAngle(q: Quat): number {
  const w = Math.min(1, Math.abs(q[0]));
  return 2 * Math.acos(w);
}
