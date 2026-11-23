import { describe, expect, it } from 'vitest';
import { mul, transpose } from '../../src/math/mat3';
import { calibrateMount, extractStaticPose } from '../../src/processing/calibration';
import { toImuSeries } from '../../src/processing/units';
import { simulateStatic } from '../../src/simulation/swingModel';
import { SKEWED_MOUNT } from '../helpers';
import type { Vec3 } from '../../src/math/vec3';

const pose = (up: Vec3) => {
  const result = extractStaticPose(toImuSeries(simulateStatic(up, SKEWED_MOUNT, 104, 104)));
  if (!result.ok) throw new Error(result.reason);
  return result.pose;
};

describe('two-pose mounting calibration', () => {
  it('recovers the sensor orientation and gyro bias', () => {
    const result = calibrateMount(pose([0, 0, 1]), pose([1, 0, 0]));
    if (!result.ok) throw new Error(result.reason);
    // R_est · R_trueᵀ should be the identity.
    const residual = mul(
      result.calibration.racketFromSensor,
      transpose(SKEWED_MOUNT.racketFromSensor),
    );
    [0, 1, 2].forEach((i) => {
      expect(residual[i]?.[i]).toBeCloseTo(1, 3);
    });
    result.calibration.gyroBias.forEach((b, i) => {
      expect(b).toBeCloseTo(SKEWED_MOUNT.gyroBias[i] ?? NaN, 2);
    });
  });

  it('tolerates a sloppy tip-up pose without affecting the face normal', () => {
    const result = calibrateMount(pose([0, 0, 1]), pose([1, 0.25, 0.15]));
    if (!result.ok) throw new Error(result.reason);
    const residual = mul(
      result.calibration.racketFromSensor,
      transpose(SKEWED_MOUNT.racketFromSensor),
    );
    expect(residual[2][2]).toBeCloseTo(1, 3);
  });

  it('rejects two poses that are not roughly perpendicular', () => {
    const result = calibrateMount(pose([0, 0, 1]), pose([0.1, 0, 1]));
    expect(result.ok).toBe(false);
  });

  it('rejects a capture taken while the racket moved', () => {
    const series = toImuSeries(simulateStatic([0, 0, 1], SKEWED_MOUNT, 104, 104));
    const moved = {
      ...series,
      gyro: series.gyro.map((g, i) => (i === 50 ? ([1, 0, 0] as const) : g)),
    };
    expect(extractStaticPose(moved)).toEqual({
      ok: false,
      reason: expect.stringContaining('rotation') as string,
    });
  });
});
