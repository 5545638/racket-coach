import { describe, expect, it } from 'vitest';
import {
  type AnchorCriteria,
  type AnchorInput,
  findAttitudeAnchor,
} from '../../src/processing/attitude';
import { STANDARD_GRAVITY } from '../../src/processing/units';
import { type Vec3, RAD_TO_DEG, angleBetween } from '../../src/math/vec3';

const G = STANDARD_GRAVITY;
const CRITERIA: AnchorCriteria = {
  windowSamples: 10,
  maxRateRadPerS: 0.5,
  maxAccelStdG: 0.03,
  maxAccelDriftG: 0.01,
  maxGravityErrorG: 0.05,
};

function imu(accel: Vec3[], gyro?: Vec3[]): AnchorInput {
  return {
    accel,
    gyro: gyro ?? accel.map(() => [0, 0, 0] as const),
    accelSaturated: accel.map(() => false),
    gyroSaturated: accel.map(() => false),
    sampleRateHz: 104,
  };
}

const still = (n: number, up: Vec3 = [0, 0, G]): Vec3[] => Array.from({ length: n }, () => up);

describe('findAttitudeAnchor', () => {
  it('anchors at the last sample of the latest quiet window', () => {
    const anchor = findAttitudeAnchor(imu(still(40)), 0, 30, CRITERIA);
    expect(anchor).toMatchObject({ index: 30, start: 21 });
    expect(anchor?.errorG).toBeCloseTo(0, 9);
  });

  it('rejects a single sample whose norm is 1 g but whose direction is tilted', () => {
    // 0.66 g sideways plus 0.75 g vertical: ‖f‖ = 1.0 g, tilted ≈ 41°.
    const tilted: Vec3 = [0.66 * G, 0, 0.75 * G];
    const accel = [...still(20), ...Array.from({ length: 10 }, () => tilted)];
    accel[25] = [0.2 * G, 0, 0.98 * G]; // the window is not steady either
    const anchor = findAttitudeAnchor(imu(accel), 0, 29, CRITERIA);
    expect(anchor?.index).toBe(19);
    expect(angleBetween(anchor?.gravity ?? [0, 0, 0], [0, 0, 1]) * RAD_TO_DEG).toBeLessThan(0.1);
  });

  it('rejects the slow ramp of tangential acceleration at the onset of a swing', () => {
    // Sideways acceleration growing 30 % per sample, reaching 0.1 g.
    const accel = still(40).map((f, i): Vec3 => {
      const side = i < 20 ? 0 : 0.1 * G * 1.3 ** (i - 39);
      return [side, 0, f[2]];
    });
    const tiltDeg = (criteria: AnchorCriteria): number => {
      const anchor = findAttitudeAnchor(imu(accel), 0, 39, criteria);
      return angleBetween(anchor?.gravity ?? [0, 0, 0], [0, 0, 1]) * RAD_TO_DEG;
    };
    // The spread alone (< 0.03 g) admits the window ending on the 0.1 g sample.
    expect(tiltDeg({ ...CRITERIA, maxAccelDriftG: 1 })).toBeGreaterThan(2);
    expect(tiltDeg(CRITERIA)).toBeLessThan(0.5);
  });

  it('rejects windows with rotation, saturation or a wrong gravity magnitude', () => {
    const fast = imu(still(20), still(20, [0, 0.6, 0]));
    expect(findAttitudeAnchor(fast, 0, 19, CRITERIA)).toBeNull();
    const clipped = { ...imu(still(20)), accelSaturated: still(20).map((_, i) => i % 5 === 0) };
    expect(findAttitudeAnchor(clipped, 0, 19, CRITERIA)).toBeNull();
    const heavy = imu(still(20, [0, 0, 1.06 * G]));
    expect(findAttitudeAnchor(heavy, 0, 19, CRITERIA)).toBeNull();
  });

  it('needs a whole window inside the search range', () => {
    expect(findAttitudeAnchor(imu(still(40)), 25, 33, CRITERIA)).toBeNull();
    expect(findAttitudeAnchor(imu(still(40)), 24, 33, CRITERIA)?.index).toBe(33);
  });

  it('averages in the frame of the last sample, so slow rotation does not blur gravity', () => {
    // Rotating at 0.4 rad/s about body y: gravity in the body turns the other way.
    const rate = 0.4;
    const accel = Array.from({ length: 20 }, (_, i): Vec3 => {
      const a = (-rate * (i - 19)) / 104;
      return [Math.sin(a) * G, 0, Math.cos(a) * G];
    });
    const gyro = still(20, [0, rate, 0]);
    const anchor = findAttitudeAnchor(imu(accel, gyro), 0, 19, CRITERIA);
    const tiltDeg = angleBetween(anchor?.gravity ?? [0, 0, 0], accel[19] ?? [0, 0, 0]) * RAD_TO_DEG;
    expect(tiltDeg).toBeLessThan(0.01);
  });
});
