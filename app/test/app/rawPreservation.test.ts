import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { fromJson, toJson } from '../../src/app/export';
import { analyzeCapture, reanalyseStroke } from '../../src/app/pipeline';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import type { MountCalibration, RawCapture, StrokeRecord } from '../../src/domain/types';
import { DEFAULT_ANALYSIS_PARAMS } from '../../src/metrics/analyzeSwing';
import { ANALYSIS_VERSION } from '../../src/metrics/version';
import { CaptureFlag } from '../../src/protocol/constants';
import { firmwareCaptures } from '../../src/simulation/firmwareCapture';
import { BUTT_CAP_MOUNT, DEFAULT_SWING, simulateSwing } from '../../src/simulation/swingModel';
import { IndexedDbRepository } from '../../src/storage/repository';
import { SETUP, SKEWED_MOUNT, V2_TIMESTAMPS } from '../helpers';

const SPEC = { ...DEFAULT_SWING, ...BUTT_CAP_MOUNT, backswingRateRadPerS: 6 };
const CALIBRATION: MountCalibration = { ...SKEWED_MOUNT, temperatureC: 24.5 };
const PARAMS = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: 0.72 };

/** A v1 capture and a complete v2 M416 capture (L, H, timestamps, flags, temperature, sensitivities). */
function captures(): { readonly v1: RawCapture; readonly v2: RawCapture } {
  const v1 = simulateSwing(SPEC, { ...SETUP, durationS: 2.2, contactTimeS: 1.5 }).capture;
  const high = simulateSwing(SPEC, {
    ...SETUP,
    sampleRateHz: 1e6 / 2400,
    reportedRateHz: 416,
    durationS: 2.2,
    contactTimeS: 1.5,
    timestamps: V2_TIMESTAMPS,
  }).capture;
  const { m416 } = firmwareCaptures(high, { temperatureRaw: 1234 });
  return {
    v1,
    v2: {
      ...m416,
      sequence: 77,
      receivedAt: Date.UTC(2026, 10, 24, 9, 0, 0),
      flags: m416.flags ?? 0,
      filter: { filterCfg: 3 },
      firmwareVersion: '0.2.0',
    },
  };
}

function record(id: string, capture: RawCapture): StrokeRecord {
  const analysis = analyzeCapture(capture, CALIBRATION, PARAMS, DEFAULT_RULES);
  return {
    id,
    sessionId: 's',
    capture,
    metrics: analysis.metrics,
    cue: analysis.cue,
    analysisVersion: ANALYSIS_VERSION,
    analysisParams: PARAMS,
    calibration: CALIBRATION,
  };
}

/** `value` without the listed keys (as records stored by older versions lack them). */
const omit = <T extends object>(value: T, keys: readonly string[]): T =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;

const withoutCalibration = (stroke: StrokeRecord): StrokeRecord => omit(stroke, ['calibration']);

/** The capture with typed arrays as plain arrays, for value comparison across representations. */
const plain = (c: RawCapture) => ({
  ...c,
  samples: Array.from(c.samples),
  ...(c.sampleTimesUs ? { sampleTimesUs: Array.from(c.sampleTimesUs) } : {}),
  ...(c.gyroHr ? { gyroHr: { ...c.gyroHr, data: Array.from(c.gyroHr.data) } } : {}),
});

