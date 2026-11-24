import { describe, expect, it } from 'vitest';
import type { ImuSeries } from '../../src/domain/types';
import { type Vec3, DEG_TO_RAD, RAD_TO_DEG } from '../../src/math/vec3';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { conditionSeries } from '../../src/processing/condition';
import { DEFAULT_DECLIP_PARAMS, declipGyro } from '../../src/processing/declip';
import { toImuSeries } from '../../src/processing/units';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  type SwingSpec,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { ALIGNED_MOUNT, SETUP } from '../helpers';

const CLIP = 1960 * DEG_TO_RAD; // analysis threshold at ±2000 dps (28000 counts)

describe('declipGyro on synthetic peaks', () => {
  /** An asymmetric Gaussian peak of `peakDps` on axis 0, clipped at 2000 dps. */
  function peak(peakDps: number, fs: number, riseS = 0.045, fallS = 0.065) {
    const n = Math.round(0.6 * fs);
    const tp = 0.3 + 0.37 / fs;
    const t = Array.from({ length: n }, (_, i) => i / fs);
    const truth = t.map(
      (x) => peakDps * DEG_TO_RAD * Math.exp(-0.5 * ((x - tp) / (x < tp ? riseS : fallS)) ** 2),
    );
    const gyro: Vec3[] = truth.map((v) => [Math.min(v, 2000 * DEG_TO_RAD), 0, 0]);
    return { t, truth, gyro, tp };
  }

  it('reproduces a symmetric (Gaussian) peak almost exactly', () => {
    const { t, gyro } = peak(2600, 208, 0.06, 0.06);
    const r = declipGyro(gyro, t, CLIP);
    expect(r.runs).toHaveLength(1);
    expect(((r.runs[0]?.peakRadPerS ?? 0) * RAD_TO_DEG) / 2600).toBeCloseTo(1, 2);
  });

  it.each([104, 208, 416])(
    'stays within 5 percent of asymmetric peaks of 2200–2800 dps at %i Hz',
    (fs) => {
      for (const dps of [2200, 2400, 2600, 2800]) {
        const { t, gyro, truth, tp } = peak(dps, fs);
        const r = declipGyro(gyro, t, CLIP);
        const run = r.runs[0];
        expect(run?.refused).toBeNull();
        expect(Math.abs((run?.peakRadPerS ?? 0) / (dps * DEG_TO_RAD) - 1)).toBeLessThan(0.05);
        // Flagged, never below the clip level, and peaking within 10 ms of the truth.
        const rec = r.gyro.map((w) => w[0]);
        for (let i = run?.start ?? 0; i <= (run?.end ?? -1); i++) {
          expect(r.reconstructed[i]).toBe(true);
          expect(rec[i] ?? 0).toBeGreaterThanOrEqual(CLIP);
        }
        const iMax = rec.reduce((b, v, i) => (v > (rec[b] ?? 0) ? i : b), 0);
        expect(Math.abs((t[iMax] ?? 0) - tp)).toBeLessThan(0.01 + 1 / fs);
        expect(truth.length).toBe(rec.length);
      }
    },
  );

  it('refuses runs longer than maxRunS and reports them as unrecovered', () => {
    const { t, gyro } = peak(2800, 104, 0.09, 0.16); // ≈ 210 ms plateau
    const r = declipGyro(gyro, t, CLIP);
    expect(r.runs[0]?.refused).toBe('too-long');
    expect(r.runs[0]?.durationS).toBeGreaterThan(DEFAULT_DECLIP_PARAMS.maxRunS);
    expect(r.reconstructed.some(Boolean)).toBe(false);
    expect(r.unrecovered.filter(Boolean).length).toBe(
      (r.runs[0]?.end ?? 0) - (r.runs[0]?.start ?? 0) + 1,
    );
    expect(r.gyro).toEqual(gyro);
  });

  it('refuses a plateau that straddles the ball contact (barrier)', () => {
    const { t, gyro } = peak(2400, 208);
    const run = declipGyro(gyro, t, CLIP).runs[0];
    const mid = ((t[run?.start ?? 0] ?? 0) + (t[run?.end ?? 0] ?? 0)) / 2;
    expect(declipGyro(gyro, t, CLIP, DEFAULT_DECLIP_PARAMS, [mid]).runs[0]?.refused).toBe('impact');
  });

  it('refuses when the rate steps down inside the support (no smooth peak)', () => {
    const { t, gyro } = peak(2300, 208);
    const run = declipGyro(gyro, t, CLIP).runs[0];
    const end = run?.end ?? 0;
    // The ball takes 20 % of the rate right after the plateau.
    const stepped: Vec3[] = gyro.map((w, i) => (i > end ? [w[0] * 0.8, 0, 0] : w));
    expect(declipGyro(stepped, t, CLIP).runs[0]?.refused).not.toBeNull();
  });

  it('refuses when a sample is missing next to the plateau', () => {
    const { t, gyro } = peak(2400, 208);
    const run = declipGyro(gyro, t, CLIP).runs[0];
    const hole = (run?.end ?? 0) + 1;
    const t2 = t.filter((_, i) => i !== hole);
    const g2 = gyro.filter((_, i) => i !== hole);
    expect(declipGyro(g2, t2, CLIP).runs[0]?.refused).toBe('no-support');
  });

  it('never touches the accelerometer', () => {
    const { capture } = simulateSwing(
      {
        ...DEFAULT_SWING,
        faceTiltDeg: 0,
        swingPathDeg: 0,
        peakRateRadPerS: 40,
        riseSigmaS: 0.05,
        fallSigmaS: 0.07,
        withImpact: false,
      },
      { ...SETUP, mount: ALIGNED_MOUNT, gyroClipCounts: 28571 },
    );
    const series = toImuSeries(capture);
    expect(series.accelSaturated.some(Boolean)).toBe(true);
    const c = conditionSeries(series);
    expect(c.gyroReconstructed.some(Boolean)).toBe(true);
    expect(c.accel).toEqual(series.accel);
    expect(c.accelSaturated).toEqual(series.accelSaturated);
  });
});

