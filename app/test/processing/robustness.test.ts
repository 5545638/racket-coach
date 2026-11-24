import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import { isRateable, selectCue } from '../../src/coaching/rules';
import { assessStroke } from '../../src/elements/assess';
import type { MountCalibration, RawCapture, StrokeMetrics } from '../../src/domain/types';
import { mul } from '../../src/math/mat3';
import { DEG_TO_RAD } from '../../src/math/vec3';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import { createRandom } from '../../src/simulation/random';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  SENSOR_GYRO_DPS_PER_LSB,
  type SimulationSetup,
  type SwingSpec,
  type SwingTruth,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT, V2_TIMESTAMPS, removeSamples, rotationMatrix } from '../helpers';

/**
 * Robustness of the signal path (docs/metrics.md, "Signal path v2"). The
 * stroke is the real butt-cap mount with a backswing and a take-back turn.
 * The rule everywhere: a metric is either withheld (null, not assessable,
 * or the stroke not rated) or within tolerance; never confidently wrong.
 */
const SPEC: SwingSpec = {
  ...DEFAULT_SWING,
  ...BUTT_CAP_MOUNT,
  backswingRateRadPerS: 6,
  takebackTurnDeg: 60,
  takebackTurnStartS: -0.9,
};
const LONG: SimulationSetup = { ...SETUP, durationS: 2.4, contactTimeS: 1.6 };
const v2 = (fs: number): SimulationSetup => ({
  ...LONG,
  sampleRateHz: fs,
  timestamps: V2_TIMESTAMPS,
});

const analyse = (capture: RawCapture, mount: MountCalibration = SKEWED_MOUNT): StrokeMetrics =>
  analyzeSwing(toImuSeries(capture), mount, {
    ...DEFAULT_ANALYSIS_PARAMS,
    leverRadiusM: SPEC.leverRadiusM,
  });

interface Tolerance {
  readonly angleDeg: number;
  readonly speedFraction: number;
  readonly timeMs: number;
}
const TOL: Tolerance = { angleDeg: 2, speedFraction: 0.03, timeMs: 1000 / 104 + 1 };

/**
 * Never confidently wrong: every value that is reported with a σ lies within
 * max(tolerance, 3σ) of the truth; a value without σ only on unrated strokes;
 * a clipped speed is a lower bound. Timing is compared with the clean capture.
 */
function expectHonest(
  m: StrokeMetrics,
  truth: SwingTruth,
  clean: StrokeMetrics,
  tol: Tolerance = TOL,
): void {
  const sigma = m.features?.sigma;
  const rated = isRateable(m);
  const angle = (value: number | null, truthDeg: number, s: number | null | undefined) => {
    if (value === null) return;
    if (s === null || s === undefined) {
      expect(rated).toBe(false);
      return;
    }
    expect(Math.abs(value - truthDeg)).toBeLessThanOrEqual(Math.max(tol.angleDeg, 3 * s));
  };
  angle(m.faceTiltDeg, truth.faceTiltDeg, sigma?.faceTiltDeg);
  angle(m.swingPathDeg, truth.swingPathDeg, sigma?.swingPathDeg);
  angle(m.tipElevationDeg, truth.tipElevationDeg, sigma?.tipElevationDeg);
  if (m.quality.gyroSaturated) {
    expect(m.headSpeedMps).toBeLessThanOrEqual(truth.headSpeedMps * 1.01);
  } else if (rated) {
    const s = sigma?.headSpeedMps ?? 0;
    expect(Math.abs(m.headSpeedMps - truth.headSpeedMps)).toBeLessThanOrEqual(
      Math.max(tol.speedFraction * truth.headSpeedMps, 3 * s),
    );
  }
  const time = (value: number | null | undefined, reference: number | null | undefined) => {
    if (value === null || value === undefined || reference === null || reference === undefined)
      return;
    expect(Math.abs(value - reference)).toBeLessThanOrEqual(tol.timeMs);
  };
  // Times are measured to contact; without a detected contact they refer to
  // the peak and the stroke is not rated, so they are not held to the truth.
  if (m.impactDetected) {
    time(m.peakSpeedOffsetMs, clean.peakSpeedOffsetMs);
    time(m.preparationTimeMs, clean.preparationTimeMs);
  }
  if (rated) {
    time(m.features?.forwardSwingMs, clean.features?.forwardSwingMs);
    expect(m.impactDetected).toBe(true);
  }
}