describe('raw data preservation', () => {
  const { v1, v2 } = captures();
  const strokes = [record('v1', v1), record('v2', v2)];

  it('the v2 capture carries everything the sensor sent', () => {
    expect(v2.gyroHr?.data.length).toBe(31 * 12);
    expect(v2.sampleTimesUs).toHaveLength(v2.samples.length / 6);
    expect(v2).toMatchObject({
      protocolVersion: 2,
      mode: 'M416',
      framePeriodNs: 9_600_000,
      accelUgPerLsb: 488,
      gyroMdpsPerLsb: 70,
      temperatureRaw: 1234,
    });
    expect(v2.temperatureC).toBeCloseTo(25 + 1234 / 256, 9);
    expect(strokes[1]?.metrics.quality.highRate).toBeDefined();
  });

  it('JSON export round-trips v1 and v2 captures losslessly', () => {
    const back = fromJson(toJson({ id: 's', startedAt: 1, label: 'x' }, strokes));
    expect(back.session).toEqual({ id: 's', startedAt: 1, label: 'x' });
    back.strokes.forEach((s, i) => {
      const original = strokes[i];
      if (!original) throw new Error('missing');
      expect(s.capture.samples).toBeInstanceOf(Int16Array);
      expect(s.capture.samples).toEqual(original.capture.samples);
      expect(s.capture.gyroHr?.data).toEqual(original.capture.gyroHr?.data);
      expect(plain(s.capture)).toEqual(plain(original.capture));
      expect(s.calibration).toEqual(original.calibration);
      expect(s.analysisParams).toEqual(original.analysisParams);
      expect(s.analysisVersion).toBe(ANALYSIS_VERSION);
    });
  });

  it('re-analysis from the export reproduces the metrics exactly (v1 and v2)', () => {
    const back = fromJson(toJson({ id: 's', startedAt: 1, label: 'x' }, strokes));
    back.strokes.forEach((s, i) => {
      const again = reanalyseStroke(s, DEFAULT_RULES);
      // JSON drops undefined fields only; compare through the same serialisation.
      expect(JSON.parse(JSON.stringify(again?.metrics))).toEqual(
        JSON.parse(JSON.stringify(strokes[i]?.metrics)),
      );
    });
  });

  it('IndexedDB keeps the complete capture and re-analysis reproduces the metrics', async () => {
    const repo = await IndexedDbRepository.open(`test-${String(Math.random())}`);
    for (const s of strokes) await repo.saveStroke(s);
    const stored = await repo.strokesForSession('s');
    expect(stored).toHaveLength(2);
    stored.forEach((s, i) => {
      const original = strokes[i];
      if (!original) throw new Error('missing');
      expect(s.capture).toEqual(original.capture);
      expect(reanalyseStroke(s, DEFAULT_RULES)?.metrics).toEqual(original.metrics);
    });
  });

  it('re-analysis fills parameters added since the stroke was stored with their defaults', () => {
    const stroke = strokes[1];
    if (!stroke?.analysisParams) throw new Error('missing');
    // As stored before version 6: without the bias re-estimation parameters.
    const older = omit(stroke.analysisParams, ['biasMaxDps', 'biasWindowMinS']);
    expect(Object.keys(older)).not.toContain('biasMaxDps');
    const again = reanalyseStroke({ ...stroke, analysisParams: older }, DEFAULT_RULES);
    expect(again?.metrics).toEqual(stroke.metrics);
    expect(reanalyseStroke(withoutCalibration(stroke), DEFAULT_RULES)).toBeNull();
  });
});

describe('capture header mapping (v2)', () => {
  const { v2 } = captures();

  it('rejects unknown sensitivities with a clear error', () => {
    expect(() =>
      analyzeCapture({ ...v2, gyroMdpsPerLsb: 71 }, CALIBRATION, PARAMS, DEFAULT_RULES),
    ).toThrow(/unknown gyro .*sensitivity 71/);
    expect(() =>
      analyzeCapture({ ...v2, accelUgPerLsb: 500 }, CALIBRATION, PARAMS, DEFAULT_RULES),
    ).toThrow(/unknown accelerometer .*sensitivity 500/);
  });

  it('a FIFO reset inside the window (b3 without b0) withholds everything gap-sensitive', () => {
    const m = analyzeCapture(
      { ...v2, flags: CaptureFlag.FifoResetInCapture },
      CALIBRATION,
      PARAMS,
      DEFAULT_RULES,
    ).metrics;
    expect(m.quality.timebase?.droppedSamples).toBe(1);
    expect(m.quality.signalGap).toBe(true);
    expect(m.faceTiltDeg).toBeNull();
    expect(m.preparationTimeMs).toBeNull();
  });

  it('a FIFO reset before the window (b3 with b0) only marks the capture start', () => {
    const clean = analyzeCapture(v2, CALIBRATION, PARAMS, DEFAULT_RULES).metrics;
    const m = analyzeCapture(
      { ...v2, flags: CaptureFlag.FifoResetInCapture | CaptureFlag.ShortPreHistory },
      CALIBRATION,
      PARAMS,
      DEFAULT_RULES,
    ).metrics;
    expect(m.quality.timebase?.gapSamples).toBe(1);
    // The ready position lies inside the window: nothing depends on the lost data.
    expect(m.quality.signalGap).toBe(false);
    expect(m.faceTiltDeg).toBe(clean.faceTiltDeg);
  });

  it('warns when the capture is more than 10 °C away from the calibration temperature', () => {
    const warm = analyzeCapture(v2, { ...CALIBRATION, temperatureC: 5 }, PARAMS, DEFAULT_RULES);
    expect(warm.metrics.quality.temperatureDeltaC).toBeCloseTo((v2.temperatureC ?? 0) - 5, 9);
    expect(warm.metrics.quality.temperatureWarning).toBe(true);
    const near = analyzeCapture(v2, CALIBRATION, PARAMS, DEFAULT_RULES);
    expect(near.metrics.quality.temperatureWarning).toBe(false);
    const unknown = analyzeCapture(v2, SKEWED_MOUNT, PARAMS, DEFAULT_RULES);
    expect(unknown.metrics.quality.temperatureDeltaC).toBeUndefined();
  });
});
