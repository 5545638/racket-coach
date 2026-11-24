import { describe, expect, it } from 'vitest';
import { analyzeCapture } from '../../src/app/pipeline';
import { INITIAL_COACH_STATE, coachStep } from '../../src/coach/coachEngine';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import type { RawCapture } from '../../src/domain/types';
import { DEFAULT_ANALYSIS_PARAMS } from '../../src/metrics/analyzeSwing';
import { SensorMode } from '../../src/protocol/constants';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  type SwingSpec,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';
import { motionFromSamples } from './firmwareHarness';
import { expectBitExact, startV2 } from './scenario';

/**
 * The whole v2 chain on one simulated stroke: swing model → LSM6DS3TR-C
 * register model at 416 Hz (M416) → the Espruino firmware → BLE with 10 %
 * of the notifications lost → app link (NAK/resend, CRC) → assemblerV2 →
 * M416 splice and analysis → rule cue, element assessment and coach.
 */
const SPEC: SwingSpec = {
  ...DEFAULT_SWING,
  ...BUTT_CAP_MOUNT,
  faceTiltDeg: -6,
  swingPathDeg: 18,
  backswingRateRadPerS: 6,
  takebackTurnDeg: 40,
  takebackTurnStartS: -0.9,
  peakOffsetS: -0.02,
};
/**
 * The truth is sampled 8× faster than the IMU's 416.7 Hz, so the IMU model
 * (which interpolates the motion at its own tick times) sees a sharp impact.
 */
const TRUTH_HZ = 8 * (1e6 / 2400);
const START_S = 3;

function deliver(lossRate: number): { capture: RawCapture; lost: number } {
  const { capture: input } = simulateSwing(SPEC, {
    ...SETUP,
    sampleRateHz: TRUTH_HZ,
    durationS: 3,
    contactTimeS: 2,
  });
  const s = startV2({
    mode: SensorMode.M416,
    ble: { seed: 21 },
    motion: motionFromSamples(input.samples, TRUTH_HZ, START_S),
  });
  s.fw.run(1000); // handshake on a clean link
  expect(s.link.version).toBe(2);
  s.fw.ble.lossRate = lossRate;
  s.fw.run(12000);
  expect(s.errors()).toEqual([]);
  const [capture, ...more] = s.captures();
  if (!capture) throw new Error('no capture');
  expect(more).toHaveLength(0);
  expectBitExact(capture, s.fw.imu.frames);
  return { capture, lost: s.fw.txLog.filter((r) => r.fate === 'lost').length };
}

describe('v2 end to end: firmware M416 → lossy BLE → assemblerV2 → analysis → coach', () => {
  it('recovers the stroke within tolerance and exactly as from a lossless link', () => {
    const { truth } = simulateSwing(SPEC, {
      ...SETUP,
      sampleRateHz: TRUTH_HZ,
      durationS: 3,
      contactTimeS: 2,
    });
    const lossy = deliver(0.1);
    const clean = deliver(0);
    expect(lossy.lost).toBeGreaterThan(5);
    expect(clean.lost).toBe(0);
    expect(lossy.capture.mode).toBe('M416');
    expect(lossy.capture.gyroHr?.data.length).toBe(31 * 12);

    const params = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: SPEC.leverRadiusM };
    const analyse = (c: RawCapture) => analyzeCapture(c, SKEWED_MOUNT, params, DEFAULT_RULES);
    const a = analyse(lossy.capture);
    const b = analyse(clean.capture);
    // Identical to the lossless capture: resends are bit-exact.
    expect(a).toEqual(b);
    const step = coachStep(INITIAL_COACH_STATE, a.assessment);
    expect(step).toEqual(coachStep(INITIAL_COACH_STATE, b.assessment));

    // Within tolerance of the simulator truth.
    const m = a.metrics;
    expect(m.impactDetected).toBe(true);
    expect(m.quality.highRate?.contactMeasured).toBe(true);
    expect(m.quality.signalGap).toBe(false);
    expect(Math.abs((m.faceTiltDeg ?? NaN) - truth.faceTiltDeg)).toBeLessThan(1.5);
    expect(Math.abs((m.swingPathDeg ?? NaN) - truth.swingPathDeg)).toBeLessThan(1.5);
    expect(Math.abs((m.tipElevationDeg ?? NaN) - truth.tipElevationDeg)).toBeLessThan(1.5);
    expect(Math.abs(m.headSpeedMps / truth.headSpeedMps - 1)).toBeLessThan(0.01);
    expect(Math.abs((m.peakSpeedOffsetMs ?? NaN) - SPEC.peakOffsetS * 1000)).toBeLessThan(5);
    expect(m.features?.sigma.peakSpeedOffsetMs).toBeLessThan(1);
    // The coach rates the stroke and decides something.
    expect(a.assessment.contact).toBe(true);
    expect(['correction', 'good', 'silent', 'keep-it', 'better']).toContain(step.utterance.kind);
  });
});
