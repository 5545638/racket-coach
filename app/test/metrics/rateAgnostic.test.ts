import { describe, expect, it } from 'vitest';
import type { StrokeMetrics } from '../../src/domain/types';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  type SwingSpec,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';

/**
 * The same stroke sampled at 104, 208 and 416 Hz must give the same metrics:
 * every per-sample threshold is expressed per reference interval (1/104 s)
 * or in seconds. Tolerances are one 104 Hz sample for times and what the
 * coarser sampling of contact costs for angles.
 */
const RATES = [104, 208, 416] as const;
const LONG = { ...SETUP, durationS: 2.4, contactTimeS: 1.6 };

function analyse(spec: SwingSpec, fs: number) {
  const { capture, truth } = simulateSwing(spec, { ...LONG, sampleRateHz: fs });
  const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT, {
    ...DEFAULT_ANALYSIS_PARAMS,
    leverRadiusM: spec.leverRadiusM,
  });
  return { metrics, truth };
}

const SAMPLE_104_MS = 1000 / 104;

function compare(spec: SwingSpec): void {
  const runs = RATES.map((fs) => analyse(spec, fs));
  const base = runs[0];
  if (!base) throw new Error('no run');
  const f0 = base.metrics.features;
  for (const { metrics: m, truth } of runs) {
    const f = m.features;
    expect(m.impactDetected).toBe(true);
    expect(m.quality.attitudeReliable).toBe(true);
    expect(m.strokeType).toBe(base.metrics.strokeType);
    expect(m.swingSize).toBe(base.metrics.swingSize);
    // Against the truth: angles and speed.
    expect(Math.abs((m.faceTiltDeg ?? NaN) - truth.faceTiltDeg)).toBeLessThan(1);
    expect(Math.abs((m.swingPathDeg ?? NaN) - truth.swingPathDeg)).toBeLessThan(1);
    expect(Math.abs(m.headSpeedMps / truth.headSpeedMps - 1)).toBeLessThan(0.01);
    expect(Math.abs((f?.phases.contactMs ?? NaN) - truth.contactTimeS * 1000)).toBeLessThan(
      SAMPLE_104_MS / 2 + 0.1,
    );
    // Against 104 Hz: timing within one 104 Hz sample, arcs within 3°.
    const near = (a: number | null | undefined, b: number | null | undefined, tol: number) => {
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(Math.abs((a ?? NaN) - (b ?? NaN))).toBeLessThan(tol);
    };
    const t = SAMPLE_104_MS + 1;
    const bm: StrokeMetrics = base.metrics;
    near(m.peakSpeedOffsetMs, bm.peakSpeedOffsetMs, t);
    near(m.peakAccelerationOffsetMs, bm.peakAccelerationOffsetMs, t);
    near(m.preparationTimeMs, bm.preparationTimeMs, t);
    near(m.backswingPauseMs, bm.backswingPauseMs, t);
    near(m.backswingArcDeg, bm.backswingArcDeg, 3);
    near(m.forwardSwingArcDeg, bm.forwardSwingArcDeg, 3);
    near(m.followThroughArcDeg, bm.followThroughArcDeg, 3);
    near(m.racketDropDeg, bm.racketDropDeg, 1);
    near(f?.forwardSwingMs, f0?.forwardSwingMs, t);
    near(f?.brakingTimeMs, f0?.brakingTimeMs, t);
    near(f?.recoveryMs, f0?.recoveryMs, t);
    near(f?.takebackTurnDeg, f0?.takebackTurnDeg, 3);
    near(f?.lateGainFraction, f0?.lateGainFraction, 0.02);
    near(f?.contactStabilityDps, f0?.contactStabilityDps, 25);
    expect(f?.hitchCount).toBe(f0?.hitchCount);
    expect(f?.phases.list?.map((p) => p.name)).toEqual(f0?.phases.list?.map((p) => p.name));
  }
}

describe('rate-agnostic analysis (104, 208, 416 Hz)', () => {
  it('gives the same metrics for a forehand with backswing, take-back turn and roll', () => {
    compare({
      ...DEFAULT_SWING,
      backswingRateRadPerS: 6,
      takebackTurnDeg: 60,
      takebackTurnStartS: -0.8,
      rollRateRadPerS: 5,
    });
  });

  it('gives the same metrics on the butt-cap mount with its weak impact transient', () => {
    compare({ ...DEFAULT_SWING, ...BUTT_CAP_MOUNT, backswingRateRadPerS: 6, peakRateRadPerS: 26 });
  });

  it('counts the same hitch at every rate', () => {
    for (const fs of RATES) {
      const { metrics } = analyse(
        { ...DEFAULT_SWING, hitchDepth: 0.6, hitchAtS: -0.1, hitchWidthS: 0.015 },
        fs,
      );
      expect(metrics.features?.hitchCount).toBe(1);
    }
  });

  it('finds the contact of a hit and none in a shadow swing at every rate', () => {
    for (const fs of RATES) {
      expect(
        analyse({ ...DEFAULT_SWING, withImpact: false, peakRateRadPerS: 38 }, fs).metrics
          .impactDetected,
      ).toBe(false);
      const { metrics, truth } = analyse({ ...DEFAULT_SWING, ...BUTT_CAP_MOUNT }, fs);
      expect(metrics.referenceIndex).toBe(truth.contactIndex);
    }
  });

  it('allows the same clipped time, not the same number of clipped samples', () => {
    // Clipping that withholds angles at 104 Hz withholds them at 416 Hz too
    // (away from the boundary, where one 104 Hz sample decides).
    for (const peakRateRadPerS of [40, 55]) {
      const verdicts = RATES.map(
        (fs) => analyse({ ...DEFAULT_SWING, peakRateRadPerS }, fs).metrics.quality.attitudeReliable,
      );
      expect(new Set(verdicts).size).toBe(1);
    }
  });
});
