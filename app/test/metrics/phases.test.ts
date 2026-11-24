import { describe, expect, it } from 'vitest';
import type { StrokePhaseName } from '../../src/domain/types';
import { type Vec3, norm } from '../../src/math/vec3';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { DEFAULT_FEATURE_PARAMS } from '../../src/metrics/features';
import { toImuSeries } from '../../src/processing/units';
import {
  DEFAULT_SWING,
  type SimulationSetup,
  type SwingSpec,
  type SwingTruth,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';

const P = DEFAULT_ANALYSIS_PARAMS;
const STEP_S = 0.0002;

/**
 * The phase boundaries evaluated on the noise-free, continuous truth with the
 * same definitions the analysis uses on samples (s; null when outside).
 */
function truthPhases(truth: SwingTruth, durationS: number) {
  const ts: number[] = [];
  for (let t = 0; t <= durationS; t += STEP_S) ts.push(t);
  const omega: Vec3[] = ts.map((t) => truth.omegaAt(t));
  const rate = omega.map((w) => norm(w));
  const perp = omega.map((w) => Math.hypot(w[1], w[2]));
  const contact = Math.floor(truth.contactTimeS / STEP_S);
  let peak = 0;
  for (let i = 0; i <= contact; i++) if ((perp[i] ?? 0) > (perp[peak] ?? 0)) peak = i;
  // Forward start: start of the run above 15 % of the peak that holds the peak.
  let fwd = peak;
  while (fwd > 0 && (perp[fwd - 1] ?? 0) > P.activeFraction * (perp[peak] ?? 0)) fwd--;
  // Ready end: end of the last ≥ 0.3 s standstill before the forward start.
  const minRun = Math.round(P.readyMinS / STEP_S);
  let ready: number | null = null;
  let run = 0;
  for (let i = fwd; i >= 0; i--) {
    if ((rate[i] ?? 0) < P.quietRateRadPerS) {
      run++;
      if (run >= minRun) {
        ready = i + run;
        break;
      }
    } else run = 0;
  }
  const from = ready ?? 0;
  let maxPrep = 0;
  for (let i = from; i < fwd; i++) maxPrep = Math.max(maxPrep, rate[i] ?? 0);
  const threshold = Math.max(P.quietRateRadPerS, P.backswingStartFraction * maxPrep);
  let backswing: number | null = null;
  for (let i = from; i <= fwd; i++) {
    if ((rate[i] ?? 0) >= threshold) {
      backswing = i === 0 ? null : i;
      break;
    }
  }
  const before = perp[contact - 1] ?? 0;
  let follow: number | null = null;
  for (let i = contact + 1; i < perp.length; i++) {
    if ((perp[i] ?? Infinity) < DEFAULT_FEATURE_PARAMS.followEndFraction * before) {
      follow = i;
      break;
    }
  }
  const s = (i: number | null): number | null => (i === null ? null : i * STEP_S);
  return {
    readyEnd: s(ready),
    backswingStart: s(backswing),
    forwardStart: s(fwd),
    contact: truth.contactTimeS,
    followEnd: s(follow),
  };
}

function analyse(spec: Partial<SwingSpec>, setup: SimulationSetup) {
  const full = { ...DEFAULT_SWING, ...spec };
  const { capture, truth } = simulateSwing(full, setup);
  const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT, {
    ...P,
    leverRadiusM: full.leverRadiusM,
  });
  const features = metrics.features;
  if (!features) throw new Error('no features');
  return { phases: features.phases, truth: truthPhases(truth, setup.durationS) };
}

/** An analysis event (ms) lies at the first sample at or after the true crossing. */
function expectAtOrAfter(actualMs: number | null | undefined, truthS: number | null, fs: number) {
  expect(actualMs).not.toBeNull();
  expect(truthS).not.toBeNull();
  const d = (actualMs ?? NaN) - (truthS ?? NaN) * 1000;
  expect(d).toBeGreaterThan(-1.5);
  expect(d).toBeLessThan(1000 / fs + 1.5);
}

const TAKEBACK: Partial<SwingSpec> = {
  backswingRateRadPerS: 6,
  backswingLeadS: 0.45,
  takebackTurnDeg: 70,
  takebackTurnStartS: -0.9,
  takebackTurnDurationS: 0.5,
};
const LONG = { ...SETUP, durationS: 2.4, contactTimeS: 1.6 };

