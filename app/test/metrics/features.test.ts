import { describe, expect, it } from 'vitest';
import type { ImuSeries, StrokeFeatures } from '../../src/domain/types';
import { mulVec, transpose } from '../../src/math/mat3';
import { type Vec3, cross, norm, normalize, scale, add } from '../../src/math/vec3';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import {
  DEFAULT_FEATURE_PARAMS,
  countHitches,
  integrateSamples,
  interpolate,
} from '../../src/metrics/features';
import { computeSwingKinematics } from '../../src/metrics/kinematics';
import {
  anchorSigmaRad,
  angleSigmaDeg,
  driftSigmaDeg,
  timingSigmaMs,
} from '../../src/metrics/uncertainty';
import { STANDARD_GRAVITY, toImuSeries } from '../../src/processing/units';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  SERVE_SWING,
  type SimulationSetup,
  type SwingSpec,
  type SwingTruth,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT, expectNear, jiggleAboutVertical, trueUpInRacket } from '../helpers';

/** A full second of ready position before the stroke. */
const LONG_SETUP: SimulationSetup = { ...SETUP, durationS: 2.4, contactTimeS: 1.6 };
const FS = SETUP.sampleRateHz;

/** Angle tolerance against simulator truth, deg (as in analyzeSwing.test.ts). */
const ANGLE_TOL_DEG = 1;
/** One sample at 104 Hz, ms: event times are read from sample indices. */
const SAMPLE_MS = 1000 / FS;

function analyse(series: ImuSeries, spec: SwingSpec) {
  const params = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: spec.leverRadiusM };
  const metrics = analyzeSwing(series, SKEWED_MOUNT, params);
  if (!metrics.features) throw new Error('features missing');
  return { metrics, features: metrics.features, params };
}

function run(overrides: Partial<SwingSpec>, setup: SimulationSetup = LONG_SETUP) {
  const spec = { ...DEFAULT_SWING, ...overrides };
  const { capture, truth } = simulateSwing(spec, setup);
  const series = toImuSeries(capture);
  return { ...analyse(series, spec), truth, series, spec };
}

const sample = (ms: number | null): number => {
  if (ms === null) throw new Error('event missing');
  return Math.round((ms * FS) / 1000);
};
const perp = (w: Vec3): number => Math.hypot(w[1], w[2]);
const truePerp = (truth: SwingTruth): number[] => truth.series.omegaRacket.map(perp);
const contactS = (truth: SwingTruth): number => truth.contactTimeS * FS;

/** The follow-through end by its definition, applied to the noise-free truth. */
function trueFollowEnd(truth: SwingTruth): number {
  const p = truePerp(truth);
  const reference = p[truth.contactIndex - 1] ?? 0;
  return p.findIndex((v, i) => i >= truth.contactIndex && v < 0.3 * reference);
}

