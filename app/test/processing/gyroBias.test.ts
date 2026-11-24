import { describe, expect, it } from 'vitest';
import type { ImuSeries } from '../../src/domain/types';
import { fromAxisAngle, rotate } from '../../src/math/quat';
import {
  type Vec3,
  DEG_TO_RAD,
  RAD_TO_DEG,
  add,
  norm,
  normalize,
  scale,
} from '../../src/math/vec3';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { computeSwingKinematics } from '../../src/metrics/kinematics';
import { type BiasParams, estimateGyroBias } from '../../src/processing/gyroBias';
import { STANDARD_GRAVITY } from '../../src/processing/units';
import { createRandom, gaussian } from '../../src/simulation/random';
import { ALIGNED_MOUNT } from '../helpers';

const PARAMS: BiasParams = {
  minWindowS: DEFAULT_ANALYSIS_PARAMS.biasWindowMinS,
  maxWindowS: DEFAULT_ANALYSIS_PARAMS.biasWindowMaxS,
  maxBiasDps: DEFAULT_ANALYSIS_PARAMS.biasMaxDps,
  maxUndetectedRateDps: DEFAULT_ANALYSIS_PARAMS.biasMaxUndetectedDps,
  quietRateRadPerS: DEFAULT_ANALYSIS_PARAMS.quietRateRadPerS,
};

const FS = 104;
const UP_IN_BODY: Vec3 = normalize([0.2, -0.3, 0.93]);

/**
 * A racket held in the ready position for `seconds`: it really rotates at
 * `rotation` (rad/s, world frame, constant) and its gyro reads that plus
 * `bias`. Gravity in the body frame follows the real rotation; accelerometer
 * noise 1 mg per sample (≈ the datasheet density at 104 Hz).
 */
function readyPosition(
  seconds: number,
  rotation: Vec3,
  bias: Vec3,
  noiseG = 0.001,
  seed = 3,
): { gyro: Vec3[]; accel: Vec3[]; unusable: boolean[] } {
  const random = createRandom(seed);
  const n = Math.round(seconds * FS);
  const gyro: Vec3[] = [];
  const accel: Vec3[] = [];
  const rate = norm(rotation);
  const axis: Vec3 = rate > 0 ? scale(rotation, 1 / rate) : [1, 0, 0];
  for (let i = 0; i < n; i++) {
    // Body attitude R(t) = rotation by rate·t; gravity in the body frame turns the other way.
    const q = fromAxisAngle(axis, -rate * (i / FS));
    const g = scale(rotate(q, UP_IN_BODY), STANDARD_GRAVITY);
    accel.push(
      add(g, [0, 1, 2].map(() => gaussian(random) * noiseG * STANDARD_GRAVITY) as unknown as Vec3),
    );
    gyro.push(add(rotation, bias));
  }
  return { gyro, accel, unusable: new Array<boolean>(n).fill(false) };
}

const estimate = (input: ReturnType<typeof readyPosition>, params: BiasParams = PARAMS) =>
  estimateGyroBias({ ...input, sampleRateHz: FS }, input.gyro.length - 1, params);

const horizontal = (rate: number): Vec3 => scale(normalize([0.9, 0.4, 0.05]), rate);

describe('per-capture gyro bias re-estimation', () => {
  it('measures a 3 deg/s residual bias of a still racket', () => {
    const bias: Vec3 = scale(normalize([1, -2, 0.5]), 3 * DEG_TO_RAD);
    const e = estimate(readyPosition(0.7, [0, 0, 0], bias));
    expect(e?.decision).toBe('accepted');
    expect(e?.windowS).toBeCloseTo(0.5, 2); // extended back to the 0.5 s limit
    expect(norm(add(e?.meanRadPerS ?? [9, 9, 9], scale(bias, -1))) * RAD_TO_DEG).toBeLessThan(0.01);
  });

  it('does not take a slow 0.3 rad/s rotation for bias (implausible, and gravity turned)', () => {
    const e = estimate(readyPosition(0.7, horizontal(0.3), [0, 0, 0]));
    expect(e?.decision).toBe('implausible');
    // Even without the plausibility limit the accelerometer exposes it.
    const unlimited = estimate(readyPosition(0.7, horizontal(0.3), [0, 0, 0]), {
      ...PARAMS,
      maxBiasDps: 100,
    });
    expect(unlimited?.decision).toBe('gravity-turned');
  });

  it('does not take a rotation below the limit (2.9 deg/s) for bias: gravity turned', () => {
    const e = estimate(readyPosition(0.7, horizontal(0.05), [0, 0, 0]));
    expect(e?.decision).toBe('gravity-turned');
    expect(e?.gravityTurnRad ?? 0).toBeGreaterThan(0.5 * (e?.predictedTurnRad ?? Infinity));
    // The same rate as a bias of a still racket is accepted.
    expect(estimate(readyPosition(0.7, [0, 0, 0], horizontal(0.05)))?.decision).toBe('accepted');
  });

  it('keeps the calibration bias when the window is too short or too noisy to tell', () => {
    const bias = horizontal(2 * DEG_TO_RAD);
    // 80 ms still: below the 100 ms minimum.
    expect(estimate(readyPosition(0.08, [0, 0, 0], bias))?.decision).toBe('window-too-short');
    // 120 ms with 5 mg of hand tremor: a 1 deg/s rotation would be invisible.
    expect(estimate(readyPosition(0.12, [0, 0, 0], bias, 0.005))?.decision).toBe('unresolvable');
  });

  it('cannot see rotation about the vertical (documented blind spot, bounded by the limit)', () => {
    const aboutVertical = scale(UP_IN_BODY, 3 * DEG_TO_RAD);
    expect(estimate(readyPosition(0.7, aboutVertical, [0, 0, 0]))?.decision).toBe('accepted');
  });

  it('a racket turning at 0.3 rad/s in the anchor window: no correction in the analysis', () => {
    const ready = readyPosition(1.0, horizontal(0.3), [0, 0, 0], 0.0005);
    // Then a swing about the body z axis (racket rate only; enough to segment).
    const swing = Array.from({ length: 60 }, (_, k): Vec3 => [
      0,
      0,
      25 * Math.exp(-0.5 * ((k - 30) / 8) ** 2),
    ]);
    const last = ready.accel.at(-1) ?? [0, 0, STANDARD_GRAVITY];
    const series: ImuSeries = {
      sampleRateHz: FS,
      gyro: [...ready.gyro, ...swing],
      accel: [...ready.accel, ...swing.map(() => last)],
      accelSaturated: new Array<boolean>(160).fill(false),
      gyroSaturated: new Array<boolean>(160).fill(false),
      triggerIndex: 120,
    };
    const kin = computeSwingKinematics(series, ALIGNED_MOUNT, DEFAULT_ANALYSIS_PARAMS);
    expect(kin.anchor).not.toBeNull();
    expect(kin.biasEstimate?.decision).not.toBe('accepted');
    expect(analyzeSwing(series, ALIGNED_MOUNT).quality.gyroBiasCorrectionDps).toBe(0);
  });
});