/** Adds `counts` to gyro axis `axis` from sample `from` on (a bias step). */
function gyroStep(capture: RawCapture, from: number, axis: number, counts: number): RawCapture {
  const samples = Int16Array.from(capture.samples);
  for (let i = from; i < samples.length / 6; i++) {
    samples[i * 6 + 3 + axis] = (samples[i * 6 + 3 + axis] ?? 0) + counts;
  }
  return { ...capture, samples };
}

describe('sensor clipping', () => {
  it.each([104, 416])(
    'gyro clipped at 2000 dps (%i Hz): reconstructed, bounded or withheld',
    (fs) => {
      for (const peakRateRadPerS of [38, 42, 46, 50]) {
        const setup = { ...v2(fs), gyroClipCounts: 28571 };
        const { capture, truth } = simulateSwing({ ...SPEC, peakRateRadPerS }, setup);
        const clean = analyse(simulateSwing({ ...SPEC, peakRateRadPerS }, v2(fs)).capture);
        const m = analyse(capture);
        expect(m.quality.saturatedSamples).toBeGreaterThan(0);
        expectHonest(m, truth, clean, { ...TOL, timeMs: 1000 / 104 + 6 });
      }
    },
  );

  it.each([104, 416])(
    'accelerometer clipped through contact (%i Hz): contact and angles kept',
    (fs) => {
      for (const peakRateRadPerS of [30, 34]) {
        const { capture, truth } = simulateSwing({ ...SPEC, peakRateRadPerS }, v2(fs));
        const m = analyse(capture);
        expect(toImuSeries(capture).accelSaturated.some(Boolean)).toBe(true);
        expect(isRateable(m)).toBe(true);
        expect(m.referenceIndex).toBe(truth.contactIndex);
        expectHonest(m, truth, m, { ...TOL, angleDeg: 1 });
      }
    },
  );
});

describe('packet loss and dropped samples', () => {
  it.each([104, 208, 416])('scattered losses of 1, 3 and 10 samples (%i Hz)', (fs) => {
    const { capture, truth } = simulateSwing(SPEC, v2(fs));
    const clean = analyse(capture);
    const n = capture.samples.length / 6;
    let rated = 0;
    for (const k of [1, 3, 10]) {
      for (let seed = 1; seed <= 6; seed++) {
        const random = createRandom(seed * 31 + k);
        const lost = Array.from({ length: k }, () => Math.floor(random() * n));
        const m = analyse(removeSamples(capture, lost));
        expectHonest(m, truth, clean);
        if (isRateable(m)) rated++;
      }
    }
    // Most strokes survive scattered single losses.
    expect(rated).toBeGreaterThan(6);
  });

  it.each([104, 208, 416])('blocks of 1, 3 and 10 samples around contact (%i Hz)', (fs) => {
    const { capture, truth } = simulateSwing(SPEC, v2(fs));
    const clean = analyse(capture);
    const c = truth.contactIndex;
    for (const k of [1, 3, 10]) {
      for (let offset = -4; offset <= 2; offset++) {
        const lost = Array.from({ length: k }, (_, j) => c + offset + j);
        const m = analyse(removeSamples(capture, lost));
        expectHonest(m, truth, clean);
        // Losing the samples where contact is read never leaves a rated stroke.
        if (offset <= 0 && offset + k > -2) expect(isRateable(m)).toBe(false);
      }
    }
  });

  it('a long block in the ready position costs nothing (the anchor moves)', () => {
    const { capture, truth } = simulateSwing(SPEC, v2(104));
    const clean = analyse(capture);
    const m = analyse(
      removeSamples(
        capture,
        Array.from({ length: 10 }, (_, j) => 30 + j),
      ),
    );
    expect(isRateable(m)).toBe(true);
    expect(m.quality.timebase?.maxGapSamples).toBe(10);
    expectHonest(m, truth, clean, { ...TOL, angleDeg: 1 });
  });

  it('v1 capture with lost samples that cannot be located: nothing is rated or angled', () => {
    const { capture } = simulateSwing(SPEC, LONG);
    const m = analyse({ ...removeSamples(capture, [50]), droppedSamples: 1 });
    expect(m.quality.signalGap).toBe(true);
    expect(isRateable(m)).toBe(false);
    expect(m.faceTiltDeg).toBeNull();
    expect(m.preparationTimeMs).toBeNull();
    expect(m.quality.timebase?.droppedSamples).toBe(1);
    // Downstream: no rule cue, every element "signal-gap", no baseline entry.
    expect(selectCue(m, DEFAULT_RULES).severity).toBe('none');
    const assessment = assessStroke(m, EMPTY_BASELINE);
    expect(assessment.elements.every((e) => e.reason === 'signal-gap')).toBe(true);
  });
});