describe('phase timeline', () => {
  it('places contact half a sample before the impact sample', () => {
    const { features, truth } = run({});
    expect(features.phases.contactSample).toBe(truth.contactIndex - 1);
    expect(features.phases.contactMs).toBeCloseTo(truth.contactTimeS * 1000, 6);
  });

  it('orders ready end, forward start, contact, follow-through end and recovery', () => {
    const { features } = run({ backswingRateRadPerS: 6 });
    const p = features.phases;
    expect(p.readyEndMs).not.toBeNull();
    expect(p.readyEndMs ?? Infinity).toBeLessThan(p.forwardStartMs);
    expect(p.forwardStartMs).toBeLessThan(p.contactMs);
    expect(p.contactMs).toBeLessThan(p.followEndMs ?? -Infinity);
    expect(p.followEndMs ?? Infinity).toBeLessThan(p.recoveryEndMs ?? -Infinity);
  });

  it('ends the follow-through where ω⊥ falls below 30 % of its pre-impact value', () => {
    const { features, truth } = run({});
    expect(
      Math.abs(sample(features.phases.followEndMs) - trueFollowEnd(truth)),
    ).toBeLessThanOrEqual(1);
    // Analytic: 0.8 · 24 · exp(−t²/2σ²) = 0.3 · 24 with σ = 160 ms → t ≈ 224 ms.
    expectNear(features.brakingTimeMs, 224, SAMPLE_MS + 1);
  });

  it('ends the recovery at the start of the first 0.2 s standstill after the follow-through', () => {
    const { features, truth } = run({});
    const quiet = truth.series.omegaRacket.map((w) => norm(w) < 0.5);
    const followEnd = trueFollowEnd(truth);
    const run20 = Math.round(0.2 * FS);
    const expected = quiet.findIndex(
      (_, i) => i > followEnd && quiet.slice(i, i + run20).filter(Boolean).length === run20,
    );
    expect(Math.abs(sample(features.phases.recoveryEndMs) - expected)).toBeLessThanOrEqual(1);
    expectNear(features.recoveryMs, (expected - contactS(truth)) * SAMPLE_MS, SAMPLE_MS + 0.5);
  });

  it('times the forward swing from the start of the active phase', () => {
    // ω⊥ > 15 % of peak from σ·√(2 ln(1/0.15)) ≈ 175 ms before the peak (= contact).
    expectNear(run({}).features.forwardSwingMs, 175, SAMPLE_MS + 1);
  });

  it('reports no follow-through end or recovery when the capture stops early', () => {
    const short = { ...LONG_SETUP, durationS: LONG_SETUP.contactTimeS + 0.1 };
    const { features, metrics } = run({}, short);
    expect(metrics.impactDetected).toBe(true);
    expect(features.phases.followEndMs).toBeNull();
    expect(features.brakingTimeMs).toBeNull();
    expect(features.finishTipDeg).toBeNull();
    expect(features.phases.recoveryEndMs).toBeNull();
    expect(features.recoveryMs).toBeNull();
    expect(features.sigma.brakingTimeMs).toBeNull();
    expect(features.sigma.finishTipDeg).toBeNull();

    // Long enough for the follow-through end, too short for 0.2 s of stillness after it.
    const medium = run({}, { ...LONG_SETUP, durationS: LONG_SETUP.contactTimeS + 0.4 }).features;
    expect(medium.phases.followEndMs).not.toBeNull();
    expect(medium.phases.recoveryEndMs).toBeNull();
  });
});

describe('take-back', () => {
  /** Turn of 90° about the vertical, ending ≈ 0.3 s before forward-swing start. */
  const TURN: Partial<SwingSpec> = {
    takebackTurnDeg: 90,
    takebackTurnStartS: -0.85,
    takebackTurnDurationS: 0.45,
  };

  it('measures the rotation about the world vertical between ready end and forward start', () => {
    const { features, truth } = run(TURN);
    const from = sample(features.phases.readyEndMs);
    const to = sample(features.phases.forwardStartMs);
    const z = truth.series.omegaWorldZ;
    let trueTurn = 0;
    for (let i = from; i < to; i++) trueTurn += (0.5 * ((z[i] ?? 0) + (z[i + 1] ?? 0))) / FS;
    const trueTurnDeg = Math.abs(trueTurn) * (180 / Math.PI);
    // The turn itself, less the vertical share of the forward swing's onset.
    expect(trueTurnDeg).toBeGreaterThan(75);
    expectNear(features.takebackTurnDeg, trueTurnDeg, 2);
    expect(features.sigma.takebackTurnDeg).not.toBeNull();
  });

  it('reports almost no turn without one', () => {
    const turn = run({}).features.takebackTurnDeg;
    expect(turn).not.toBeNull();
    expect(turn ?? Infinity).toBeLessThan(10);
  });

  it('does not let a turn about the vertical change any elevation at contact', () => {
    const { metrics, truth } = run(TURN);
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, ANGLE_TOL_DEG);
  });

  it('reads tip and face elevation at forward-swing start', () => {
    const { features, truth } = run({ backswingRateRadPerS: 6, swingPathDeg: 35 });
    const at = sample(features.phases.forwardStartMs);
    expectNear(features.takebackTipDeg, truth.series.tipDeg[at] ?? NaN, ANGLE_TOL_DEG);
    expectNear(features.takebackFaceDeg, truth.series.faceDeg[at] ?? NaN, ANGLE_TOL_DEG);
  });

  it('times the take-back from the end of the ready position, like preparation time', () => {
    const { features, metrics } = run({ backswingRateRadPerS: 6 });
    expect(features.takebackTimeMs).not.toBeNull();
    expect(features.takebackTimeMs).toBe(metrics.preparationTimeMs);
    expect(features.sigma.takebackTimeMs).toBeCloseTo(timingSigmaMs(FS), 9);
  });
});

