import { describe, expect, it } from 'vitest';
import type { RawCapture, StrokeMetrics } from '../../src/domain/types';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { DEG_TO_RAD } from '../../src/math/vec3';
import { FRAME_MEAN_CENTRE, seriesFromCapture } from '../../src/processing/highRate';
import { conditionSeries } from '../../src/processing/condition';
import { toImuSeries } from '../../src/processing/units';
import { CaptureFlag } from '../../src/protocol/constants';
import { firmwareCaptures } from '../../src/simulation/firmwareCapture';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  type SwingSpec,
  type SwingTruth,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT, V2_TIMESTAMPS } from '../helpers';

/** Sub-sample rate of the LSM6DS3TR-C at "416 Hz": 6666.7 Hz / 16 (frame period 9.6 ms / 4). */
const FS = 1e6 / 2400;

/** A truth swing at 416.7 Hz and the captures the firmware would make of it. */
function captures(spec: SwingSpec, subFrame: number) {
  const { capture, truth } = simulateSwing(spec, {
    ...SETUP,
    sampleRateHz: FS,
    reportedRateHz: 416,
    durationS: 2.2, // 229 frames, the firmware's window
    contactTimeS: 1.5 + subFrame / FS,
    timestamps: V2_TIMESTAMPS,
  });
  return { truth, highRate: capture, ...firmwareCaptures(capture) };
}

/** Time of peak ω⊥ relative to contact in the noise-free truth, ms. */
function truePeakOffsetMs(truth: SwingTruth): number {
  let best = -1;
  let at = 0;
  for (let t = truth.contactTimeS - 0.2; t <= truth.contactTimeS + 1e-9; t += 1e-4) {
    const w = truth.omegaAt(t);
    const p = Math.hypot(w[1], w[2]);
    if (p > best) {
      best = p;
      at = t;
    }
  }
  return (at - truth.contactTimeS) * 1000;
}

const METRICS = ['contactMs', 'peakOffsetMs', 'speedPct', 'faceDeg', 'pathDeg', 'tipDeg'] as const;
type Errors = Record<(typeof METRICS)[number], number>;

function errors(m: StrokeMetrics, truth: SwingTruth): Errors {
  return {
    contactMs: (m.features?.phases.contactMs ?? NaN) - truth.contactTimeS * 1000,
    peakOffsetMs: (m.peakSpeedOffsetMs ?? NaN) - truePeakOffsetMs(truth),
    speedPct: (m.headSpeedMps / truth.headSpeedMps - 1) * 100,
    faceDeg: (m.faceTiltDeg ?? NaN) - truth.faceTiltDeg,
    pathDeg: (m.swingPathDeg ?? NaN) - truth.swingPathDeg,
    tipDeg: (m.tipElevationDeg ?? NaN) - truth.tipElevationDeg,
  };
}

const maxAbs = (rows: readonly Errors[], k: keyof Errors): number =>
  Math.max(...rows.map((r) => Math.abs(r[k])));
const rms = (rows: readonly Errors[], k: keyof Errors): number =>
  Math.sqrt(rows.reduce((acc, r) => acc + r[k] ** 2, 0) / rows.length);

const BUTT_CAP: SwingSpec = {
  ...DEFAULT_SWING,
  ...BUTT_CAP_MOUNT,
  backswingRateRadPerS: 6,
  takebackTurnDeg: 60,
  takebackTurnStartS: -0.9,
  peakOffsetS: -0.02,
  rollRateRadPerS: 8,
  noiseDensity: { accelUgPerRtHz: 130, gyroMdpsPerRtHz: 5 },
};
/** Sensor near the string bed: a 40 g transient that leads contact detection. */
const LEVER: SwingSpec = {
  ...DEFAULT_SWING,
  backswingRateRadPerS: 6,
  peakOffsetS: -0.02,
  noiseDensity: { accelUgPerRtHz: 130, gyroMdpsPerRtHz: 5 },
};

