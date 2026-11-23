import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANALYSIS_PARAMS,
  analyzeSwing,
  analyzeSwingDetailed,
} from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import { DEFAULT_SWING, type SwingSpec, simulateSwing } from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';

/** A longer capture with a full second of ready position before the stroke. */
const LONG_SETUP = { ...SETUP, durationS: 2.4, contactTimeS: 1.6 };

function run(overrides: Partial<SwingSpec>, setup = SETUP) {
  const spec = { ...DEFAULT_SWING, ...overrides };
  const { capture, truth } = simulateSwing(spec, setup);
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
    const { metrics, truth } = run({ peakRateRadPerS: 45 });
    expect(metrics.quality.gyroSaturated).toBe(true);
    expect(metrics.headSpeedMps).toBeLessThan(truth.headSpeedMps);
  });

  it('never reports angles more than 3° off as the gyro clips harder', () => {
    let withheld = 0;
    for (let rate = 38; rate <= 60; rate += 2) {
      const { metrics, truth } = run({ peakRateRadPerS: rate });
      if (metrics.faceTiltDeg === null || metrics.swingPathDeg === null) {
        withheld++;
        continue;
      }
      expect(Math.abs(metrics.faceTiltDeg - truth.faceTiltDeg)).toBeLessThan(3);
      expect(Math.abs(metrics.swingPathDeg - truth.swingPathDeg)).toBeLessThan(3);
    }
    expect(withheld).toBeGreaterThan(0); // the guard actually engaged
  });

  it('is unaffected by forearm roll about the racket axis', () => {
    const { metrics, truth } = run({ rollRateRadPerS: 15 });
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
  });

  it('handles a backswing before the forward swing', () => {
    const { metrics, truth } = run({ backswingRateRadPerS: 6 });
    expect(metrics.referenceIndex).toBe(truth.contactIndex);
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
  });

  it('measures the racket drop and the face at the bottom of it', () => {
    const { metrics, truth } = run({ backswingRateRadPerS: 6, swingPathDeg: 35 });
    expect(truth.racketDropDeg).toBeLessThan(-10); // the simulated racket really drops
    expect(metrics.racketDropDeg).toBeCloseTo(truth.racketDropDeg, 0);
    expect(metrics.faceAtDropDeg).toBeCloseTo(truth.faceAtDropDeg, 0);
  });

  it('times the preparation from the last still moment to contact', () => {
    const early = run({ backswingRateRadPerS: 6, backswingLeadS: 0.6 }, LONG_SETUP).metrics;
    const late = run({ backswingRateRadPerS: 6, backswingLeadS: 0.4 }, LONG_SETUP).metrics;
    if (early.preparationTimeMs === null || late.preparationTimeMs === null) {
      throw new Error('preparation not found');
    }
    // The backswing Gaussian (σ = 80 ms) leaves the quiet band ~2.5σ before its peak.
    expect(early.preparationTimeMs).toBeGreaterThan(700);
    expect(early.preparationTimeMs).toBeLessThan(900);
    expect(early.preparationTimeMs - late.preparationTimeMs).toBeCloseTo(200, -1.5);
    expect(early.backswingArcDeg).toBeGreaterThan(40);
    // The simulated swing stops briefly between backswing and forward swing.
    expect(early.backswingPauseMs).toBeGreaterThan(100);
    expect(early.backswingPauseMs).toBeLessThan(300);
    expect(run({}, LONG_SETUP).metrics.backswingPauseMs).toBe(0);
  });

  it('reports no preparation time when the capture starts mid-motion', () => {
    const series = toImuSeries(simulateSwing(DEFAULT_SWING, SETUP).capture);
    const moving = { ...series, gyro: series.gyro.map((w) => [w[0] + 1, w[1], w[2]] as const) };
    expect(analyzeSwing(moving, SKEWED_MOUNT).preparationTimeMs).toBeNull();
  });

  it('measures how fast the face is closing at contact', () => {
    const still = run({});
    expect(still.metrics.faceClosingRateDps).toBeCloseTo(still.truth.faceClosingRateDps, -1);
    const rolling = run({ rollRateRadPerS: -12 });
    const measured = rolling.metrics.faceClosingRateDps ?? NaN;
    expect(Math.abs(rolling.truth.faceClosingRateDps)).toBeGreaterThan(300);
    expect(measured / rolling.truth.faceClosingRateDps).toBeCloseTo(1, 1);
  });

  it('locates the acceleration peak before contact', () => {
    // Rise σ = 90 ms: the rate Gaussian is steepest one σ before its peak.
    expect(run({}).metrics.peakAccelerationOffsetMs).toBeCloseTo(-90, -1.2);
    expect(run({ riseSigmaS: 0.05 }).metrics.peakAccelerationOffsetMs).toBeCloseTo(-50, -1.2);
  });

  it('classifies a downward swing with an open face as a slice', () => {
    const { metrics, truth } = run({ swingPathDeg: -20, faceTiltDeg: 12, hittingFace: 'backhand' });
    expect(metrics.strokeType).toBe('backhand');
    expect(metrics.swingStyle).toBe('slice');
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
    expect(run({}).metrics.swingStyle).toBe('drive');
  });

  it('finds contact from the jolt in rotation when the acceleration transient is weak', () => {
    // A sensor in the handle: 3 g is below the acceleration threshold.
    const weak = run({ impactAccelG: 3 });
    expect(weak.metrics.impactDetected).toBe(false);
    const { metrics, truth } = run({ impactAccelG: 3, impactRollKickRadPerS: 9 });
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.referenceIndex).toBe(truth.contactIndex);
    // The jolt itself disturbs the last integration step, so allow a few degrees.
    expect(Math.abs((metrics.faceTiltDeg ?? NaN) - truth.faceTiltDeg)).toBeLessThan(4);
    expect(Math.abs((metrics.swingPathDeg ?? NaN) - truth.swingPathDeg)).toBeLessThan(4);
  });

  it('does not mistake a fast shadow swing for contact', () => {
    for (const rate of [24, 32, 38]) {
      expect(run({ withImpact: false, peakRateRadPerS: rate }).metrics.impactDetected).toBe(false);
    }
  });

  it('reconstructs the racket motion in a heading-aligned display frame', () => {
    const spec = { ...DEFAULT_SWING, backswingRateRadPerS: 6, tipElevationDeg: 10 };
    const { capture, truth } = simulateSwing(spec, LONG_SETUP);
    const { metrics, trace } = analyzeSwingDetailed(toImuSeries(capture), SKEWED_MOUNT);
    if (!trace) throw new Error('no trace');
    expect(trace.startIndex + trace.contact).toBe(truth.contactIndex);
    expect(trace.tipDirection).toHaveLength(trace.speedMps.length);

    // At contact: tip at the simulated elevation, perpendicular to the direction of travel.
    const tip = trace.tipDirection[trace.contact] ?? [0, 0, 0];
    expect(Math.asin(tip[2]) * (180 / Math.PI)).toBeCloseTo(truth.tipElevationDeg, 0);
    expect(Math.abs(tip[0])).toBeLessThan(0.15); // not exactly 0: the path is inclined
    // The hitting face looks along +x (towards the target), tilted as measured.
    const normal = trace.faceNormal[trace.contact] ?? [0, 0, 0];
    expect(normal[0]).toBeGreaterThan(0.9);
    expect(Math.asin(normal[2]) * (180 / Math.PI)).toBeCloseTo(metrics.faceTiltDeg ?? NaN, 5);
    // The head moves forwards through contact: behind before, in front after.
    const before = trace.tipDirection[trace.contact - 8] ?? [0, 0, 0];
    const after = trace.tipDirection[trace.contact + 8] ?? [0, 0, 0];
    expect(before[0]).toBeLessThan(-0.3);
    expect(after[0]).toBeGreaterThan(0.3);
    expect(trace.speedMps[trace.contact]).toBeCloseTo(truth.headSpeedMps, 0);
  });

  it('gives no trace when the attitude is unreliable', () => {
    const series = toImuSeries(
      simulateSwing({ ...DEFAULT_SWING, peakRateRadPerS: 58 }, SETUP).capture,
    );
    expect(analyzeSwingDetailed(series, SKEWED_MOUNT).trace).toBeNull();
  });

  it('documents the lever model: a centre of rotation off the racket axis changes speed, not path', () => {
    // Shoulder 0.3 m further out along the racket line than assumed.
    const { metrics, truth } = run({ centreOffsetM: [0, -0.3, 0] });
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
    expect(metrics.headSpeedMps / truth.headSpeedMps).toBeCloseTo(1 / 0.7, 1);
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