describe('forward swing', () => {
  /** G50 of the simulator's asymmetric Gaussian rate, from continuous time. */
  const trueG50 = (spec: SwingSpec): number => {
    const rate = (t: number): number => {
      const sigma = t < spec.peakOffsetS ? spec.riseSigmaS : spec.fallSigmaS;
      return Math.exp(-0.5 * ((t - spec.peakOffsetS) / sigma) ** 2);
    };
    return 1 - rate(-0.05) / rate(0);
  };

  it.each([{ peakOffsetS: 0 }, { peakOffsetS: 0.03 }, { peakOffsetS: -0.06 }])(
    'measures the late gain G50 (peak offset $peakOffsetS s)',
    (overrides) => {
      const { features, spec } = run(overrides);
      // Analysis reads ω⊥(t_c⁻) half a sample early: ≤ 2 % on the steepest swing.
      expectNear(features.lateGainFraction, trueG50(spec), 0.03);
    },
  );

  it('ranks a late-accelerating swing above an early one', () => {
    const late = run({ peakOffsetS: 0.03 }).features.lateGainFraction ?? NaN;
    const early = run({ peakOffsetS: -0.06 }).features.lateGainFraction ?? NaN;
    expect(late).toBeGreaterThan(0.2);
    expect(early).toBeLessThan(0);
  });

  it('withholds G50 without contact or when the gyro clipped', () => {
    expect(run({ withImpact: false }).features.lateGainFraction).toBeNull();
    const clipped = run({ peakRateRadPerS: 45 });
    expect(clipped.metrics.quality.gyroSaturated).toBe(true);
    expect(clipped.features.lateGainFraction).toBeNull();
    expect(clipped.features.sigma.headSpeedMps).toBeNull();
    expect(clipped.features.sigma.peakSpeedOffsetMs).toBeNull();
  });

  it('counts a hitch in the forward swing, and none in a smooth one', () => {
    expect(run({}).features.hitchCount).toBe(0);
    const hitch = { hitchDepth: 0.6, hitchAtS: -0.1, hitchWidthS: 0.015 };
    expect(run(hitch).features.hitchCount).toBe(1);
    const noisy = run({ ...hitch, noiseStd: { accelG: 0.01, gyroDps: 0.3 }, seed: 3 });
    expect(noisy.features.hitchCount).toBe(1);
  });

  it('counts each dip once even when its floor is noisy', () => {
    const rate = [1, 2, 3, 4, 2, 2.2, 2.1, 2.3, 5, 6, 7];
    expect(countHitches(rate, 0, rate.length - 1, 0.15)).toBe(1);
    const twoDips = [1, 2, 4, 2, 4, 6, 3, 6, 8];
    expect(countHitches(twoDips, 0, twoDips.length - 1, 0.15)).toBe(2);
  });
});

describe('contact', () => {
  it('measures the brush angle as swing path minus face tilt', () => {
    const { features, truth } = run({});
    expectNear(features.brushAngleDeg, truth.swingPathDeg - truth.faceTiltDeg, 1.5);
  });

  /** Mean of |dφ/dt| + |ωx| over the three pre-impact samples, from the truth series. */
  const trueStability = (truth: SwingTruth): number => {
    const face = truth.series.faceDeg;
    let sum = 0;
    for (let i = truth.contactIndex - 3; i < truth.contactIndex; i++) {
      const faceRate = (((face[i + 1] ?? NaN) - (face[i - 1] ?? NaN)) / 2) * FS;
      const roll = truth.series.omegaRacket[i]?.[0] ?? NaN;
      sum += Math.abs(faceRate) + Math.abs(roll) * (180 / Math.PI);
    }
    return sum / 3;
  };

  it('measures contact stability from face turning and roll', () => {
    const still = run({});
    const steady = still.features.contactStabilityDps ?? NaN;
    // Central differences of the truth are a coarse reference: 20 %.
    expect(steady / trueStability(still.truth)).toBeCloseTo(1, 0.7);
    const rolling = run({ rollRateRadPerS: 12 });
    expect(
      (rolling.features.contactStabilityDps ?? NaN) / trueStability(rolling.truth),
    ).toBeCloseTo(1, 0.7);
    // 12 rad/s of roll alone adds ≈ 690 deg/s.
    expect(rolling.features.contactStabilityDps ?? NaN).toBeGreaterThan(steady + 600);
  });
});

