import { describe, expect, it } from 'vitest';
import { base64ToInt16, int16ToBase64, toCsv, toJson } from '../../src/app/export';
import { DEFAULT_SETTINGS, resolveSettings } from '../../src/app/settings';
import type { StrokeRecord } from '../../src/domain/types';
import { DEFAULT_ANALYSIS_PARAMS } from '../../src/metrics/analyzeSwing';
import { GOOD_FOREHAND } from '../fixtures';
import { SKEWED_MOUNT } from '../helpers';

const stroke: StrokeRecord = {
  id: 'a',
  sessionId: 's',
  capture: {
    kind: 'swing',
    sequence: 1,
    sampleRateHz: 104,
    accelGPerLsb: 0.000488,
    gyroDpsPerLsb: 0.07,
    triggerIndex: 0,
    samples: Int16Array.of(-32768, 0, 1, 32767, -1, 300),
    receivedAt: Date.UTC(2026, 10, 23, 17, 0, 0),
  },
  metrics: { ...GOOD_FOREHAND, faceTiltDeg: null },
  cue: { ruleId: 'x', severity: 'fix', text: 'Say "hi"' },
};

describe('settings', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(
      resolveSettings({
        mode: 'rally',
        speechRate: 9,
        leverRadiusM: 1.2,
        language: 'fr' as never,
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      mode: 'rally',
      leverRadiusM: 1.2,
    });
  });
});

describe('export', () => {
  it('writes one CSV row per stroke with escaped text and empty nulls', () => {
    const lines = toCsv([stroke]).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('2026-11-23T17:00:00.000Z,forehand,full,drive,true,24.00,,25.00');
    expect(lines[0]?.split(',')).toHaveLength(lines[1]?.split(',').length ?? 0);
    expect(lines[1]?.endsWith('"Say ""hi""",')).toBe(true);
  });

  it('round-trips raw samples through base64 JSON', () => {
    expect(base64ToInt16(int16ToBase64(stroke.capture.samples))).toEqual(stroke.capture.samples);
    const parsed = JSON.parse(toJson({ id: 's', startedAt: 0, label: 'x' }, [stroke])) as {
      strokes: { capture: { samples: string } }[];
    };
    expect(typeof parsed.strokes[0]?.capture.samples).toBe('string');
  });

  it('adds the analysis version to CSV, empty for legacy strokes', () => {
    const header = toCsv([stroke]).split('\n')[0]?.split(',');
    expect(header?.at(-1)).toBe('analysisVersion');
    const withVersion = toCsv([{ ...stroke, analysisVersion: 2 }])
      .trim()
      .split('\n')[1];
    expect(withVersion?.endsWith(',2')).toBe(true);
    expect(toCsv([stroke]).trim().split('\n')[1]?.endsWith('",')).toBe(true);
  });

  it('exports calibration, parameters and version for offline re-analysis', () => {
    const full: StrokeRecord = {
      ...stroke,
      analysisVersion: 2,
      analysisParams: DEFAULT_ANALYSIS_PARAMS,
      calibration: SKEWED_MOUNT,
    };
    const parsed = JSON.parse(toJson({ id: 's', startedAt: 0, label: 'x' }, [full])) as {
      version: number;
      strokes: Pick<StrokeRecord, 'analysisVersion' | 'analysisParams' | 'calibration'>[];
    };
    expect(parsed.version).toBe(2);
    expect(parsed.strokes[0]?.analysisVersion).toBe(2);
    expect(parsed.strokes[0]?.analysisParams).toEqual(DEFAULT_ANALYSIS_PARAMS);
    expect(parsed.strokes[0]?.calibration).toEqual(JSON.parse(JSON.stringify(SKEWED_MOUNT)));
  });
});
