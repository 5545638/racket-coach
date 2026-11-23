import { describe, expect, it } from 'vitest';
import { base64ToInt16, int16ToBase64, toCsv, toJson } from '../../src/app/export';
import { DEFAULT_SETTINGS, resolveSettings } from '../../src/app/settings';
import type { StrokeRecord } from '../../src/domain/types';
import { GOOD_FOREHAND } from '../fixtures';

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
    expect(resolveSettings({ mode: 'rally', speechRate: 9, leverRadiusM: 1.2 })).toEqual({
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
    expect(lines[1]).toContain('2026-11-23T17:00:00.000Z,forehand,full,true,24.00,,25.00');
    expect(lines[1]?.endsWith('"Say ""hi"""')).toBe(true);
  });

  it('round-trips raw samples through base64 JSON', () => {
    expect(base64ToInt16(int16ToBase64(stroke.capture.samples))).toEqual(stroke.capture.samples);
    const parsed = JSON.parse(toJson({ id: 's', startedAt: 0, label: 'x' }, [stroke])) as {
      strokes: { capture: { samples: string } }[];
    };
    expect(typeof parsed.strokes[0]?.capture.samples).toBe('string');
  });
});