describe('finish', () => {
  it('reads tip elevation at the follow-through end', () => {
    const { features, truth } = run({});
    expectNear(features.finishTipDeg, truth.series.tipDeg[trueFollowEnd(truth)] ?? NaN, 1.5);
  });
});

describe('not assessable', () => {
  it('withholds attitude features without an anchor, keeping timing', () => {
    const { capture } = simulateSwing(DEFAULT_SWING, LONG_SETUP);
    const series = jiggleAboutVertical(toImuSeries(capture), 0.7, 0.2);
    const { features, metrics } = analyse(series, DEFAULT_SWING);
    expect(metrics.quality.anchorErrorG).toBeNull();
    for (const key of [
      'takebackTurnDeg',
      'takebackTipDeg',
      'takebackFaceDeg',
      'contactStabilityDps',
      'brushAngleDeg',
      'finishTipDeg',
    ] as const) {
      expect(features[key]).toBeNull();
    }
    for (const key of [
      'faceTiltDeg',
      'swingPathDeg',
      'tipElevationDeg',
      'brushAngleDeg',
      'takebackTipDeg',
      'finishTipDeg',
    ] as const) {
      expect(features.sigma[key]).toBeNull();
    }
    expect(features.lateGainFraction).not.toBeNull();
    expect(features.sigma.forwardSwingMs).toBeCloseTo(timingSigmaMs(FS), 9);
  });

  it('keeps the classification tip of a clipped overhead but marks its σ not assessable', () => {
    const { features, metrics } = run(
      { tipElevationDeg: 60, swingPathDeg: 0, peakRateRadPerS: 55 },
      SETUP,
    );
    expect(metrics.strokeType).toBe('overhead');
    expect(metrics.tipElevationDeg).toBeNull();
    expect(features.serve?.contactTipDeg ?? null).not.toBeNull();
    expect(features.serve?.contactTipReliable).toBe(false);
    expect(features.sigma.contactTipDeg).toBeNull();
    expect(features.sigma.faceTiltDeg).toBeNull();
    expect(features.serve?.rollSaturated).toBe(true);
  });

  it('has no serve features for groundstrokes', () => {
    expect(run({}).features.serve).toBeNull();
  });
});

