import type { ImuSeries, RawCapture } from '../domain/types';
import { type Vec3, DEG_TO_RAD } from '../math/vec3';
import { AXES_PER_SAMPLE, CaptureFlag } from '../protocol/constants';

/** Standard gravity, m/s². */
export const STANDARD_GRAVITY = 9.80665;

/**
 * LSM6DS3TR-C gyroscope sensitivity per full scale, mdps/LSB (datasheet,
 * Table 3 "Mechanical characteristics", G_So).
 */
export const GYRO_SENSITIVITY_MDPS_PER_LSB: Readonly<Record<number, number>> = {
  125: 4.375,
  250: 8.75,
  500: 17.5,
  1000: 35,
  2000: 70,
};

/**
 * LSM6DS3TR-C accelerometer sensitivity per full scale, mg/LSB (datasheet,
 * Table 3, LA_So).
 */
export const ACCEL_SENSITIVITY_MG_PER_LSB: Readonly<Record<number, number>> = {
  2: 0.061,
  4: 0.122,
  8: 0.244,
  16: 0.488,
};

/** Full scales the v1 firmware configures, and the defaults when a capture does not say. */
export const DEFAULT_GYRO_RANGE_DPS = 2000;
export const DEFAULT_ACCEL_RANGE_G = 16;

/**
 * Share of the nominal gyro full scale at which a sample counts as clipped.
 * Engineering choice (see `gyroSaturationCounts`).
 */
export const GYRO_SATURATION_FRACTION = 0.98;

/**
 * Gyro counts at or beyond which a sample is treated as clipped, for the
 * full scale `rangeDps`: nominal full-scale counts × 0.98.
 *
 * At every LSM6DS3TR-C range the nominal full scale is the same count,
 * range / sensitivity = 28571 (e.g. 2000 / 0.070, 125 / 0.004375), well short of
 * the int16 limit (32767 counts ≈ 2293 dps at ±2000 dps). Where the part
 * really stops responding between those two values is not specified, so a
 * threshold near the int16 limit could miss clipping anywhere between 2000
 * and ~2290 dps. 0.98 × 28571 = 28000 counts (1960 dps at ±2000 dps) sits
 * just below the nominal full scale: it may flag a few unclipped samples,
 * never miss a clipped one. Engineering choice; the real clip point must be
 * measured during bring-up (docs/bring-up.md) and this value adjusted.
 */
export function gyroSaturationCounts(rangeDps: number = DEFAULT_GYRO_RANGE_DPS): number {
  const sensitivity = GYRO_SENSITIVITY_MDPS_PER_LSB[rangeDps];
  if (sensitivity === undefined) throw new RangeError(`Unsupported gyro range ±${rangeDps} dps`);
  return Math.round(((rangeDps * 1000) / sensitivity) * GYRO_SATURATION_FRACTION);
}

/** Gyro clip threshold at the default ±2000 dps: 28000 counts (1960 dps). */
export const GYRO_SATURATION_COUNTS = gyroSaturationCounts(DEFAULT_GYRO_RANGE_DPS);

/**
 * Accelerometer counts at or beyond this magnitude are treated as clipped. At
 * every LSM6DS3TR-C range the nominal full scale fills the int16 range
 * (e.g. 16 / 0.000488 ≈ 32787 counts), so clipping shows up at the int16
 * limits whatever the range; 64 counts of margin is an engineering choice.
 */
export const ACCEL_SATURATION_COUNTS = 32767 - 64;

/**
 * Full scale for each sensitivity a v2 sensor can report as an exact integer
 * (BEGIN_B carries mdps/LSB and µg/LSB as u16). The datasheet sensitivities
 * of the other gyro ranges (4.375, 8.75, 17.5 mdps/LSB) are not integers and
 * cannot be sent; the firmware uses ±2000 dps (70) and ±16 g (488).
 */
export const GYRO_RANGE_BY_MDPS_PER_LSB: Readonly<Record<number, number>> = { 35: 1000, 70: 2000 };
export const ACCEL_RANGE_BY_UG_PER_LSB: Readonly<Record<number, number>> = {
  61: 2,
  122: 4,
  244: 8,
  488: 16,
};

/** Thrown for a capture whose header cannot be interpreted; the capture is not analysed. */
export class CaptureRejectedError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureRejectedError';
  }
}

/**
 * Configured ranges of a capture: explicit `gyroRangeDps`/`accelRangeG`, or
 * derived from the v2 header sensitivities (70 mdps/LSB → ±2000 dps, 488 µg/LSB
 * → ±16 g). An unknown sensitivity, or one that contradicts an explicit range,
 * rejects the capture: guessing a scale would make every metric silently wrong.
 */