describe('labelled stroke phases', () => {
  it.each([104, 416])('lands every boundary within one sample of the truth (%i Hz)', (fs) => {
    const { phases, truth } = analyse(TAKEBACK, { ...LONG, sampleRateHz: fs });
    expectAtOrAfter(phases.readyEndMs, truth.readyEnd, fs);
    expectAtOrAfter(phases.backswingStartMs, truth.backswingStart, fs);
    expectAtOrAfter(phases.forwardStartMs, truth.forwardStart, fs);
    expectAtOrAfter(phases.followEndMs, truth.followEnd, fs);
    expect(Math.abs(phases.contactMs - truth.contact * 1000)).toBeLessThan(500 / fs + 0.01);
    // The take-back turn starts the preparation well before the backswing proper.
    expect((truth.backswingStart ?? 0) - (truth.readyEnd ?? 0)).toBeGreaterThan(0.05);

    const list = phases.list ?? [];
    const names: StrokePhaseName[] = [
      'preparation',
      'backswing',
      'forwardAcceleration',
      'contact',
      'followThrough',
    ];
    expect(list.map((p) => p.name)).toEqual(names);
    // Contiguous, in order, none truncated.
    for (let k = 1; k < list.length; k++) {
      expect(list[k]?.startMs).toBeCloseTo(list[k - 1]?.endMs ?? NaN, 9);
    }
    expect(list.every((p) => !p.truncatedStart && !p.truncatedEnd)).toBe(true);
    expect(list[0]?.startMs).toBe(phases.readyEndMs);
    expect(list[1]?.startMs).toBe(phases.backswingStartMs);
    expect(list[2]?.startMs).toBe(phases.forwardStartMs);
    // Contact: ±1 sample around the contact time.
    expect(list[3]?.startMs).toBeCloseTo(phases.contactMs - 1000 / fs, 9);
    expect(list[3]?.endMs).toBeCloseTo(phases.contactMs + 1000 / fs, 9);
    expect(list[4]?.endMs).toBe(phases.followEndMs);
  });

  it('marks the preparation as truncated when the capture starts during it', () => {
    // The take-back turn is already under way at the first sample: no ready position.
    const setup = { ...SETUP, sampleRateHz: 208 };
    const { phases, truth } = analyse({ ...TAKEBACK, takebackTurnStartS: -0.95 }, setup);
    expect(phases.readyEndMs).toBeNull();
    expect(truth.readyEnd).toBeNull();
    const prep = phases.list?.[0];
    expect(prep?.name).toBe('preparation');
    expect(prep?.truncatedStart).toBe(true);
    expect(prep?.startMs).toBe(0);
    expectAtOrAfter(phases.backswingStartMs, truth.backswingStart, 208);
    expect(phases.list?.[1]?.truncatedStart).toBe(false);
  });

  it('starts with a truncated backswing when the capture starts inside it', () => {
    const setup = { ...SETUP, durationS: 1, contactTimeS: 0.32 };
    const { phases, truth } = analyse({ backswingRateRadPerS: 6, backswingLeadS: 0.3 }, setup);
    expect(truth.backswingStart).toBeNull();
    expect(phases.backswingStartMs).toBeNull();
    const list = phases.list ?? [];
    expect(list[0]?.name).toBe('backswing');
    expect(list[0]?.truncatedStart).toBe(true);
    expect(list.some((p) => p.name === 'preparation')).toBe(false);
  });

  it('marks the follow-through as truncated when the capture ends during it', () => {
    const setup = { ...SETUP, durationS: 1.0, contactTimeS: 0.9 };
    const { phases } = analyse({}, setup);
    expect(phases.followEndMs).toBeNull();
    const last = phases.list?.at(-1);
    expect(last?.name).toBe('followThrough');
    expect(last?.truncatedEnd).toBe(true);
  });

  it('keeps preparation and backswing short when the forward swing grows straight out of the ready position', () => {
    const { phases } = analyse({}, LONG);
    expect(phases.list?.some((p) => p.name === 'backswing')).toBe(true);
    const prep = phases.list?.find((p) => p.name === 'preparation');
    const back = phases.list?.find((p) => p.name === 'backswing');
    expect(
      (prep?.endMs ?? 0) - (prep?.startMs ?? 0) + (back?.endMs ?? 0) - (back?.startMs ?? 0),
    ).toBeLessThan(300);
  });
});
