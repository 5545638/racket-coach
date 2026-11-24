import type { ImuSeries, RawCapture } from '../domain/types';
import { type Vec3, DEG_TO_RAD } from '../math/vec3';
import { estimateTimebase, unwrapTimes } from './timebase';
import { captureScales, toImuSeries } from './units';

/**
 * M416 high-rate splice (docs/metrics.md, "M416 high-rate splice").
 *
 * An M416 capture (docs/sensor-v2.md) holds, per 104 Hz frame f, the
 * accelerometer sample A0 taken at the frame time and the MEAN of the four
 * 416 Hz gyro samples of the frame (L section), plus the raw 416 Hz gyro for
 * frames peak − 15 … peak + 15 (H section). The analysis needs one uniform
 * series, so this builds it at four times the frame rate, t = f + k/4 frames:
 *
 * - accelerometer: linear between the A0 samples (measured at k = 0). Linear,
 *   not cubic: the ball impact is a step, and a cubic would ring around it;
 * - gyro outside H: the frame means are samples at f + 0.375 (the centre of
 *   the four sub-samples) and are interpolated by a Catmull-Rom cubic, which
 *   is local (a step or clipped run disturbs two intervals each side) and
 *   exact for quadratics (error O(h³) against O(h²) for linear), see
 *   `GyroInterpolation`;
 * - gyro inside H: replaced by the raw sub-samples at their exact times.
 *
 * The grid is uniform at four times the true frame rate (1 / framePeriodNs:
 * 416.7 Hz on the LSM6DS3TR-C) and carries no timestamps: v2 frame times are
 * derived from that one period, so there is nothing left to resample.
 * The analysis has no variable rate, so the whole series is at 416 Hz;
 * `gyroMeasured` / `accelMeasured` tell measured from interpolated samples so
 * that σ and quality can reflect where the resolution is real.
 */
export type GyroInterpolation = 'cubic' | 'linear';

export interface SpliceOptions {
  readonly gyroInterpolation?: GyroInterpolation;
}

/** Centre of the four-sample frame mean, in frames after the frame time. */
export const FRAME_MEAN_CENTRE = 0.375;

/** True when `capture` carries an M416 H section that `spliceHighRate` can use. */
export const hasHighRate = (capture: RawCapture): boolean =>
  capture.mode === 'M416' &&
  capture.gyroHr !== undefined &&
  capture.gyroHr.samplesPerFrame > 1 &&
  capture.gyroHr.data.length > 0;

/**
 * The series the analysis uses for a capture: the M416 splice when the
 * capture has an H section (and `highRate` is not false), else the samples as
 * delivered (`toImuSeries`). The single entry point from raw capture to
 * analysis input.
 */
export function seriesFromCapture(
  capture: RawCapture,
  options: SpliceOptions & { readonly highRate?: boolean } = {},
): ImuSeries {
  const base = toImuSeries(capture);
  if (options.highRate === false || !hasHighRate(capture) || !framesContiguous(base)) return base;
  return spliceHighRate(capture, base, options);
}

