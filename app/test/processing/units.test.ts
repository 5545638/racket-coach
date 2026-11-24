import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../../src/domain/types';
import {
  ACCEL_SATURATION_COUNTS,
  GYRO_SATURATION_COUNTS,
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
