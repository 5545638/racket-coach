import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import { GUIDANCE, guidanceFor } from '../../src/coaching/guidance';
import { buildSessionReport } from '../../src/coaching/sessionReport';
import { NO_READING_CUE, evaluateRules, selectCue } from '../../src/coaching/rules';
import { statistic, summarize } from '../../src/coaching/summary';
import { wristHint } from '../../src/coaching/wrist';
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
      evaluateRules({ ...GOOD_FOREHAND, faceTiltDeg: 6, swingPathDeg: 2 }, DEFAULT_RULES)
        .violations,
    ).toHaveLength(2);
  });

  it.each([
    [{ faceTiltDeg: -40 }, 'face-closed'],
    [{ swingPathDeg: 5 }, 'path-flat'],
    [{ swingPathDeg: 70 }, 'path-steep'],
    [{ peakSpeedOffsetMs: -80 }, 'accelerated-early'],
    [{ followThroughArcDeg: 60 }, 'short-finish'],
    [{ preparationTimeMs: 400 }, 'late-preparation'],
    [{ racketDropDeg: 5 }, 'no-racket-drop'],
    [{ faceAtDropDeg: 45 }, 'open-takeback'],
    [{ backswingPauseMs: 260 }, 'hitch'],
    [{ peakAccelerationOffsetMs: -220 }, 'stiff-arm'],
  ] as const)('%o fires %s', (patch, ruleId) => {
    expect(selectCue({ ...GOOD_FOREHAND, ...patch }, DEFAULT_RULES).ruleId).toBe(ruleId);
  });

  it('never calls a stroke good when angles were unavailable', () => {
    const blind = { ...GOOD_FOREHAND, faceTiltDeg: null, swingPathDeg: null };
    expect(selectCue(blind, DEFAULT_RULES)).toEqual(NO_READING_CUE);
    // …but still corrects what it can measure.
    expect(selectCue({ ...blind, followThroughArcDeg: 50 }, DEFAULT_RULES).ruleId).toBe(
      'short-finish',
    );
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

describe('guidance texts', () => {
  it('explains every cue in every language', () => {
    const ids = [...DEFAULT_RULES.rules.map((r) => r.id), 'good', 'no-reading'];
    for (const language of ['en', 'et'] as const) {
      for (const id of ids) {
        const g = guidanceFor(id, language);
        expect(g, `${language}/${id}`).not.toBeNull();
        expect(g?.meaning.length).toBeGreaterThan(10);
        expect(g?.fix.length).toBeGreaterThan(5);
      }
      expect(Object.keys(GUIDANCE[language]).sort()).toEqual([...ids].sort());
    }
    expect(guidanceFor('unknown-rule', 'et')).toBeNull();
  });
});

describe('session report', () => {
  const stroke = (
    strokeType: StrokeMetrics['strokeType'],
    ruleId: string,
    severity: StrokeRecord['cue']['severity'],
  ): StrokeRecord => ({
    id: String(Math.random()),
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
    metrics: { ...GOOD_FOREHAND, strokeType },
    cue: { ruleId, severity, text: ruleId },
  });
  const repeat = (n: number, make: () => StrokeRecord) => Array.from({ length: n }, make);

  it('names the most frequent correction as the focus', () => {
    const report = buildSessionReport([
      ...repeat(8, () => stroke('forehand', 'face-open', 'fix')),
      ...repeat(6, () => stroke('forehand', 'good', 'good')),
      ...repeat(2, () => stroke('forehand', 'no-reading', 'none')),
      ...repeat(6, () => stroke('backhand', 'short-finish', 'fix')),
      ...repeat(4, () => stroke('backhand', 'good', 'good')),
    ]);
    expect(report.totalStrokes).toBe(26);
    expect(report.unrated).toBe(2);
    expect(report.focus).toMatchObject({ strokeType: 'forehand', ruleId: 'face-open', count: 8 });
    expect(report.focus?.share).toBeCloseTo(8 / 14);
    expect(report.byStroke.find((s) => s.strokeType === 'backhand')?.goodShare).toBeCloseTo(0.4);
  });

  it('gives no focus when faults are rare or the sample is small', () => {
    expect(
      buildSessionReport(repeat(4, () => stroke('forehand', 'face-open', 'fix'))).focus,
    ).toBeNull();
    const mostlyGood = [
      ...repeat(5, () => stroke('forehand', 'face-open', 'fix')),
      ...repeat(30, () => stroke('forehand', 'good', 'good')),
    ];
    expect(buildSessionReport(mostlyGood).focus).toBeNull();
    expect(buildSessionReport([]).byStroke).toEqual([]);
  });
});

describe('wrist hint', () => {
  it('reads racket lag as loose and early acceleration as stiff', () => {
    expect(wristHint(GOOD_FOREHAND)).toBe('loose');
    expect(wristHint({ ...GOOD_FOREHAND, peakAccelerationOffsetMs: -220 })).toBe('stiff');
  });

  it('gives no hint where lag is not meaningful', () => {
    expect(wristHint({ ...GOOD_FOREHAND, swingSize: 'compact' })).toBeNull();
    expect(wristHint({ ...GOOD_FOREHAND, strokeType: 'overhead' })).toBeNull();
  });

  it('agrees with the "Loosen the wrist" rule', () => {
    const stiff = { ...GOOD_FOREHAND, peakAccelerationOffsetMs: -220 };
    expect(selectCue(stiff, DEFAULT_RULES).ruleId).toBe('stiff-arm');
  });
});