describe('serve', () => {
  const SERVE: Partial<SwingSpec> = {
    ...SERVE_SWING,
    ...BUTT_CAP_MOUNT,
    // The off-centre jolt would add 9 rad/s of roll at the impact sample;
    // contact is found from a larger rate drop instead.
    impactRollKickRadPerS: 0,
    impactRateRetention: 0.7,
  };
  const serve = () => {
    const result = run(SERVE);
    const s = result.features.serve;
    if (!s) throw new Error('not classified as a serve');
    return { ...result, serve: s };
  };

  it('is classified as an overhead with a valid contact', () => {
    const { metrics, truth, serve: s } = serve();
    expect(metrics.strokeType).toBe('overhead');
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.referenceIndex).toBe(truth.contactIndex);
    expect(metrics.quality.gyroSaturated).toBe(false);
    // Known limitation of the contact extrapolation (not of the serve
    // features): at contact the serve tip is at the top of its arc, where
    // elevation is curved, so the linear half-sample extrapolation from the
    // two pre-impact samples overshoots by ≈ 3° at 28 rad/s.
    expectNear(s.contactTipDeg, truth.tipElevationDeg, 4);
    expect(s.contactTipDeg ?? NaN).toBeGreaterThan(truth.tipElevationDeg);
    expect(s.contactTipReliable).toBe(true);
  });

  it('finds the back-scratch drop and its timing', () => {
    const { features, truth, serve: s } = serve();
    const from = sample(features.phases.readyEndMs);
    const tips = truth.series.tipDeg.slice(from, truth.contactIndex);
    const lowest = Math.min(...tips);
    const lowestAt = from + tips.indexOf(lowest);
    expect(lowest).toBeLessThan(-60); // the tip really points down behind the back
    expectNear(s.dropTipDeg, lowest, ANGLE_TOL_DEG);
    expectNear(s.dropToContactMs, (contactS(truth) - lowestAt) * SAMPLE_MS, SAMPLE_MS + 0.5);
    expect(features.sigma.dropTipDeg).not.toBeNull();
  });

  it('reads the trophy tip at the slowest moment before the drop', () => {
    const { features, truth, serve: s } = serve();
    const readyEnd = sample(features.phases.readyEndMs);
    const tips = truth.series.tipDeg;
    const lowestAt = tips.indexOf(Math.min(...tips.slice(readyEnd, truth.contactIndex)));
    const from = Math.max(
      readyEnd,
      lowestAt - Math.round(DEFAULT_FEATURE_PARAMS.trophySearchS * FS),
    );
    const rates = truth.series.omegaRacket.slice(from, lowestAt).map(norm);
    const trophyAt = from + rates.indexOf(Math.min(...rates));
    expectNear(s.trophyTipDeg, tips[trophyAt] ?? NaN, 1.5);
  });

  it('measures pronation: roll peak, its timing and the roll angle after contact', () => {
    const { truth, serve: s } = serve();
    const peakDps = (SERVE.rollRateRadPerS ?? NaN) * (180 / Math.PI);
    expect(s.rollPeakDps / peakDps).toBeCloseTo(1, 1.5);
    expectNear(s.rollPeakOffsetMs, 20, SAMPLE_MS);
    const trueRoll = truth.rollAngleDeg(truth.contactTimeS, truth.contactTimeS + 0.1);
    expectNear(s.rollAngleDeg, trueRoll, 1);
    expect(s.rollSaturated).toBe(false);
  });

  it('flags the roll values as lower bounds when the gyro clipped around contact', () => {
    const spec = { ...DEFAULT_SWING, ...SERVE };
    const { capture, truth } = simulateSwing(spec, LONG_SETUP);
    const series = toImuSeries(capture);
    const clipped = {
      ...series,
      gyroSaturated: series.gyroSaturated.map((v, i) => v || i === truth.contactIndex + 5),
    };
    expect(analyse(clipped, spec).features.serve?.rollSaturated).toBe(true);
  });

  it('reports no roll angle when the capture ends within 100 ms of contact', () => {
    const short = { ...LONG_SETUP, durationS: LONG_SETUP.contactTimeS + 0.08 };
    const spec = { ...DEFAULT_SWING, ...SERVE };
    const { features } = analyse(toImuSeries(simulateSwing(spec, short).capture), spec);
    expect(features.serve?.rollAngleDeg).toBeNull();
  });
});