export function captureRanges(capture: RawCapture): {
  readonly gyroRangeDps: number | undefined;
  readonly accelRangeG: number | undefined;
} {
  const derive = (
    value: number | undefined,
    table: Readonly<Record<number, number>>,
    explicit: number | undefined,
    what: string,
  ): number | undefined => {
    if (value === undefined) return explicit;
    const range = table[value];
    if (range === undefined) {
      throw new CaptureRejectedError(`Capture rejected: unknown ${what} sensitivity ${value}`);
    }
    if (explicit !== undefined && explicit !== range) {
      throw new CaptureRejectedError(
        `Capture rejected: ${what} sensitivity ${value} contradicts range ±${explicit}`,
      );
    }
    return range;
  };
  return {
    gyroRangeDps: derive(
      capture.gyroMdpsPerLsb,
      GYRO_RANGE_BY_MDPS_PER_LSB,
      capture.gyroRangeDps,
      'gyro (mdps/LSB)',
    ),
    accelRangeG: derive(
      capture.accelUgPerLsb,
      ACCEL_RANGE_BY_UG_PER_LSB,
      capture.accelRangeG,
      'accelerometer (µg/LSB)',
    ),
  };
}

/** Scale factors actually used for a capture: from the ranges when present, else the header's per-LSB values. */
export function captureScales(capture: RawCapture): {
  readonly accelGPerLsb: number;
  readonly gyroDpsPerLsb: number;
  readonly gyroClipCounts: number;
} {
  const ranges = captureRanges(capture);
  let accelGPerLsb = capture.accelGPerLsb;
  if (ranges.accelRangeG !== undefined) {
    const mg = ACCEL_SENSITIVITY_MG_PER_LSB[ranges.accelRangeG];
    if (mg === undefined) throw new RangeError(`Unsupported accel range ±${ranges.accelRangeG} g`);
    accelGPerLsb = mg / 1000;
  }
  let gyroDpsPerLsb = capture.gyroDpsPerLsb;
  if (ranges.gyroRangeDps !== undefined) {
    const mdps = GYRO_SENSITIVITY_MDPS_PER_LSB[ranges.gyroRangeDps];
    if (mdps === undefined)
      throw new RangeError(`Unsupported gyro range ±${ranges.gyroRangeDps} dps`);
    gyroDpsPerLsb = mdps / 1000;
  }
  return {
    accelGPerLsb,
    gyroDpsPerLsb,
    gyroClipCounts: gyroSaturationCounts(ranges.gyroRangeDps ?? DEFAULT_GYRO_RANGE_DPS),
  };
}

/**
 * Share of the gyro clip level above which a v2 M416 frame mean may hide a
 * clipped 416 Hz sub-sample (outside the raw H section). Engineering choice:
 * the four sub-samples span 7.2 ms; a frame whose mean reaches 90 % of the
 * clip level next to a clipped sub-sample needs the others within ≈ 13 % of
 * full scale, which a swing's rate does over a few ms near its peak.
 */
export const FRAME_MEAN_CLIP_FRACTION = 0.9;

/**
 * What the v2 BEGIN_B flags mean for the analysis (docs/sensor-v2.md, "App
 * side"). Absent flags (v1) change nothing.
 *
 * - b3 (FIFO reset) with b0 (short pre-history): the firmware drops the ring
 *   and any capture in progress on a reset, so the window starts right after
 *   it: data was lost just before the first sample (`lostBeforeStart`).
 * - b3 without b0: a reset at an unknown position inside the window, i.e. an
 *   unlocated loss: counted as a dropped sample, so every gap-sensitive
 *   metric is withheld (timebase.ts).
 * - b1/b2 (gyro/accel clipped somewhere, checked by the firmware on every
 *   raw sample): when the per-sample check of the delivered values finds no
 *   clipped sample (M416: the 104 Hz gyro is a mean of four samples and can
 *   hide one), the clipping is unlocated: every sample is marked suspect
 *   (gyro) or saturated (accel). A per-sample hit without the flag is kept:
 *   the per-sample check is never overridden towards "not clipped".
 */
export interface CaptureFlagEffects {
  readonly lostBeforeStart: boolean;
  readonly unlocatedLoss: boolean;
  readonly gyroClipped: boolean;
  readonly accelClipped: boolean;
}

export function captureFlagEffects(flags: number | undefined): CaptureFlagEffects {
  const f = flags ?? 0;
  const reset = (f & CaptureFlag.FifoResetInCapture) !== 0;
  const short = (f & CaptureFlag.ShortPreHistory) !== 0;
  return {
    lostBeforeStart: reset && short,
    unlocatedLoss: reset && !short,
    gyroClipped: (f & CaptureFlag.GyroClipped) !== 0,
    accelClipped: (f & CaptureFlag.AccelClipped) !== 0,
  };
}