describe('clipping reconstruction in the analysis', () => {
  /**
   * The real butt-cap mount with a faster-peaking swing (rise σ 50 ms, fall
   * σ 70 ms) whose single gyro axis clips at 2000 dps.
   */
  const SHARP: Partial<SwingSpec> = {
    ...BUTT_CAP_MOUNT,
    faceTiltDeg: 0,
    swingPathDeg: 0,
    tipElevationDeg: 0,
    riseSigmaS: 0.05,
    fallSigmaS: 0.07,
  };
  const params = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: BUTT_CAP_MOUNT.leverRadiusM };

  function run(peakDps: number, fs: number, overrides: Partial<SwingSpec> = {}) {
    const spec = {
      ...DEFAULT_SWING,
      ...SHARP,
      peakRateRadPerS: peakDps * DEG_TO_RAD,
      ...overrides,
    };
    const { capture, truth } = simulateSwing(spec, {
      ...SETUP,
      mount: ALIGNED_MOUNT,
      sampleRateHz: fs,
      gyroClipCounts: 28571,
    });
    const series = toImuSeries(capture);
    // The same series without a clip level: no reconstruction is attempted.
    const unreconstructed: ImuSeries = {
      sampleRateHz: series.sampleRateHz,
      accel: series.accel,
      gyro: series.gyro,
      accelSaturated: series.accelSaturated,
      gyroSaturated: series.gyroSaturated,
      triggerIndex: series.triggerIndex,
    };
    return {
      truth,
      series,
      metrics: analyzeSwing(series, ALIGNED_MOUNT, params),
      clipped: analyzeSwing(unreconstructed, ALIGNED_MOUNT, params),
    };
  }

  it.each([104, 208, 416])(
    'recovers head speed of shadow swings peaking at 2200–2800 dps (%i Hz)',
    (fs) => {
      for (const dps of [2200, 2400, 2600, 2800]) {
        const { truth, metrics, clipped } = run(dps, fs, { withImpact: false });
        if (metrics.quality.gyroReconstructed !== true) {
          // Longer plateaus are refused: then the speed is flagged as a lower bound.
          expect(metrics.quality.gyroSaturated).toBe(true);
          expect(dps).toBeGreaterThanOrEqual(2800);
          continue;
        }
        const error = metrics.headSpeedMps / truth.headSpeedMps - 1;
        const without = clipped.headSpeedMps / truth.headSpeedMps - 1;
        expect(Math.abs(error)).toBeLessThan(0.03);
        expect(without).toBeLessThan(-0.08); // the clipped value is ≥ 8 % low
        expect(metrics.quality.gyroSaturated).toBe(false);
        expect(clipped.quality.gyroSaturated).toBe(true);
        // σ grows with the reconstructed excess and covers the error.
        const sigma = metrics.features?.sigma.headSpeedMps ?? 0;
        expect(sigma).toBeGreaterThan(metrics.headSpeedMps * 0.15);
        expect(Math.abs(metrics.headSpeedMps - truth.headSpeedMps)).toBeLessThan(sigma);
        // Timing: the peak (the reference without contact) lands within a sample + 5 ms.
        const peakMs = metrics.features?.phases.contactMs ?? NaN;
        expect(Math.abs(peakMs - truth.contactTimeS * 1000)).toBeLessThan(1000 / fs + 5);
      }
    },
  );

  it.each([208, 416])('times the peak before a hit from the reconstruction (%i Hz)', (fs) => {
    for (const dps of [2200, 2400]) {
      const { metrics, clipped } = run(dps, fs, { peakOffsetS: -0.07 });
      expect(metrics.impactDetected).toBe(true);
      expect(metrics.quality.gyroReconstructed).toBe(true);
      // Withheld without the reconstruction, within 1 sample + 6 ms of −70 ms with it.
      expect(clipped.peakSpeedOffsetMs).toBeNull();
      expect(Math.abs((metrics.peakSpeedOffsetMs ?? NaN) + 70)).toBeLessThan(1000 / fs + 6);
      const sigmaT = metrics.features?.sigma.peakSpeedOffsetMs ?? 0;
      expect(sigmaT).toBeGreaterThan(1000 / fs / Math.sqrt(12)); // grows with the run length
    }
  });

  it('refuses a long plateau: speed stays a flagged lower bound and timing is withheld', () => {
    const { truth, metrics } = run(2800, 104, { riseSigmaS: 0.09, fallSigmaS: 0.16 });
    expect(metrics.quality.gyroReconstructed).toBe(false);
    expect(metrics.quality.gyroSaturated).toBe(true);
    expect(metrics.headSpeedMps).toBeLessThan(truth.headSpeedMps);
    expect(metrics.peakSpeedOffsetMs).toBeNull();
    expect(metrics.features?.sigma.headSpeedMps).toBeNull();
  });
});
