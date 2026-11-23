/** Immutable 3-vector. All library code treats vectors as values. */
export type Vec3 = readonly [number, number, number];

export const vec3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

export const ZERO: Vec3 = [0, 0, 0];
export const UNIT_X: Vec3 = [1, 0, 0];
export const UNIT_Y: Vec3 = [0, 1, 0];
export const UNIT_Z: Vec3 = [0, 0, 1];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Returns the unit vector of `a`. Throws on (near) zero vectors to surface bugs early. */
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n < 1e-12) {
    throw new RangeError('Cannot normalize a zero-length vector');
  }
  return scale(a, 1 / n);
}

/** Angle between two non-zero vectors, radians in [0, π]. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const c = dot(a, b) / (norm(a) * norm(b));
  return Math.acos(Math.min(1, Math.max(-1, c)));
}

export const RAD_TO_DEG = 180 / Math.PI;
export const DEG_TO_RAD = Math.PI / 180;
