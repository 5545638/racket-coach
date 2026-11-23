import { type Vec3, cross, dot, normalize, scale, sub } from './vec3';

/**
 * Row-major 3x3 matrix. Used for rotation matrices only; a matrix built from
 * orthonormal columns `[x y z]` maps coordinates expressed in that basis into
 * the parent frame.
 */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export function fromColumns(x: Vec3, y: Vec3, z: Vec3): Mat3 {
  return [
    [x[0], y[0], z[0]],
    [x[1], y[1], z[1]],
    [x[2], y[2], z[2]],
  ];
}

export function column(m: Mat3, i: 0 | 1 | 2): Vec3 {
  return [m[0][i], m[1][i], m[2][i]];
}

export const transpose = (m: Mat3): Mat3 => fromColumns(m[0], m[1], m[2]);

export const mulVec = (m: Mat3, v: Vec3): Vec3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

export function mul(a: Mat3, b: Mat3): Mat3 {
  return fromColumns(mulVec(a, column(b, 0)), mulVec(a, column(b, 1)), mulVec(a, column(b, 2)));
}

/**
 * Builds a right-handed orthonormal basis whose first axis is exactly `primary`
 * and whose second axis is as close as possible to `secondary`
 * (Gram–Schmidt). Returns the basis as matrix columns `[a b c]`.
 */
export function orthonormalBasis(primary: Vec3, secondary: Vec3): Mat3 {
  const a = normalize(primary);
  const b = normalize(sub(secondary, scale(a, dot(secondary, a))));
  const c = cross(a, b);
  return fromColumns(a, b, c);
}
