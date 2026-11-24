import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import { DEFAULT_SWING, type SwingSpec, simulateSwing } from '../../src/simulation/swingModel';
import {
  SETUP,
  SKEWED_MOUNT,
  expectNear,
  jiggleAboutVertical,
  racketFrame,
  trueUpInRacket,
} from '../helpers';
import { STANDARD_GRAVITY } from '../../src/processing/units';
import { RAD_TO_DEG, angleBetween, norm } from '../../src/math/vec3';

/** A longer capture with a full second of ready position before the stroke. */
const LONG_SETUP = { ...SETUP, durationS: 2.4, contactTimeS: 1.6 };

/**
 * Angle tolerance for noise-free simulated swings, deg. Contact angles are
 * extrapolated by half a sample from the last two pre-impact samples, and
 * the anchor window sits just before the swing starts; together these leave
 * up to ≈ 0.9° in simulation.
 */
const ANGLE_TOL_DEG = 1;

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
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
    expect(metrics.headSpeedMps).toBeCloseTo(truth.headSpeedMps, 0);
    expect(Math.abs(metrics.peakSpeedOffsetMs ?? Infinity)).toBeLessThanOrEqual(10);
  });

  it.each([
    { faceTiltDeg: 8, swingPathDeg: 5 },
    { faceTiltDeg: -25, swingPathDeg: 45 },
    { faceTiltDeg: 0, swingPathDeg: -10 },
  ])('tracks face $faceTiltDeg° / path $swingPathDeg°', (geometry) => {
    const { metrics, truth } = run(geometry);
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
  });

  it('identifies a backhand from the hitting face, with the same angle conventions', () => {
    const { metrics, truth } = run({ hittingFace: 'backhand', faceTiltDeg: 5 });
    expect(metrics.strokeType).toBe('backhand');
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
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
    expect(metrics.peakSpeedOffsetMs).toBe(0); // the peak is the reference
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
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
  });

  it('handles a backswing before the forward swing', () => {
    const { metrics, truth } = run({ backswingRateRadPerS: 6 });
    expect(metrics.referenceIndex).toBe(truth.contactIndex);
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
  });

  it('measures the racket drop and the face at the bottom of it', () => {
    const { metrics, truth } = run({ backswingRateRadPerS: 6, swingPathDeg: 35 });
    expect(truth.racketDropDeg).toBeLessThan(-10); // the simulated racket really drops
    expectNear(metrics.racketDropDeg, truth.racketDropDeg, ANGLE_TOL_DEG);
    expectNear(metrics.faceAtDropDeg, truth.faceAtDropDeg, ANGLE_TOL_DEG);
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
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
    expect(run({}).metrics.swingStyle).toBe('drive');
  });

  it('finds contact from the jolt in rotation when the acceleration transient is weak', () => {
    // A sensor in the handle: 3 g is below the acceleration threshold. The
    // rate drop is switched off to isolate the roll jolt (see the butt-cap
    // tests for the combined, realistic case).
    const weak = run({ impactAccelG: 3, impactRateRetention: 1 });
    expect(weak.metrics.impactDetected).toBe(false);
    const { metrics, truth } = run({
      impactAccelG: 3,
      impactRateRetention: 1,
      impactRollKickRadPerS: 9,
    });
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

  it('documents the lever model: a centre of rotation off the racket axis changes speed, not path', () => {
    // Shoulder 0.3 m further out along the racket line than assumed.
    const { metrics, truth } = run({ centreOffsetM: [0, -0.3, 0] });
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
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

describe('attitude anchor: a quiet window, not a single sample', () => {
  const params = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: DEFAULT_SWING.leverRadiusM };

  it.each(['forehand', 'backhand'] as const)(
    'is not fooled by a swing-onset sample after a slightly restless ready position (%s)',
    (hittingFace) => {
      // Regression: the ready position turns ±0.48 rad/s about the vertical, so
      // no ready sample looks perfectly still. The swing onset then holds a
      // sample with ‖f‖ within 0.05 g of 1 g and ‖ω‖ < 0.5 rad/s whose
      // specific force is tilted > 20° by tangential acceleration. The former
      // single-sample anchor (min |‖f‖ − g| + 0.1‖ω‖) chose exactly that sample
      // and reported the face ≈ 33° too closed while calling it reliable.
      const { capture, truth } = simulateSwing({ ...DEFAULT_SWING, hittingFace }, LONG_SETUP);
      const clean = toImuSeries(capture);
      const series = jiggleAboutVertical(clean, 0.48, 0.2);

      const { accel, gyro } = racketFrame(series);
      const up = trueUpInRacket(clean, 5);
      const trap = accel.findIndex((f, i) => {
        const w = gyro[i];
        const u = up[i];
        if (!w || !u || i >= truth.contactIndex - 10) return false;
        const gravityErrorG = Math.abs(norm(f) / STANDARD_GRAVITY - 1);
        return gravityErrorG < 0.05 && norm(w) < 0.5 && angleBetween(f, u) * RAD_TO_DEG > 20;
      });
      expect(trap).toBeGreaterThan(0); // the trap is there

      const metrics = analyzeSwing(series, SKEWED_MOUNT, params);
      expect(metrics.quality.attitudeReliable).toBe(true);
      expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
      expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
    },
  );

  it('withholds angles when the ready position is never quiet for 100 ms', () => {
    const { capture } = simulateSwing(DEFAULT_SWING, LONG_SETUP);
    const series = jiggleAboutVertical(toImuSeries(capture), 0.7, 0.2);
    const metrics = analyzeSwing(series, SKEWED_MOUNT, params);
    expect(metrics.quality.attitudeReliable).toBe(false);
    expect(metrics.quality.anchorErrorG).toBeNull();
    expect(metrics.faceTiltDeg).toBeNull();
    expect(metrics.swingPathDeg).toBeNull();
    expect(metrics.racketDropDeg).toBeNull();
  });

  it('withholds angles when the accelerometer is not steady before the swing', () => {
    const { capture } = simulateSwing(
      { ...DEFAULT_SWING, noiseStd: { accelG: 0.08, gyroDps: 0.3 } },
      LONG_SETUP,
    );
    const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT, params);
    expect(metrics.quality.attitudeReliable).toBe(false);
    expect(metrics.faceTiltDeg).toBeNull();
  });

  it('reports the gravity error of the window mean', () => {
    const { metrics } = run({});
    expect(metrics.quality.anchorErrorG).not.toBeNull();
    expect(metrics.quality.anchorErrorG ?? 1).toBeLessThan(DEFAULT_ANALYSIS_PARAMS.maxAnchorErrorG);
  });
});

describe('contact sample: kinematics from before the impact', () => {
  it('reads head speed before the ball takes ≈ 20 % of the rate away', () => {
    const { capture, truth } = simulateSwing(DEFAULT_SWING, SETUP);
    expect(DEFAULT_SWING.impactRateRetention).toBe(0.8);
    const series = toImuSeries(capture);
    const metrics = analyzeSwing(series, SKEWED_MOUNT, {
      ...DEFAULT_ANALYSIS_PARAMS,
      leverRadiusM: DEFAULT_SWING.leverRadiusM,
    });
    expect(metrics.referenceIndex).toBe(truth.contactIndex);
    expect(metrics.headSpeedMps / truth.headSpeedMps).toBeCloseTo(1, 2);
    // The detected impact sample itself already shows the drop: reading it
    // (as before) would report the speed about 20 % low.
    const { gyro } = racketFrame(series);
    const w = gyro[metrics.referenceIndex] ?? [0, 0, 0];
    const atImpactSample = Math.hypot(w[1], w[2]) * DEFAULT_SWING.leverRadiusM;
    expect(atImpactSample / truth.headSpeedMps).toBeCloseTo(0.8, 1);
  });

  it.each([0.05, 0.5, 1])(
    'stays within a degree wherever in the sample interval the ball arrives (phase %f)',
    (contactPhase) => {
      const { metrics, truth } = run({ contactPhase });
      expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
      expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
      expect(metrics.headSpeedMps / truth.headSpeedMps).toBeCloseTo(1, 1);
    },
  );

  it('times events from the middle of the interval that contains contact', () => {
    // Peak rate exactly at contact: the last pre-impact sample is half a
    // sample (4.8 ms at 104 Hz) before the estimated contact time.
    const { metrics } = run({ peakOffsetS: 0 });
    expect(metrics.peakSpeedOffsetMs).toBeCloseTo(-500 / SETUP.sampleRateHz, 6);
  });

  it('documents the timing limit: with fast forearm roll the face is only known to ± half a sample', () => {
    // 15 rad/s of roll turns the face by 4.1° in half a sample (4.8 ms).
    for (const contactPhase of [0.05, 1]) {
      const { metrics, truth } = run({ rollRateRadPerS: 15, contactPhase });
      expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, 4.5);
      expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
    }
  });
});

describe('gyro saturation', () => {
  /** A part that clips at its nominal ±2000 dps, below the int16 limit. */
  const CLIPS_AT_2000_DPS = { ...SETUP, gyroClipCounts: 28571 };

  it('detects clipping at the nominal full scale that an int16-based threshold missed', () => {
    // 38 rad/s ≈ 2180 dps: above 2000 dps, below the int16 limit (2293 dps).
    const { capture } = simulateSwing({ ...DEFAULT_SWING, peakRateRadPerS: 38 }, CLIPS_AT_2000_DPS);
    const maxGyroCount = Math.max(
      ...Array.from(
        capture.samples.filter((_, i) => i % 6 >= 3),
        (c) => Math.abs(c),
      ),
    );
    expect(maxGyroCount).toBe(28571);
    expect(maxGyroCount).toBeLessThan(32767 - 64); // the former threshold
    const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT);
    expect(metrics.quality.gyroSaturated).toBe(true);
  });

  it('withholds timing metrics when the gyro clipped in the forward swing', () => {
    // The clipped plateau would put the argmax of the rate up to ≈ 70 ms
    // early and fire "Accelerate through contact" for a well-timed swing.
    const { capture } = simulateSwing({ ...DEFAULT_SWING, peakRateRadPerS: 38 }, CLIPS_AT_2000_DPS);
    const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT);
    expect(metrics.peakSpeedOffsetMs).toBeNull();
    expect(metrics.peakAccelerationOffsetMs).toBeNull();
    // Unclipped swings keep them.
    const fine = run({ peakRateRadPerS: 30 }).metrics;
    expect(fine.quality.gyroSaturated).toBe(false);
    expect(fine.peakSpeedOffsetMs).not.toBeNull();
    expect(fine.peakAccelerationOffsetMs).not.toBeNull();
  });

  it('still recognises an overhead when clipping withholds the displayed angles', () => {
    const { metrics } = run({ tipElevationDeg: 60, swingPathDeg: 0, peakRateRadPerS: 55 });
    expect(metrics.quality.saturatedSamples).toBeGreaterThan(
      DEFAULT_ANALYSIS_PARAMS.maxSaturatedSamples,
    );
    expect(metrics.quality.attitudeReliable).toBe(false);
    expect(metrics.tipElevationDeg).toBeNull();
    expect(metrics.faceTiltDeg).toBeNull();
    expect(metrics.strokeType).toBe('overhead');
  });
});
