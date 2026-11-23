import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import { DEFAULT_SWING, type SwingSpec, simulateSwing } from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';

function run(overrides: Partial<SwingSpec>) {
  const spec = { ...DEFAULT_SWING, ...overrides };
  const { capture, truth } = simulateSwing(spec, SETUP);
  const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT, {
    ...DEFAULT_ANALYSIS_PARAMS,
    leverRadiusM: spec.leverRadiusM,
  });
  return { metrics, truth };
}

describe('analyzeSwing on simulated swings', () => {
  it('recovers face tilt, swing path and head speed of a topspin forehand', () => {
    const { metrics, truth } = run({});
    expect(metrics.strokeType).toBe('forehand');
    expect(metrics.swingSize).toBe('full');
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.referenceIndex).toBe(truth.contactIndex);
    expect(metrics.quality.attitudeReliable).toBe(true);
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
    expect(metrics.headSpeedMps).toBeCloseTo(truth.headSpeedMps, 0);
    expect(Math.abs(metrics.peakSpeedOffsetMs)).toBeLessThanOrEqual(10);
  });

  it.each([
    { faceTiltDeg: 8, swingPathDeg: 5 },
    { faceTiltDeg: -25, swingPathDeg: 45 },
    { faceTiltDeg: 0, swingPathDeg: -10 },
  ])('tracks face $faceTiltDeg° / path $swingPathDeg°', (geometry) => {
    const { metrics, truth } = run(geometry);
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
  });

  it('identifies a backhand from the hitting face, with the same angle conventions', () => {
    const { metrics, truth } = run({ hittingFace: 'backhand', faceTiltDeg: 5 });
    expect(metrics.strokeType).toBe('backhand');
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
  });

  it('classifies a tip-up contact as an overhead', () => {
    const { metrics } = run({ tipElevationDeg: 60, swingPathDeg: 0 });
    expect(metrics.strokeType).toBe('overhead');
  });

  it('classifies a slow, short swing as compact', () => {
    const { metrics } = run({ peakRateRadPerS: 9, riseSigmaS: 0.05 });
    expect(metrics.swingSize).toBe('compact');
  });

  it('reports early acceleration as a negative peak offset', () => {
    const { metrics } = run({ peakOffsetS: -0.06 });
    expect(metrics.peakSpeedOffsetMs).toBeLessThan(-40);
  });

  it('falls back to peak speed when there is no ball contact', () => {
    const { metrics } = run({ withImpact: false });
    expect(metrics.impactDetected).toBe(false);
    expect(metrics.faceTiltDeg).not.toBeNull();
  });

  it('flags gyro saturation so speed is treated as a lower bound', () => {
    const { metrics } = run({ peakRateRadPerS: 45 });
    expect(metrics.quality.gyroSaturated).toBe(true);
  });

  it('stays within a few degrees under realistic sensor noise', () => {
    const errors = [1, 2, 3, 4, 5].map((seed) => {
      const { metrics, truth } = run({
        seed,
        noiseStd: { accelG: 0.01, gyroDps: 0.3 },
      });
      return Math.abs((metrics.faceTiltDeg ?? Infinity) - truth.faceTiltDeg);
    });
    expect(Math.max(...errors)).toBeLessThan(3);
  });

  it('withholds angles when no quiet phase precedes the swing', () => {
    const series = toImuSeries(simulateSwing(DEFAULT_SWING, SETUP).capture);
    const contactIndex = Math.round(SETUP.contactTimeS * SETUP.sampleRateHz);
    const moving = {
      ...series,
      // Scaling the specific force removes every sample that looks like 1 g.
      accel: series.accel.map((a, i) =>
        i < contactIndex - 20 ? ([a[0] * 1.5, a[1] * 1.5, a[2] * 1.5] as const) : a,
      ),
    };
    const metrics = analyzeSwing(moving, SKEWED_MOUNT);
    expect(metrics.quality.attitudeReliable).toBe(false);
    expect(metrics.faceTiltDeg).toBeNull();
    expect(metrics.strokeType).toBe('forehand');
  });
});
