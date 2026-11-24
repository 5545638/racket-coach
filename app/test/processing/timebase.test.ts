import { describe, expect, it } from 'vitest';
import type { ImuSeries } from '../../src/domain/types';
import type { Vec3 } from '../../src/math/vec3';
import {
  DEFAULT_TIMEBASE_PARAMS,
  estimateTimebase,
  resampleUniform,
  unwrapTimes,
} from '../../src/processing/timebase';
import { conditionSeries } from '../../src/processing/condition';

/** A series whose gyro x and accel x both equal f(t) at the given sample times (µs). */
function series(
  timesUs: readonly number[] | undefined,
  f: (tS: number) => number,
  n?: number,
  fs = 104,
): ImuSeries {
  const count = timesUs?.length ?? n ?? 0;
  const t = (i: number): number =>
    (timesUs ? (timesUs[i] ?? 0) - (timesUs[0] ?? 0) : (i * 1e6) / fs) / 1e6;
  const v = (i: number): Vec3 => [f(t(i)), 0, 0];
  return {
    sampleRateHz: fs,
    accel: Array.from({ length: count }, (_, i) => v(i)),
    gyro: Array.from({ length: count }, (_, i) => v(i)),
    accelSaturated: new Array<boolean>(count).fill(false),
    gyroSaturated: new Array<boolean>(count).fill(false),
    triggerIndex: 0,
    ...(timesUs ? { sampleTimesUs: timesUs } : {}),
  };
}

const NO_FLAGS = { reconstructed: [], unrecovered: [] } as const;
/** Uniform timestamps at `fs`, quantised to the IMU's 25 µs LSB. */
const stamps = (n: number, fs = 104, startUs = 0): number[] =>
  Array.from({ length: n }, (_, i) => startUs + Math.round((i * 1e6) / fs / 25) * 25);

describe('timestamp unwrapping', () => {
  it('removes a uint32 µs wrap', () => {
    const start = 2 ** 32 - 15_000;
    const raw = [0, 1, 2, 3].map((i) => (start + i * 9615) % 2 ** 32);
    expect(unwrapTimes(raw)).toEqual([0, 9615, 19230, 28845]);
  });

  it('removes the wrap of a 24-bit counter at 25 µs reported in µs', () => {
    const wrap = 2 ** 24 * 25;
    const raw = [wrap - 10_000, (wrap - 10_000 + 9600) % wrap, (wrap - 10_000 + 19200) % wrap];
    expect(unwrapTimes(raw, wrap)).toEqual([0, 9600, 19200]);
  });
});

describe('timebase estimate', () => {
  it('measures the rate and the 25 µs quantisation jitter of uniform timestamps', () => {
    const est = estimateTimebase(stamps(200), 104);
    expect(est.measuredRateHz).toBeCloseTo(104, 1);
    expect(est.gaps).toEqual([]);
    // Two 25 µs roundings per interval: ≈ 25/√6 ≈ 10 µs RMS.
    expect(est.jitterUs).toBeLessThan(20);
  });

  it.each([0.95, 1.05])('detects a clock running at %f × nominal', (factor) => {
    const est = estimateTimebase(stamps(300, 104 * factor), 104);
    expect(est.measuredRateHz / 104).toBeCloseTo(factor, 3);
    expect(est.gaps).toEqual([]);
  });

  it('locates missing samples by intervals longer than 1.5 × the median', () => {
    const t = stamps(100).filter((_, i) => i !== 10 && !(i >= 40 && i < 43));
    const est = estimateTimebase(t, 104);
    expect(est.gaps.map((g) => [g.after, g.missing])).toEqual([
      [9, 1],
      [38, 3],
    ]);
    expect(est.measuredRateHz).toBeCloseTo(104, 1);
    expect(DEFAULT_TIMEBASE_PARAMS.gapFactor).toBe(1.5);
  });
});

