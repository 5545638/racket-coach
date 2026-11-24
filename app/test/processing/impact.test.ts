import { describe, expect, it } from 'vitest';
import type { ImuSeries } from '../../src/domain/types';
import { type Vec3, add } from '../../src/math/vec3';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { detectImpact } from '../../src/processing/segmentation';
import { STANDARD_GRAVITY, toImuSeries } from '../../src/processing/units';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  type SwingSpec,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';

function simulate(spec: Partial<SwingSpec>, fs = 104) {
  const full = { ...DEFAULT_SWING, ...BUTT_CAP_MOUNT, ...spec };
  const { capture, truth } = simulateSwing(full, { ...SETUP, sampleRateHz: fs });
  return { series: toImuSeries(capture), truth, lever: full.leverRadiusM };
}

const analyse = (series: ImuSeries, lever = BUTT_CAP_MOUNT.leverRadiusM) =>
  analyzeSwing(series, SKEWED_MOUNT, { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: lever });

/** Adds `extra(i)` (g, sensor frame) to the specific force; flags stay as simulated. */
const withAccel = (series: ImuSeries, extra: (i: number) => Vec3): ImuSeries => ({
  ...series,
  accel: series.accel.map((a, i) =>
    add(a, extra(i).map((g) => g * STANDARD_GRAVITY) as unknown as Vec3),
  ),
});

/** Index of the sample with the largest racket rate (‖ω‖ in the sensor frame suffices here). */
const peakSample = (series: ImuSeries): number =>
  series.gyro.reduce(
    (b, w, i, all) => (Math.hypot(...w) > Math.hypot(...(all[b] ?? [0, 0, 0])) ? i : b),
    0,
  );

describe('impact detection robustness', () => {
  it.each([104, 208, 416])('finds no contact in shadow swings at %i Hz', (fs) => {
    for (const peakRateRadPerS of [24, 32, 38]) {
      expect(
        analyse(simulate({ withImpact: false, peakRateRadPerS }, fs).series).impactDetected,
      ).toBe(false);
      const head = simulate({ ...DEFAULT_SWING, withImpact: false, peakRateRadPerS }, fs);
      expect(analyse(head.series, 1).impactDetected).toBe(false);
    }
  });

  it.each([104, 416])('finds the contact sample of a butt-cap hit at %i Hz', (fs) => {
    const { series, truth } = simulate({}, fs);
    expect(analyse(series).referenceIndex).toBe(truth.contactIndex);
  });

  it('ignores frame vibration in the accelerometer: no contact in a shadow swing, the right one in a hit', () => {
    // 5 g at ≈ 150 Hz (aliased at 104 Hz): sample-to-sample jumps up to 10 g, no rotation.
    const vibration = (i: number): Vec3 => {
      const v = 5 * Math.sin(i * 2.9);
      return [v, -0.5 * v, 0.7 * v];
    };
    const shadow = simulate({ withImpact: false, peakRateRadPerS: 30 });
    expect(analyse(withAccel(shadow.series, vibration)).impactDetected).toBe(false);
    const hit = simulate({});
    const m = analyse(withAccel(hit.series, vibration));
    expect(m.impactDetected).toBe(true);
    expect(m.referenceIndex).toBe(hit.truth.contactIndex);
  });

  it('ignores a ground bounce: an accelerometer transient without a rate drop', () => {
    const { series } = simulate({ withImpact: false, peakRateRadPerS: 28 });
    const peak = peakSample(series);
    // Near the peak (inside the search window) and far after it.
    for (const at of [peak + 4, peak + 20]) {
      const bounce = (i: number): Vec3 => (i === at || i === at + 1 ? [0, 0, 12] : [0, 0, 0]);
      expect(analyse(withAccel(series, bounce)).impactDetected).toBe(false);
    }
  });

  it('finds a hit while the accelerometer is clipped, from the rate drop and jolt', () => {
    // 34 rad/s at 0.2 m: ω²r ≈ 24 g, so the accelerometer clips up to
    // contact; every accelerometer jump into contact involves a clipped sample.
    const { series, truth } = simulate({ peakRateRadPerS: 34 });
    const c = truth.contactIndex;
    expect(series.accelSaturated.slice(c - 4, c).every(Boolean)).toBe(true);
    expect(series.gyroSaturated.some(Boolean)).toBe(false);
    const m = analyse(series);
    expect(m.impactDetected).toBe(true);
    expect(m.referenceIndex).toBe(c);
  });

  it('reports no contact, without angles, when both channels are clipped around it', () => {
    // 38 rad/s: the accelerometer clips through contact and the gyro up to it,
    // so neither the transient nor the rate drop can place the hit.
    const { series, truth } = simulate({ peakRateRadPerS: 38 });
    const c = truth.contactIndex;
    expect(series.accelSaturated.slice(c - 2, c + 2).every(Boolean)).toBe(true);
    expect(series.gyroSaturated[c - 1]).toBe(true);
    const m = analyse(series);
    expect(m.impactDetected).toBe(false);
    expect(m.quality.attitudeReliable).toBe(false);
    expect(m.faceTiltDeg).toBeNull();
  });

  it('does not take a clipped accelerometer jump alone as contact', () => {
    const { series } = simulate({ withImpact: false, peakRateRadPerS: 34 });
    const peak = peakSample(series);
    // A rail-to-rail flip of one clipped axis, as an overloaded part might report.
    const flipped: ImuSeries = {
      ...series,
      accel: series.accel.map((a, i) => (i === peak + 2 ? [-a[0], a[1], a[2]] : a)),
      accelSaturated: series.accelSaturated.map((s, i) => s || i === peak + 2),
    };
    expect(analyse(flipped).impactDetected).toBe(false);
  });

  it('takes the onset of the hit, not an unrelated transient before it (refractory window)', () => {
    const { series, truth } = simulate({});
    const c = truth.contactIndex;
    // A strong but unconfirmed accelerometer transient 5 samples (48 ms) before contact.
    const early = (i: number): Vec3 => (i === c - 5 ? [0, 0, 15] : [0, 0, 0]);
    expect(analyse(withAccel(series, early)).referenceIndex).toBe(c);
  });

  it('keeps the v1 behaviour of detectImpact when no v2 options are given', () => {
    const accel: Vec3[] = Array.from({ length: 20 }, (_, i) => [
      0,
      0,
      i === 10 ? 20 * STANDARD_GRAVITY : 0,
    ]);
    const gyro: Vec3[] = Array.from({ length: 20 }, () => [0, 0, 0]);
    expect(detectImpact(accel, gyro, 10, 5, { accelG: 6, gyroRadPerS: 7 })).toBe(10);
    // With consistency required, the same accel-only transient is rejected.
    expect(
      detectImpact(accel, gyro, 10, 5, {
        accelG: 6,
        gyroRadPerS: 7,
        confirmFraction: 0.25,
        detrendGyro: true,
      }),
    ).toBeNull();
  });
});