describe('M416 splice: structure', () => {
  const { m416, highRate } = captures(BUTT_CAP, 0);
  const series = seriesFromCapture(m416);
  const n = m416.samples.length / 6;

  it('builds a 416 Hz series on the f + k/4 grid with measured-sample flags', () => {
    // Four times the true frame rate (frame period 9.6 ms), no resampling needed.
    expect(series.sampleRateHz).toBeCloseTo(FS, 9);
    expect(series.sampleTimesUs).toBeUndefined();
    expect(series.gyro).toHaveLength(4 * (n - 1) + 1);
    expect(series.baseRateHz).toBeCloseTo(FS / 4, 9);
    const h = m416.gyroHr;
    if (!h) throw new Error('no H section');
    const measured = series.gyroMeasured ?? [];
    expect(measured.filter(Boolean)).toHaveLength(h.data.length / 3);
    expect(measured[4 * h.startFrame]).toBe(true);
    expect(measured[4 * h.startFrame - 1]).toBe(false);
    expect(series.accelMeasured?.filter(Boolean)).toHaveLength(n);
    expect(series.accelMeasured?.[4]).toBe(true);
  });

  it('keeps raw H samples and A0 exactly, and interpolates the frame means between their centres', () => {
    const raw = toImuSeries(highRate); // the 416.7 Hz truth samples as the IMU produced them
    const h = m416.gyroHr;
    if (!h) throw new Error('no H section');
    const j = 4 * h.startFrame + 7;
    expect(series.gyro[j]).toEqual(raw.gyro[j]);
    expect(series.accel[40]).toEqual(raw.accel[40]);
    // Outside H the cubic follows the 416 Hz truth within a few tenths of a deg/s on the slow backswing.
    const L = toImuSeries(m416).gyro;
    for (let f = 20; f < h.startFrame - 2; f++) {
      for (let k = 0; k < 4; k++) {
        const i = 4 * f + k;
        for (let axis = 0; axis < 3; axis++) {
          expect(Math.abs((series.gyro[i]?.[axis] ?? 0) - (raw.gyro[i]?.[axis] ?? 0))).toBeLessThan(
            0.6 * DEG_TO_RAD + 0.05 * Math.abs((L[f + 1]?.[axis] ?? 0) - (L[f]?.[axis] ?? 0)),
          );
        }
      }
    }
    expect(FRAME_MEAN_CENTRE).toBe(0.375);
  });

  it('survives conditioning unchanged (uniform, no timestamps): measured flags kept', () => {
    const c = conditionSeries(series);
    expect(c.gyroMeasured).toEqual(series.gyroMeasured);
    expect(c.accelMeasured).toEqual(series.accelMeasured);
    expect(c.timebase.measuredRateHz).toBeCloseTo(FS, 6);
  });

  it('falls back to the frames as delivered when their timestamps show missing frames', () => {
    const times = (m416.sampleTimesUs ?? []).map((t, f) => (f > 100 ? t + 9600 : t));
    const fallback = seriesFromCapture({ ...m416, sampleTimesUs: times });
    expect(fallback.gyroMeasured).toBeUndefined();
    expect(fallback.gyro).toHaveLength(n);
  });
});