describe('noisy measurements', () => {
  it.each([104, 416])('white noise at 2× and 5× the datasheet density (%i Hz)', (fs) => {
    const sigmas: number[] = [];
    for (const factor of [0, 2, 5]) {
      const spec = {
        ...SPEC,
        noiseDensity: { accelUgPerRtHz: 130 * factor, gyroMdpsPerRtHz: 5 * factor },
        seed: 5,
      };
      const { capture, truth } = simulateSwing(spec, v2(fs));
      const m = analyse(capture);
      expect(isRateable(m)).toBe(true);
      expectHonest(m, truth, m, { ...TOL, angleDeg: 1.5 });
      sigmas.push(m.features?.sigma.faceTiltDeg ?? NaN);
    }
    // The anchor's noise term makes σ grow with the noise.
    expect(sigmas[1] ?? 0).toBeGreaterThan(sigmas[0] ?? Infinity);
    expect(sigmas[2] ?? 0).toBeGreaterThan(sigmas[1] ?? Infinity);
  });

  it('a gyro bias step early in the ready position: re-estimated away, or σ covers it', () => {
    const { capture, truth } = simulateSwing(SPEC, v2(104));
    const clean = analyse(capture);
    const cleanSigma = clean.features?.sigma.faceTiltDeg ?? 0;
    for (const dps of [3, 8]) {
      const counts = Math.round(dps / SENSOR_GYRO_DPS_PER_LSB);
      // The step at 0.05 s, early in the 0.7 s ready position: every still
      // window before the anchor carries the new bias.
      const m = analyse(gyroStep(capture, 5, 1, counts));
      if (dps <= DEFAULT_ANALYSIS_PARAMS.biasMaxDps) {
        // Version 6: the residual is measured on the anchor's still window and removed.
        expect(m.quality.gyroBiasCorrectionDps ?? 0).toBeCloseTo(dps, 0);
        expect(m.features?.sigma.faceTiltDeg ?? 0).toBeLessThan(cleanSigma * 1.2);
        expectHonest(m, truth, clean, { ...TOL, angleDeg: 0.5 });
      } else {
        // Implausibly large for bias: kept, and the measured residual widens σ.
        expect(m.quality.gyroBiasCorrectionDps).toBe(0);
        expect(m.features?.sigma.faceTiltDeg ?? 0).toBeGreaterThan(cleanSigma * 1.5);
        expectHonest(m, truth, clean, { ...TOL, angleDeg: 1 });
      }
    }
  });
});

