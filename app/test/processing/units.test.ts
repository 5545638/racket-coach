import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../../src/domain/types';
import { RAD_TO_DEG } from '../../src/math/vec3';
import {
  ACCEL_SATURATION_COUNTS,
  ACCEL_SENSITIVITY_MG_PER_LSB,
  DEFAULT_ACCEL_RANGE_G,
  DEFAULT_GYRO_RANGE_DPS,
  GYRO_SATURATION_COUNTS,
  GYRO_SENSITIVITY_MDPS_PER_LSB,
  STANDARD_GRAVITY,
  gyroSaturationCounts,
  toImuSeries,
} from '../../src/processing/units';

const capture = (rows: readonly (readonly number[])[]): RawCapture => ({
  kind: 'swing',
  sequence: 0,
  sampleRateHz: 104,
  accelGPerLsb: 0.000488,
  gyroDpsPerLsb: 0.07,
  triggerIndex: 0,
  samples: Int16Array.from(rows.flat()),
  receivedAt: 0,
});

describe('saturation flags', () => {
  it('flags the gyro below its nominal ±2000 dps full scale, not at the int16 limit', () => {
    expect(GYRO_SATURATION_COUNTS * 0.07).toBeLessThan(2000);
    const s = toImuSeries(
      capture([
        [0, 0, 0, GYRO_SATURATION_COUNTS - 1, 0, 0],
        [0, 0, 0, 0, -GYRO_SATURATION_COUNTS, 0],
        [0, 0, 0, 0, 0, 28571], // 2000 dps exactly
      ]),
    );
    expect(s.gyroSaturated).toEqual([false, true, true]);
    expect(s.accelSaturated).toEqual([false, false, false]);
  });

  it('keeps the accelerometer threshold just below the int16 limit', () => {
    expect(ACCEL_SATURATION_COUNTS).toBe(32767 - 64);
    const s = toImuSeries(
      capture([
        [GYRO_SATURATION_COUNTS, 0, 0, 0, 0, 0], // a large but valid acceleration
        [0, -ACCEL_SATURATION_COUNTS, 0, 0, 0, 0],
      ]),
    );
    expect(s.accelSaturated).toEqual([false, true]);
    expect(s.gyroSaturated).toEqual([false, false]);
  });
});

describe('ranges (protocol v2 capture header)', () => {
  const v2 = (rows: readonly (readonly number[])[], extra: Partial<RawCapture>): RawCapture => ({
    ...capture(rows),
    ...extra,
  });

  it('uses the datasheet sensitivity of the configured range, not the header per-LSB value', () => {
    // Header still says ±16 g / ±2000 dps per LSB; the range fields win.
    const s = toImuSeries(v2([[1000, 0, 0, 1000, 0, 0]], { gyroRangeDps: 500, accelRangeG: 4 }));
    expect((s.gyro[0]?.[0] ?? 0) * RAD_TO_DEG).toBeCloseTo(17.5, 9); // 17.5 mdps/LSB
    expect((s.accel[0]?.[0] ?? 0) / STANDARD_GRAVITY).toBeCloseTo(0.122, 9); // 0.122 mg/LSB
  });

  it.each([
    [125, 4.375],
    [250, 8.75],
    [500, 17.5],
    [1000, 35],
    [2000, 70],
  ])(
    'gyro ±%i dps: %f mdps/LSB, clipped from 98 percent of the nominal full scale',
    (range, mdps) => {
      expect(GYRO_SENSITIVITY_MDPS_PER_LSB[range]).toBe(mdps);
      // The nominal full scale is 28571 counts at every range, so the threshold is too.
      expect(gyroSaturationCounts(range)).toBe(28000);
      const s = toImuSeries(
        v2(
          [
            [0, 0, 0, 27999, 0, 0],
            [0, 0, 0, 28000, 0, 0],
          ],
          { gyroRangeDps: range },
        ),
      );
      expect(s.gyroSaturated).toEqual([false, true]);
      expect((s.gyroClipRadPerS ?? 0) * RAD_TO_DEG).toBeCloseTo(28000 * mdps * 1e-3, 6);
    },
  );

  it.each([
    [2, 0.061],
    [4, 0.122],
    [8, 0.244],
    [16, 0.488],
  ])('accel ±%i g: %f mg/LSB, clipped near the int16 limit at every range', (range, mg) => {
    expect(ACCEL_SENSITIVITY_MG_PER_LSB[range]).toBe(mg);
    const s = toImuSeries(
      v2(
        [
          [ACCEL_SATURATION_COUNTS - 1, 0, 0, 0, 0, 0],
          [ACCEL_SATURATION_COUNTS, 0, 0, 0, 0, 0],
        ],
        { accelRangeG: range },
      ),
    );
    expect(s.accelSaturated).toEqual([false, true]);
  });

  it('defaults to the v1 configuration (±16 g, ±2000 dps) without range fields', () => {
    expect(DEFAULT_GYRO_RANGE_DPS).toBe(2000);
    expect(DEFAULT_ACCEL_RANGE_G).toBe(16);
    const rows = [[100, -200, 300, 1000, -2000, 3000]];
    expect(toImuSeries(capture(rows)).gyro).toEqual(
      toImuSeries(v2(rows, { gyroRangeDps: 2000, accelRangeG: 16 })).gyro,
    );
    expect(GYRO_SATURATION_COUNTS).toBe(gyroSaturationCounts(2000));
  });

  it('rejects a range the part does not have, and timestamps that do not match the samples', () => {
    expect(() => toImuSeries(v2([[0, 0, 0, 0, 0, 0]], { gyroRangeDps: 300 }))).toThrow(RangeError);
    expect(() => toImuSeries(v2([[0, 0, 0, 0, 0, 0]], { accelRangeG: 3 }))).toThrow(RangeError);
    expect(() => toImuSeries(v2([[0, 0, 0, 0, 0, 0]], { sampleTimesUs: [0, 1] }))).toThrow(
      RangeError,
    );
  });

  it('passes timestamps, wrap and the lost-sample count on, and keeps v1 series free of them', () => {
    const s = toImuSeries(
      v2([[0, 0, 0, 0, 0, 0]], {
        sampleTimesUs: Uint32Array.of(5),
        sampleTimesWrapUs: 99,
        droppedSamples: 2,
      }),
    );
    expect(s.sampleTimesUs).toEqual([5]);
    expect(s.sampleTimesWrapUs).toBe(99);
    expect(s.droppedSamples).toBe(2);
    const v1 = toImuSeries(capture([[0, 0, 0, 0, 0, 0]]));
    expect(v1.sampleTimesUs).toBeUndefined();
    expect(v1.droppedSamples).toBeUndefined();
  });
});