describe('resampling onto the nominal grid', () => {
  it('leaves a v1 series without timestamps unchanged', () => {
    const s = series(undefined, (t) => Math.sin(5 * t), 50);
    const u = resampleUniform(s, NO_FLAGS);
    expect(u.series.gyro).toBe(s.gyro);
    expect(u.quality).toEqual({
      timestamped: false,
      measuredRateHz: 104,
      maxGapSamples: 0,
      jitterUs: 0,
      interpolatedSamples: 0,
      gapSamples: 0,
      droppedSamples: 0,
    });
    expect(u.gap.some(Boolean)).toBe(false);
  });

  it('marks every sample as missing when samples were lost and cannot be located', () => {
    const s = { ...series(undefined, () => 0, 20), droppedSamples: 3 };
    const u = resampleUniform(s, NO_FLAGS);
    expect(u.gap.every(Boolean)).toBe(true);
    expect(u.quality.gapSamples).toBe(20);
    expect(u.quality.droppedSamples).toBe(3);
  });

  it('corrects a clock error: values land at their true times on the nominal grid', () => {
    // True rate 5 % high; the signal is linear in time, so interpolation is exact.
    const t = stamps(200, 104 * 1.05);
    const u = resampleUniform(
      series(t, (x) => 3 * x),
      NO_FLAGS,
    );
    const n = u.series.gyro.length;
    expect(n).toBe(Math.floor(((t[199] ?? 0) * 104) / 1e6 + 0.05) + 1);
    u.series.gyro.forEach((w, k) => {
      expect(w[0]).toBeCloseTo((3 * k) / 104, 9);
    });
    expect(u.quality.measuredRateHz).toBeCloseTo(109.2, 0);
    expect(u.interpolated.some(Boolean)).toBe(false);
  });

  it('bridges one missing sample by interpolation and flags it', () => {
    const t = stamps(60).filter((_, i) => i !== 30);
    const u = resampleUniform(
      series(t, (x) => 2 * x),
      NO_FLAGS,
    );
    expect(u.series.gyro).toHaveLength(60);
    expect(u.interpolated.flatMap((f, i) => (f ? [i] : []))).toEqual([30]);
    expect(u.gap.some(Boolean)).toBe(false);
    expect(u.series.gyro[30]?.[0]).toBeCloseTo(60 / 104, 3);
    expect(u.quality.interpolatedSamples).toBe(1);
    expect(u.quality.maxGapSamples).toBe(1);
  });

  it('bridges up to 10 ms at any rate: one sample at 104 Hz, four at 416 Hz', () => {
    const missing = (fs: number, k: number): readonly boolean[] => {
      const t = stamps(200, fs).filter((_, i) => i < 100 || i >= 100 + k);
      const u = resampleUniform(
        series(t, () => 0, undefined, fs),
        NO_FLAGS,
      );
      return u.gap;
    };
    expect(missing(104, 1).some(Boolean)).toBe(false);
    expect(missing(104, 2).some(Boolean)).toBe(true);
    expect(missing(416, 4).some(Boolean)).toBe(false);
    expect(missing(416, 5).some(Boolean)).toBe(true);
  });

  it('marks a long gap as missing data instead of inventing values', () => {
    const t = stamps(80).filter((_, i) => i < 40 || i >= 45);
    const u = resampleUniform(
      series(t, (x) => x),
      NO_FLAGS,
    );
    expect(u.gap.flatMap((f, i) => (f ? [i] : []))).toEqual([40, 41, 42, 43, 44]);
    expect(u.quality.gapSamples).toBe(5);
    expect(u.quality.maxGapSamples).toBe(5);
  });

  it('carries saturation flags to interpolated samples that draw on a clipped one', () => {
    const t = stamps(10, 104 * 1.05);
    const s = { ...series(t, () => 0), gyroSaturated: t.map((_, i) => i === 5) };
    const u = resampleUniform(s, NO_FLAGS);
    const flagged = u.series.gyroSaturated.flatMap((f, i) => (f ? [i] : []));
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged.length).toBeLessThanOrEqual(2);
    for (const k of flagged)
      expect(Math.abs((k * 1e6) / 104 - (t[5] ?? 0))).toBeLessThan(1e6 / 104);
  });

  it('is idempotent through conditionSeries', () => {
    const c = conditionSeries(series(stamps(30), (x) => x));
    expect(conditionSeries(c)).toBe(c);
    expect(c.timebase.timestamped).toBe(true);
  });
});
