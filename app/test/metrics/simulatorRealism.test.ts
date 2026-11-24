import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  type SwingSpec,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT, expectNear, racketFrame } from '../helpers';
import { STANDARD_GRAVITY } from '../../src/processing/units';
import { norm } from '../../src/math/vec3';
import type { RawCapture } from '../../src/domain/types';
import { CaptureAssembler } from '../../src/protocol/assembler';
import { SIMULATED_MOUNT, SimulatedTransport } from '../../src/transport/simulatedTransport';
import { immediateScheduler } from '../fakes';

/**
 * The simulator's optional departures from the ideal rigid lever, and the
 * systematic errors they leave in the analysis. Tolerances here document
 * known limitations; they are not accuracy claims for real strokes.
 */
function run(overrides: Partial<SwingSpec>) {
  const spec = { ...DEFAULT_SWING, ...overrides };
  const { capture, truth } = simulateSwing(spec, SETUP);
  const series = toImuSeries(capture);
  const metrics = analyzeSwing(series, SKEWED_MOUNT, {
    ...DEFAULT_ANALYSIS_PARAMS,
    leverRadiusM: spec.leverRadiusM,
  });
  return { series, metrics, truth };
}

describe('impact rate drop', () => {
  it('keeps about 80 % of the rate after contact', () => {
    const { series, truth } = run({});
    const { gyro } = racketFrame(series);
    const before = norm(gyro[truth.contactIndex - 1] ?? [0, 0, 0]);
    const after = norm(gyro[truth.contactIndex] ?? [0, 0, 0]);
    expect(after / before).toBeCloseTo(0.8, 1);
    const noDrop = racketFrame(run({ impactRateRetention: 1 }).series).gyro;
    expect(norm(noDrop[truth.contactIndex] ?? [0, 0, 0]) / before).toBeCloseTo(1, 1);
  });
});

describe('hand translation (centre of rotation moving)', () => {
  it('changes the accelerometer but not the gyro', () => {
    const still = run({}).series;
    const moving = run({ centreVelocityMps: [0, 0, 3] }).series;
    expect(moving.gyro).toEqual(still.gyro);
    expect(moving.accel).not.toEqual(still.accel);
  });

  it('documents the limitation: a rising hand makes the true path steeper than measured', () => {
    // The rigid-lever model sees only rotation. At 24 m/s of rotational head
    // speed, 3 m/s of upward hand velocity at contact adds ≈ 6–7° to the
    // true path, which the analysis cannot see.
    const { metrics, truth } = run({ centreVelocityMps: [0, 0, 3] });
    const pathError = (metrics.swingPathDeg ?? NaN) - truth.swingPathDeg;
    expect(pathError).toBeLessThan(-5.5);
    expect(pathError).toBeGreaterThan(-7.5);
    // Face tilt does not depend on velocity and stays accurate.
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, 1);
    // Speed misses the hand's share (|v| grows from 24 to ≈ 25.4 m/s).
    expect(metrics.headSpeedMps / truth.headSpeedMps).toBeCloseTo(0.94, 2);
  });

  it('scales roughly linearly with hand speed', () => {
    const error = (up: number): number => {
      const { metrics, truth } = run({ centreVelocityMps: [0, 0, up] });
      return (metrics.swingPathDeg ?? NaN) - truth.swingPathDeg;
    };
    expect(error(1)).toBeCloseTo(error(3) / 3, 0);
  });
});

describe('butt-cap mount', () => {
  const buttCap = (overrides: Partial<SwingSpec> = {}) => run({ ...BUTT_CAP_MOUNT, ...overrides });

  it('saturates the accelerometer in a fast swing but not the gyro', () => {
    // 34 rad/s at 0.2 m from the centre: ω²r ≈ 23.6 g > 16 g.
    const { series, metrics, truth } = buttCap({ peakRateRadPerS: 34 });
    expect(series.accelSaturated.some(Boolean)).toBe(true);
    expect(metrics.quality.gyroSaturated).toBe(false);
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.referenceIndex).toBe(truth.contactIndex);
    expectNear(metrics.faceTiltDeg, truth.faceTiltDeg, 1);
    expectNear(metrics.swingPathDeg, truth.swingPathDeg, 1);
    expect(metrics.headSpeedMps / truth.headSpeedMps).toBeCloseTo(1, 2);
  });

  it('stays below 16 g in a moderate swing', () => {
    // 24 rad/s at 0.2 m: ω²r ≈ 11.7 g.
    const { series } = buttCap();
    const peakG = Math.max(...series.accel.map((a) => norm(a) / STANDARD_GRAVITY));
    expect(series.accelSaturated.some(Boolean)).toBe(false);
    expect(peakG).toBeGreaterThan(10);
    expect(peakG).toBeLessThan(16);
  });

  it('finds contact from the rate drop even without an off-centre jolt', () => {
    // Engineering check only: the 6 g / 7 rad/s thresholds still need
    // confirming on recorded butt-cap data (docs/bring-up.md).
    expect(buttCap({ impactRollKickRadPerS: 0 }).metrics.impactDetected).toBe(true);
    expect(
      buttCap({ impactRollKickRadPerS: 0, impactRateRetention: 1 }).metrics.impactDetected,
    ).toBe(false);
  });

  it('does not mistake a fast shadow swing for contact', () => {
    for (const peakRateRadPerS of [24, 32, 38]) {
      expect(buttCap({ withImpact: false, peakRateRadPerS }).metrics.impactDetected).toBe(false);
    }
  });
});

describe('demo sensor', () => {
  it('produces sensible, rateable strokes from the butt-cap simulation', () => {
    const transport = new SimulatedTransport(4000, immediateScheduler, 11);
    const assembler = new CaptureAssembler(() => 0);
    const captures: RawCapture[] = [];
    transport.onPacket((p) => {
      for (const e of assembler.push(p)) if (e.type === 'capture') captures.push(e.capture);
    });
    for (let i = 0; i < 40; i++) transport.emitSwing();
    expect(captures).toHaveLength(40);
    for (const capture of captures) {
      const series = toImuSeries(capture);
      const m = analyzeSwing(series, SIMULATED_MOUNT);
      expect(m.impactDetected).toBe(true);
      expect(m.quality.attitudeReliable).toBe(true);
      expect(m.quality.gyroSaturated).toBe(false);
      expect(['forehand', 'backhand']).toContain(m.strokeType);
      expect(m.swingSize).toBe('full');
      // 20–30 rad/s × 0.72 m, lower when the demo swing peaked early.
      expect(m.headSpeedMps).toBeGreaterThan(5);
      expect(m.headSpeedMps).toBeLessThan(22);
      expect(m.peakSpeedOffsetMs).not.toBeNull();
    }
    // The fastest demo swings clip the accelerometer, as a real butt-cap sensor would.
    expect(captures.some((c) => toImuSeries(c).accelSaturated.some(Boolean))).toBe(true);
  });
});