/**
 * Converts raw counts to SI units. The result stays in the sensor frame; gyro
 * bias correction belongs to the calibration step, not here. Timestamps and
 * the lost-sample count are passed through for the timebase step
 * (processing/timebase.ts), the per-axis clip level for clipping
 * reconstruction (processing/declip.ts).
 */
export function toImuSeries(capture: RawCapture): ImuSeries {
  const n = capture.samples.length / AXES_PER_SAMPLE;
  if (!Number.isInteger(n)) {
    throw new RangeError(`Sample buffer length ${capture.samples.length} is not a multiple of 6`);
  }
  if (capture.sampleTimesUs !== undefined && capture.sampleTimesUs.length !== n) {
    throw new RangeError(`${capture.sampleTimesUs.length} timestamps for ${n} samples`);
  }
  const scales = captureScales(capture);
  const aScale = scales.accelGPerLsb * STANDARD_GRAVITY;
  const gScale = scales.gyroDpsPerLsb * DEG_TO_RAD;
  const gyroClip = scales.gyroClipCounts;
  const s = capture.samples;

  const accel: Vec3[] = [];
  const gyro: Vec3[] = [];
  const accelSaturated: boolean[] = [];
  const gyroSaturated: boolean[] = [];

  const highRateFrames = capture.mode === 'M416';
  const suspectLevel = FRAME_MEAN_CLIP_FRACTION * gyroClip;
  const gyroSuspect: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * AXES_PER_SAMPLE;
    const ax = s[o] ?? 0;
    const ay = s[o + 1] ?? 0;
    const az = s[o + 2] ?? 0;
    const gx = s[o + 3] ?? 0;
    const gy = s[o + 4] ?? 0;
    const gz = s[o + 5] ?? 0;
    accel.push([ax * aScale, ay * aScale, az * aScale]);
    gyro.push([gx * gScale, gy * gScale, gz * gScale]);
    accelSaturated.push(anyClipped(ACCEL_SATURATION_COUNTS, ax, ay, az));
    gyroSaturated.push(anyClipped(gyroClip, gx, gy, gz));
    // M416: a frame mean this close to the clip level may hide a clipped sub-sample.
    gyroSuspect.push(highRateFrames && anyClipped(suspectLevel, gx, gy, gz));
  }

  const effects = captureFlagEffects(capture.flags);
  // A frame whose raw H sub-samples clipped is clipped, whatever its mean says.
  const hr = capture.gyroHr;
  let hrClipped = false;
  if (hr !== undefined) {
    const perFrame = hr.samplesPerFrame * 3;
    for (let k = 0; k < hr.data.length; k++) {
      if (Math.abs(hr.data[k] ?? 0) < gyroClip) continue;
      hrClipped = true;
      const f = hr.startFrame + Math.floor(k / perFrame);
      if (f >= 0 && f < n) gyroSuspect[f] = true;
    }
  }
  const gyroLocated = gyroSaturated.some(Boolean) || hrClipped;
  // Frame means near full scale are suspect only when the sensor saw clipping.
  let suspect = effects.gyroClipped || hrClipped ? gyroSuspect : gyroSuspect.map(() => false);
  if (effects.gyroClipped && !gyroLocated && !suspect.some(Boolean)) {
    suspect = suspect.map(() => true); // clipped somewhere the samples do not show
  }
  if (effects.accelClipped && !accelSaturated.some(Boolean)) {
    accelSaturated.fill(true);
  }
  const dropped = Math.max(capture.droppedSamples ?? 0, effects.unlocatedLoss ? 1 : 0);

  return {
    sampleRateHz: capture.sampleRateHz,
    accel,
    gyro,
    accelSaturated,
    gyroSaturated,
    triggerIndex: capture.triggerIndex,
    gyroClipRadPerS: gyroClip * gScale,
    ...(capture.sampleTimesUs !== undefined
      ? { sampleTimesUs: Array.from(capture.sampleTimesUs) }
      : {}),
    ...(capture.sampleTimesWrapUs !== undefined
      ? { sampleTimesWrapUs: capture.sampleTimesWrapUs }
      : {}),
    ...(capture.droppedSamples !== undefined || dropped > 0 ? { droppedSamples: dropped } : {}),
    ...(suspect.some(Boolean) ? { gyroSuspect: suspect } : {}),
    ...(effects.lostBeforeStart ? { lostBeforeStart: true } : {}),
    ...(capture.temperatureC !== undefined ? { temperatureC: capture.temperatureC } : {}),
  };
}

const anyClipped = (limit: number, ...counts: readonly number[]): boolean =>
  counts.some((c) => Math.abs(c) >= limit);
