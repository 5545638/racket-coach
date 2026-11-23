import { describe, expect, it } from 'vitest';
import { mulVec, orthonormalBasis, transpose, mul, IDENTITY } from '../../src/math/mat3';
import {
  IDENTITY_QUAT,
  fromAxisAngle,
  fromMatrix,
  fromRotationVector,
  fromTwoVectors,
  multiply,
  rotate,
  rotationAngle,
} from '../../src/math/quat';
import { type Vec3, cross, dot, norm, normalize } from '../../src/math/vec3';
import { rotationMatrix } from '../helpers';

const expectVec = (a: Vec3, b: Vec3, digits = 9) => {
  a.forEach((v, i) => {
    expect(v).toBeCloseTo(b[i] ?? NaN, digits);
  });
};

describe('vec3', () => {
  it('follows the right-hand rule', () => {
    expectVec(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  });
  it('refuses to normalize a zero vector', () => {
    expect(() => normalize([0, 0, 0])).toThrow(RangeError);
  });
});

describe('quaternions', () => {
  it('rotates +x by 90° about +z onto +y', () => {
    expectVec(rotate(fromAxisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0]);
  });

  it('composes rotations in Hamilton order', () => {
    const a = fromAxisAngle([0, 0, 1], 0.4);
    const b = fromAxisAngle([1, 0, 0], -0.7);
    const v: Vec3 = [0.2, -1.1, 0.5];
    expectVec(rotate(multiply(a, b), v), rotate(a, rotate(b, v)));
  });

  it('maps one direction onto another, including the antiparallel case', () => {
    for (const [from, to] of [
      [
        [1, 2, 3],
        [-2, 0.5, 1],
      ],
      [
        [0, 0, 1],
        [0, 0, -1],
      ],
    ] as [Vec3, Vec3][]) {
      expectVec(rotate(fromTwoVectors(from, to), normalize(from)), normalize(to));
    }
  });

  it('integrates a constant rate exactly', () => {
    const q = fromRotationVector([0, 0, 2], 0.5);
    expect(rotationAngle(q)).toBeCloseTo(1, 12);
    expect(rotationAngle(fromRotationVector([0, 0, 0], 1))).toBe(0);
    expect(IDENTITY_QUAT[0]).toBe(1);
  });

  it('round-trips through rotation matrices', () => {
    const m = rotationMatrix([0.3, -0.5, 0.8], 2.1);
    const q = fromMatrix(m);
    const v: Vec3 = [0.4, 0.1, -0.9];
    expectVec(rotate(q, v), mulVec(m, v));
  });
});

describe('mat3', () => {
  it('builds a right-handed orthonormal basis', () => {
    const b = orthonormalBasis([0, 0, 2], [1, 0.3, 0.1]);
    expectVec(mulVec(mul(transpose(b), b), [1, 2, 3]), mulVec(IDENTITY, [1, 2, 3]));
    const cols = [0, 1, 2].map((i) => [b[0][i], b[1][i], b[2][i]] as const) as Vec3[];
    expect(norm(cols[0] ?? [0, 0, 0])).toBeCloseTo(1);
    expect(dot(cols[0] ?? [0, 0, 0], cols[1] ?? [0, 0, 0])).toBeCloseTo(0);
    expectVec(cross(cols[0] ?? [0, 0, 0], cols[1] ?? [0, 0, 0]), cols[2] ?? [0, 0, 0]);
  });
});
