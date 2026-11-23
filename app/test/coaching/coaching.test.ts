import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import { findViolations, selectCue } from '../../src/coaching/rules';
import { statistic, summarize } from '../../src/coaching/summary';
import type { StrokeMetrics, StrokeRecord } from '../../src/domain/types';
import { GOOD_FOREHAND } from '../fixtures';

describe('rule engine', () => {
  it('says "Good" when nothing fires', () => {
    expect(selectCue(GOOD_FOREHAND, DEFAULT_RULES)).toEqual({
      ruleId: 'good',
      severity: 'good',
      text: 'Good',
    });
  });

  it('gives only the highest-priority correction', () => {
    const cue = selectCue({ ...GOOD_FOREHAND, faceTiltDeg: 6, swingPathDeg: 2 }, DEFAULT_RULES);
    expect(cue.ruleId).toBe('face-open');
    expect(
      findViolations({ ...GOOD_FOREHAND, faceTiltDeg: 6, swingPathDeg: 2 }, DEFAULT_RULES),
    ).toHaveLength(2);
  });

  it.each([
    [{ faceTiltDeg: -40 }, 'face-closed'],
    [{ swingPathDeg: 5 }, 'path-flat'],
    [{ swingPathDeg: 70 }, 'path-steep'],
    [{ peakSpeedOffsetMs: -80 }, 'accelerated-early'],
    [{ followThroughArcDeg: 60 }, 'short-finish'],
  ] as const)('%o fires %s', (patch, ruleId) => {
    expect(selectCue({ ...GOOD_FOREHAND, ...patch }, DEFAULT_RULES).ruleId).toBe(ruleId);
  });

  it('skips rules whose metric is unavailable', () => {
    const cue = selectCue(
      { ...GOOD_FOREHAND, faceTiltDeg: null, swingPathDeg: null },
      DEFAULT_RULES,
    );
    expect(cue.ruleId).toBe('good');
  });

  it('does not coach groundstroke technique on compact swings or overheads', () => {
    const bad = { ...GOOD_FOREHAND, faceTiltDeg: 20 };
    expect(selectCue({ ...bad, swingSize: 'compact' }, DEFAULT_RULES).ruleId).toBe('good');
    expect(selectCue({ ...bad, strokeType: 'overhead' }, DEFAULT_RULES).ruleId).toBe('good');
  });

  it('documents a source for every rule', () => {
    for (const rule of DEFAULT_RULES.rules) {
      expect(rule.source.length).toBeGreaterThan(5);
      expect(rule.above !== undefined || rule.below !== undefined).toBe(true);
    }
    expect(new Set(DEFAULT_RULES.rules.map((r) => r.id)).size).toBe(DEFAULT_RULES.rules.length);
  });
});

describe('session summary', () => {
  it('computes mean and sample standard deviation', () => {
    expect(statistic([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({
      count: 8,
      mean: 5,
      sd: Math.sqrt(32 / 7),
    });
    expect(statistic([])).toBeNull();
    expect(statistic([3])?.sd).toBe(0);
  });

  it('groups by stroke type and finds the most common fault', () => {
    const record = (metrics: StrokeMetrics, text: string): StrokeRecord => ({
      id: text + String(Math.random()),
      sessionId: 's',
      capture: {
        kind: 'swing',
        sequence: 0,
        sampleRateHz: 104,
        accelGPerLsb: 0.000488,
        gyroDpsPerLsb: 0.07,
        triggerIndex: 0,
        samples: new Int16Array(6),
        receivedAt: 0,
      },
      metrics,
      cue: { ruleId: text, severity: text === 'Good' ? 'good' : 'fix', text },
    });
    const records = [
      record(GOOD_FOREHAND, 'Good'),
      record(GOOD_FOREHAND, 'Face too open'),
      record(GOOD_FOREHAND, 'Face too open'),
      record({ ...GOOD_FOREHAND, strokeType: 'backhand' }, 'Finish your swing'),
    ];
    const [fh, bh] = summarize(records);
    expect(fh).toMatchObject({
      strokeType: 'forehand',
      count: 3,
      topFault: { text: 'Face too open', count: 2 },
    });
    expect(fh?.goodShare).toBeCloseTo(1 / 3);
    expect(bh).toMatchObject({ strokeType: 'backhand', count: 1 });
  });
});