const catmullRom = (p0: number, p1: number, p2: number, p3: number, u: number): number =>
  0.5 *
  (2 * p1 +
    (-p0 + p2) * u +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
    (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);

/**
 * Builds the 4×-rate series from an M416 capture. `base` is `toImuSeries` of
 * the same capture (L section in SI units, flags and timestamps per frame).
 */
export function spliceHighRate(
  capture: RawCapture,
  base: ImuSeries,
  options: SpliceOptions = {},
): ImuSeries {
  const hr = capture.gyroHr;
  if (!hr) return base;
  const q = hr.samplesPerFrame;
  const n = base.gyro.length;
  if (n < 2) return base;
  const m = q * (n - 1) + 1;
  const scales = captureScales(capture);
  const gScale = scales.gyroDpsPerLsb * DEG_TO_RAD;
  const clip = scales.gyroClipCounts;
  const cubic = (options.gyroInterpolation ?? 'cubic') === 'cubic';

  const accel: Vec3[] = [];
  const gyro: Vec3[] = [];
  const accelSaturated: boolean[] = [];
  const gyroSaturated: boolean[] = [];
  const gyroSuspect: boolean[] = [];
  const gyroMeasured: boolean[] = [];
  const accelMeasured: boolean[] = [];
  const L = base.gyro;
  const Lsat = base.gyroSaturated;
  const Lsus = base.gyroSuspect;
  const frameGyro = (f: number): Vec3 => L[Math.max(0, Math.min(n - 1, f))] ?? [0, 0, 0];

  for (let j = 0; j < m; j++) {
    const f = Math.floor(j / q);
    const k = j - f * q;
    const tau = j / q;
    // Accelerometer: linear between frame samples.
    const w = k / q;
    const a0 = base.accel[f] ?? [0, 0, 0];
    const a1 = base.accel[Math.min(n - 1, f + 1)] ?? a0;
    accel.push([
      a0[0] + (a1[0] - a0[0]) * w,
      a0[1] + (a1[1] - a0[1]) * w,
      a0[2] + (a1[2] - a0[2]) * w,
    ]);
    accelSaturated.push(
      (base.accelSaturated[f] ?? false) ||
        (w > 0 && (base.accelSaturated[Math.min(n - 1, f + 1)] ?? false)),
    );
    accelMeasured.push(k === 0);

    // Gyro: the frame means sit at g + 0.375. Interval [g + 0.375, g + 1.375).
    const g = Math.max(0, Math.min(n - 2, Math.floor(tau - FRAME_MEAN_CENTRE)));
    const u = tau - g - FRAME_MEAN_CENTRE; // in [0, 1) inside, beyond at the ends
    const inside = u >= 0 && u <= 1 && g >= 1 && g + 2 <= n - 1;
    const value = (axis: 0 | 1 | 2): number => {
      const p1 = frameGyro(g)[axis];
      const p2 = frameGyro(g + 1)[axis];
      if (!cubic || !inside) return p1 + (p2 - p1) * u; // linear (also extrapolates at the ends)
      return catmullRom(frameGyro(g - 1)[axis], p1, p2, frameGyro(g + 2)[axis], u);
    };
    gyro.push([value(0), value(1), value(2)]);
    const near = [g, g + 1];
    gyroSaturated.push(near.some((i) => Lsat[i] ?? false));
    gyroSuspect.push(near.some((i) => Lsus?.[i] ?? false));
    gyroMeasured.push(false);
  }

  // Raw 416 Hz gyro inside the H section, at exact sub-sample times.
  for (let s = 0; s < hr.data.length / 3; s++) {
    const j = hr.startFrame * q + s;
    if (j < 0 || j >= m) continue;
    const c: Vec3 = [hr.data[3 * s] ?? 0, hr.data[3 * s + 1] ?? 0, hr.data[3 * s + 2] ?? 0];
    gyro[j] = [c[0] * gScale, c[1] * gScale, c[2] * gScale];
    gyroSaturated[j] = c.some((v) => Math.abs(v) >= clip);
    gyroSuspect[j] = false;
    gyroMeasured[j] = true;
  }

  // The grid is uniform at the true frame rate (measured by the sensor), so
  // it needs no resampling: resampling onto the nominal 416 Hz grid would
  // blend the raw H samples and leave no grid point exactly on an A0.
  const frameRateHz = frameRate(capture, base);
  return {
    sampleRateHz: frameRateHz * q,
    accel,
    gyro,
    accelSaturated,
    gyroSaturated,
    triggerIndex: base.triggerIndex * q,
    ...(base.gyroClipRadPerS !== undefined ? { gyroClipRadPerS: base.gyroClipRadPerS } : {}),
    ...(base.droppedSamples !== undefined ? { droppedSamples: base.droppedSamples } : {}),
    ...(gyroSuspect.some(Boolean) ? { gyroSuspect } : {}),
    ...(base.lostBeforeStart ? { lostBeforeStart: true } : {}),
    ...(base.temperatureC !== undefined ? { temperatureC: base.temperatureC } : {}),
    gyroMeasured,
    accelMeasured,
    baseRateHz: frameRateHz,
  };
}

/**
 * True frame rate, Hz: from the sensor's measured frame period (v2 BEGIN_B),
 * else from the frame timestamps, else the nominal rate.
 */
function frameRate(capture: RawCapture, base: ImuSeries): number {
  if (capture.framePeriodNs !== undefined && capture.framePeriodNs > 0) {
    return 1e9 / capture.framePeriodNs;
  }
  const times = base.sampleTimesUs;
  if (times !== undefined && times.length > 1) {
    return estimateTimebase(unwrapTimes(times, base.sampleTimesWrapUs), base.sampleRateHz)
      .measuredRateHz;
  }
  return base.sampleRateHz;
}

/**
 * The splice indexes the H section by frame, so it needs contiguous frames:
 * true for v2 captures (the firmware sends a contiguous window and derives
 * the frame times from one period). Timestamps that show missing frames
 * make the splice impossible.
 */
function framesContiguous(base: ImuSeries): boolean {
  const times = base.sampleTimesUs;
  if (times === undefined || times.length < 2) return true;
  return (
    estimateTimebase(unwrapTimes(times, base.sampleTimesWrapUs), base.sampleRateHz).gaps.length ===
    0
  );
}