describe('uncertainty model', () => {
  it('derives anchor tilt σ from noise or from the gravity error, whichever is larger', () => {
    const quiet = { errorG: 0, accelStdG: [0.01, 0.01, 0.01] as Vec3, samples: 10 };
    expect(anchorSigmaRad(quiet)).toBeCloseTo(0.01 / Math.sqrt(10), 12);
    const biased = { ...quiet, errorG: 0.02 };
    expect(anchorSigmaRad(biased)).toBeCloseTo(Math.sqrt(0.04) / 3, 12);
  });

  it('grows with anchor gravity error', () => {
    const sigmas = [0, 0.005, 0.02, 0.05].map((errorG) =>
      anchorSigmaRad({ errorG, accelStdG: [0.005, 0.005, 0.005], samples: 10 }),
    );
    for (let i = 1; i < sigmas.length; i++) {
      expect(sigmas[i] ?? NaN).toBeGreaterThan(sigmas[i - 1] ?? NaN);
    }
  });

  it('grows with time since the anchor', () => {
    expect(driftSigmaDeg(0.5)).toBeCloseTo(0.5, 12);
    const { series, params } = run({});
    const kin = computeSwingKinematics(series, SKEWED_MOUNT, params);
    const anchor = kin.anchor?.index ?? NaN;
    const near = angleSigmaDeg(kin, params, anchor + 5) ?? NaN;
    const far = angleSigmaDeg(kin, params, anchor + 60) ?? NaN;
    expect(far).toBeGreaterThan(near);
    // Drift adds in quadrature: 55 samples ≈ 0.53 s at 1 deg/s.
    expect(Math.sqrt(far ** 2 - near ** 2)).toBeCloseTo(Math.sqrt(60 ** 2 - 5 ** 2) / FS, 6);
  });

  it('gives a later event a larger σ than an earlier one in the same stroke', () => {
    const { features } = run({ backswingRateRadPerS: 6 });
    expect(features.sigma.finishTipDeg ?? NaN).toBeGreaterThan(
      features.sigma.takebackTipDeg ?? NaN,
    );
  });

  it('covers the real error of a steady sideways acceleration during the anchor window', () => {
    const spec = DEFAULT_SWING;
    const { capture, truth } = simulateSwing(spec, LONG_SETUP);
    const clean = toImuSeries(capture);
    const perturbed = pushSideways(clean, 0.2, truth.contactIndex - 40);
    const before = analyse(clean, spec);
    const after = analyse(perturbed, spec);
    expect(after.metrics.quality.attitudeReliable).toBe(true);
    expect(after.metrics.quality.anchorErrorG ?? 0).toBeGreaterThan(0.015);
    const sigmaBefore = before.features.sigma.faceTiltDeg ?? NaN;
    const sigmaAfter = after.features.sigma.faceTiltDeg ?? NaN;
    expect(sigmaAfter).toBeGreaterThan(sigmaBefore + 2);
    const error = Math.abs((after.metrics.faceTiltDeg ?? NaN) - truth.faceTiltDeg);
    expect(error).toBeGreaterThan(2); // the perturbation really tilts the anchor
    expect(error).toBeLessThan(3 * sigmaAfter);
  });

  it('adds the model terms to swing path and head speed', () => {
    const { features, metrics } = run({});
    expect(features.sigma.swingPathDeg ?? NaN).toBeGreaterThan(3);
    expect(features.sigma.swingPathDeg ?? NaN).toBeGreaterThan(features.sigma.faceTiltDeg ?? NaN);
    expect(features.sigma.headSpeedMps).toBeCloseTo(0.15 * metrics.headSpeedMps, 9);
    expect(features.sigma.peakSpeedOffsetMs).toBeCloseTo(1000 / FS / Math.sqrt(12), 9);
    expect(timingSigmaMs(104)).toBeCloseTo(2.78, 2);
  });

  it('adds a timing term that grows with the angle rate at contact', () => {
    const still = run({}).features.sigma.faceTiltDeg ?? NaN;
    const rolling = run({ rollRateRadPerS: 15 }).features.sigma.faceTiltDeg ?? NaN;
    // 15 rad/s of roll turns the face at ≈ 700–860 deg/s near contact:
    // · 9.6 ms / √12 / 2 ≈ 1–1.2° of timing σ, added in quadrature.
    expect(Math.sqrt(rolling ** 2 - still ** 2)).toBeGreaterThan(0.8);
  });

  it('is not assessable when the gyro clipped too often since the anchor', () => {
    const { features, metrics } = run({ peakRateRadPerS: 55 }, SETUP);
    expect(metrics.quality.saturatedSamples).toBeGreaterThan(
      DEFAULT_ANALYSIS_PARAMS.maxSaturatedSamples,
    );
    expect(features.sigma.faceTiltDeg).toBeNull();
    expect(features.sigma.swingPathDeg).toBeNull();
  });
});

describe('helpers', () => {
  it('interpolates and integrates the piecewise-linear signal exactly', () => {
    const v = [0, 2, 4, 6];
    expect(interpolate(v, 1.25)).toBeCloseTo(2.5, 12);
    expect(integrateSamples(v, 0.5, 2.5)).toBeCloseTo(6, 12); // ∫ 2t dt from 0.5 to 2.5
  });
});

describe('existing metrics', () => {
  it('keep their values next to the features', () => {
    const { metrics, truth } = run({});
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, ANGLE_TOL_DEG);
    expect(metrics.features satisfies StrokeFeatures | undefined).toBeDefined();
  });
});

/**
 * Adds a steady specific force of `g` (in g) perpendicular to gravity to every
 * sample before `until`: the one anchor error a quiet window cannot reject.
 */
function pushSideways(series: ImuSeries, g: number, until: number): ImuSeries {
  const up = trueUpInRacket(series, 5);
  const sensorFromRacket = transpose(SKEWED_MOUNT.racketFromSensor);
  return {
    ...series,
    accel: series.accel.map((a, i) => {
      const u = up[i];
      if (i >= until || !u) return a;
      const side = normalize(cross(u, [1, 0, 0]));
      return add(a, mulVec(sensorFromRacket, scale(side, g * STANDARD_GRAVITY)));
    }),
  };
}