describe('timing errors', () => {
  it.each([104, 416])('±5 percent clock error with timestamps: corrected (%i Hz)', (fs) => {
    const clean = analyse(simulateSwing(SPEC, v2(fs)).capture);
    for (const factor of [0.95, 1.05]) {
      const { capture, truth } = simulateSwing(SPEC, {
        ...v2(fs),
        sampleRateHz: fs * factor,
        reportedRateHz: fs,
      });
      const m = analyse(capture);
      expect((m.quality.timebase?.measuredRateHz ?? 0) / fs).toBeCloseTo(factor, 3);
      expect(isRateable(m)).toBe(true);
      expectHonest(m, truth, clean, { ...TOL, angleDeg: 2, speedFraction: 0.01 });
    }
  });

  it('±5 percent clock error without timestamps (v1): durations scale by the error (documented)', () => {
    const clean = analyse(simulateSwing(SPEC, LONG).capture);
    for (const factor of [0.95, 1.05]) {
      const { capture, truth } = simulateSwing(SPEC, {
        ...LONG,
        sampleRateHz: 104 * factor,
        reportedRateHz: 104,
      });
      const m = analyse(capture);
      // Durations are counted in samples of the reported rate, so they come out
      // scaled by true/reported rate (≈ ±5 %); angles move by up to ≈ 2°.
      const prep = (m.preparationTimeMs ?? NaN) / (clean.preparationTimeMs ?? NaN);
      expect(Math.abs(prep - factor)).toBeLessThan(0.02);
      expect(Math.abs((m.tipElevationDeg ?? NaN) - truth.tipElevationDeg)).toBeLessThan(2.5);
      expect(Math.abs((m.faceTiltDeg ?? NaN) - truth.faceTiltDeg)).toBeLessThan(1);
    }
  });

  it.each([104, 416])('jitter of ±150 µs: measured and absorbed (%i Hz)', (fs) => {
    const random = createRandom(9);
    const jitter = Array.from({ length: 2000 }, () => (random() - 0.5) * 300e-6);
    const { capture, truth } = simulateSwing(SPEC, {
      ...v2(fs),
      sampleTimeS: (i) => i / fs + (jitter[i] ?? 0),
    });
    const clean = analyse(simulateSwing(SPEC, v2(fs)).capture);
    const m = analyse(capture);
    expect(m.quality.timebase?.jitterUs).toBeGreaterThan(80);
    expect(m.quality.timebase?.jitterUs).toBeLessThan(160);
    expect(isRateable(m)).toBe(true);
    expectHonest(m, truth, clean, { ...TOL, angleDeg: 1, speedFraction: 0.01 });
  });

  it('timestamp wrap mid-capture changes nothing', () => {
    const plain = analyse(simulateSwing(SPEC, v2(208)).capture);
    const wrapped = analyse(
      simulateSwing(SPEC, {
        ...v2(208),
        timestamps: { ...V2_TIMESTAMPS, startUs: 2 ** 32 - 1_000_000 },
      }).capture,
    );
    expect(wrapped).toEqual(plain);
  });
});