describe('M416 splice against truth and against 104 Hz (docs/metrics.md table)', { timeout: 60_000 }, () => {
  it.each([
    ['butt cap (gyro-led contact)', BUTT_CAP],
    ['sensor near the string bed (accelerometer-led contact)', LEVER],
  ] as const)('%s', (_, base) => {
    const rows: Record<'splice' | 'm104' | 'lOnly', Errors[]> = { splice: [], m104: [], lOnly: [] };
    for (let sub = 0; sub < 4; sub++) {
      for (const contactPhase of [0.2, 0.7]) {
        for (const peakRateRadPerS of [20, 26]) {
          const spec = { ...base, contactPhase, peakRateRadPerS };
          const { truth, m416, m104 } = captures(spec, sub);
          const p = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: spec.leverRadiusM };
          const run = (c: RawCapture, highRate = true) =>
            analyzeSwing(seriesFromCapture(c, { highRate }), SKEWED_MOUNT, p);
          const spliced = run(m416);
          expect(spliced.impactDetected).toBe(true);
          expect(spliced.quality.highRate?.contactMeasured).toBe(true);
          rows.splice.push(errors(spliced, truth));
          rows.m104.push(errors(run(m104), truth));
          rows.lOnly.push(errors(run(m416, false), truth));
        }
      }
    }
    const s = rows.splice;
    // Against truth: contact within ±½ sub-sample + noise, speed and angles tight.
    expect(maxAbs(s, 'contactMs')).toBeLessThan(1.5);
    expect(maxAbs(s, 'peakOffsetMs')).toBeLessThan(2.5);
    expect(maxAbs(s, 'speedPct')).toBeLessThan(0.5);
    for (const k of ['faceDeg', 'pathDeg', 'tipDeg'] as const) expect(maxAbs(s, k)).toBeLessThan(1);
    // Against 104 Hz: timing and tip clearly better, nothing worse beyond noise.
    expect(maxAbs(s, 'contactMs')).toBeLessThan(0.5 * maxAbs(rows.m104, 'contactMs'));
    expect(maxAbs(s, 'peakOffsetMs')).toBeLessThan(0.5 * maxAbs(rows.m104, 'peakOffsetMs'));
    expect(rms(s, 'tipDeg')).toBeLessThan(0.5 * rms(rows.m104, 'tipDeg'));
    for (const k of METRICS) expect(rms(s, k)).toBeLessThanOrEqual(rms(rows.m104, k) + 0.05);
    // The 104 Hz frame means alone (no splice) smear the impact into the last pre-impact frame.
    expect(maxAbs(rows.lOnly, 'speedPct')).toBeGreaterThan(10);
  });

  it('σ reflects the measured resolution at contact', () => {
    const { m416, m104 } = captures(BUTT_CAP, 1);
    const p = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: BUTT_CAP.leverRadiusM };
    const spliced = analyzeSwing(seriesFromCapture(m416), SKEWED_MOUNT, p);
    const slow = analyzeSwing(seriesFromCapture(m104), SKEWED_MOUNT, p);
    // Peak timing at the measured 416 Hz; segmentation events keep the 104 Hz resolution.
    expect(spliced.features?.sigma.peakSpeedOffsetMs).toBeCloseTo(1000 / FS / Math.sqrt(12), 6);
    expect(spliced.features?.sigma.forwardSwingMs).toBeCloseTo(1000 / (FS / 4) / Math.sqrt(12), 6);
    expect(slow.features?.sigma.forwardSwingMs).toBeCloseTo(1000 / 104 / Math.sqrt(12), 6);
  });
});

describe('M416 clip flags', () => {
  it('a clipped sub-sample hidden by the frame mean outside H makes the gyro there unrecovered', () => {
    const { m416 } = captures(BUTT_CAP, 0);
    const h = m416.gyroHr;
    if (!h) throw new Error('no H section');
    const f = h.startFrame - 10; // outside H
    const samples = Int16Array.from(m416.samples);
    samples[f * 6 + 5] = 26000; // mean of e.g. 28000, 26500, 25500, 24000: no frame reaches 28000
    const flagged: RawCapture = { ...m416, samples, flags: CaptureFlag.GyroClipped };
    const series = seriesFromCapture(flagged);
    expect(series.gyroSuspect?.[4 * f]).toBe(true);
    const c = conditionSeries(series);
    expect(c.gyroUnrecovered.some(Boolean)).toBe(true);
    // Without the flag the same values are taken at face value.
    expect(seriesFromCapture({ ...m416, samples, flags: 0 }).gyroSuspect).toBeUndefined();
  });
});