describe('calibration errors', () => {
  const rotated = (axis: readonly [number, number, number], deg: number): MountCalibration => ({
    ...SKEWED_MOUNT,
    racketFromSensor: mul(rotationMatrix(axis, deg * DEG_TO_RAD), SKEWED_MOUNT.racketFromSensor),
  });

  it.each([
    ['x (long axis): face tilt', [1, 0, 0], 'faceTiltDeg'],
    ['z (face normal): tip elevation', [0, 0, 1], 'tipElevationDeg'],
  ] as const)(
    'mount rotated about %s takes the full rotation (σ cannot see it)',
    (_, axis, key) => {
      const { capture, truth } = simulateSwing(SPEC, v2(104));
      const clean = analyse(capture);
      for (const deg of [2, 5, 10]) {
        const m = analyse(capture, rotated(axis, deg));
        const error = Math.abs((m[key] ?? NaN) - truth[key]);
        expect(error).toBeGreaterThan(deg - 1);
        expect(error).toBeLessThan(deg + 1);
        // The uncertainty model has no calibration term: σ is unchanged.
        expect(m.features?.sigma[key]).toBeCloseTo(clean.features?.sigma[key] ?? NaN, 1);
      }
    },
  );

  it('mount rotated about y (in-plane) moves tip elevation by about a fifth of the rotation', () => {
    const { capture, truth } = simulateSwing(SPEC, v2(104));
    for (const deg of [2, 5, 10]) {
      const m = analyse(capture, rotated([0, 1, 0], deg));
      expect(Math.abs((m.tipElevationDeg ?? NaN) - truth.tipElevationDeg)).toBeLessThan(
        0.25 * deg + 0.5,
      );
      expect(Math.abs((m.faceTiltDeg ?? NaN) - truth.faceTiltDeg)).toBeLessThan(1);
      expect(Math.abs(m.headSpeedMps / truth.headSpeedMps - 1)).toBeLessThan(0.01);
    }
  });

  const wrongBias = (dps: number): MountCalibration => {
    const d = (dps * DEG_TO_RAD) / Math.sqrt(3);
    const b = SKEWED_MOUNT.gyroBias;
    return { ...SKEWED_MOUNT, gyroBias: [b[0] + d, b[1] + d, b[2] + d] };
  };
  const angleErrors = (m: StrokeMetrics, truth: SwingTruth): number[] => [
    Math.abs((m.faceTiltDeg ?? NaN) - truth.faceTiltDeg),
    Math.abs((m.swingPathDeg ?? NaN) - truth.swingPathDeg),
    Math.abs((m.tipElevationDeg ?? NaN) - truth.tipElevationDeg),
  ];

  it('a wrong gyro bias of 1 and 3 deg/s is re-estimated per capture: < 0.5° instead of ≈ 2°', () => {
    const { capture, truth } = simulateSwing(SPEC, v2(104));
    const clean = analyse(capture);
    const noReestimation = {
      ...DEFAULT_ANALYSIS_PARAMS,
      leverRadiusM: SPEC.leverRadiusM,
      biasMaxDps: 0,
    };
    for (const dps of [1, 3]) {
      const m = analyse(capture, wrongBias(dps));
      expect(m.quality.gyroBiasCorrectionDps ?? 0).toBeCloseTo(dps, 0);
      for (const e of angleErrors(m, truth)) expect(e).toBeLessThan(0.5);
      // σ is back at the model value (the measured residual is gone).
      expect(m.features?.sigma.faceTiltDeg).toBeCloseTo(
        clean.features?.sigma.faceTiltDeg ?? NaN,
        1,
      );
      expectHonest(m, truth, clean, { ...TOL, angleDeg: 0.5 });
      // Without re-estimation (analysis version 5) the drift stays in the angles.
      const old = analyzeSwing(toImuSeries(capture), wrongBias(dps), noReestimation);
      expect(old.quality.gyroBiasCorrectionDps).toBe(0);
      if (dps === 3) expect(Math.max(...angleErrors(old, truth))).toBeGreaterThan(1.5);
    }
  });

  it('a wrong gyro bias at or above the 5 deg/s limit is kept and widens σ', () => {
    const { capture, truth } = simulateSwing(SPEC, v2(104));
    const clean = analyse(capture);
    for (const dps of [5, 8]) {
      const m = analyse(capture, wrongBias(dps));
      expect(m.quality.gyroBiasCorrectionDps).toBe(0);
      expect(m.features?.sigma.faceTiltDeg ?? 0).toBeGreaterThan(3); // ≈ dps × 0.9 s
      expectHonest(m, truth, clean, { ...TOL, angleDeg: 0.5 });
      expect(Math.abs((m.tipElevationDeg ?? NaN) - truth.tipElevationDeg)).toBeLessThanOrEqual(
        3 * (m.features?.sigma.tipElevationDeg ?? 0),
      );
    }
  });
});
