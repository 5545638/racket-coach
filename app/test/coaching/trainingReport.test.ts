import { describe, expect, it } from 'vitest';
import {
  MIN_CONSISTENCY_STROKES,
  NOISE_FLOORS,
  consistencyOf,
  overallConsistency,
  speedEstimate,
  spreadScore,
} from '../../src/coaching/consistency';
import { strokeVerdict, tallyCorrections, verdictCounts } from '../../src/coaching/strokeFacts';
import {
  IMPROVEMENT_MIN_STROKES,
  buildTrainingReport,
  topErrors,
  topStrengths,
} from '../../src/coaching/trainingReport';
import type {
  DeviationCategory,
  StrokeCoaching,
  StrokeMetrics,
  StrokeRecord,
  UtteranceKind,
} from '../../src/domain/types';
import { GOOD_FOREHAND_V3, GOOD_SERVE, strokeRecord } from '../fixtures';

const EMPTY = {
  'technical-error': 0,
  uncertain: 0,
  variation: 0,
  'not-assessable': 0,
  'fatigue-related': 0,
  improvement: 0,
} as const;

/** A stroke with element categories by key, a spoken utterance and optional metric patch. */
function stroke(
  at: number,
  byElement: Record<string, DeviationCategory> | null,
  utterance: UtteranceKind = 'silent',
  patch: Partial<StrokeMetrics> = {},
  base: StrokeMetrics = GOOD_FOREHAND_V3,
): StrokeRecord {
  const r = strokeRecord({ ...base, ...patch }, at);
  if (byElement === null) return r;
  const counts = { ...EMPTY };
  for (const c of Object.values(byElement)) counts[c]++;
  const coach: StrokeCoaching = {
    utterance,
    correctionId: null,
    focus: null,
    mode: 'training',
    categories: { counts, byElement },
  };
  return { ...r, coach };
}

describe('strokeVerdict: one category per stroke', () => {
  const ok = { 'face-open': 'variation', 'path-flat': 'variation' } as const;
  it('gives each situation exactly one verdict', () => {
    expect(strokeVerdict(stroke(1, { ...ok, hitch: 'technical-error' }, 'correction'))).toBe(
      'correction',
    );
    expect(strokeVerdict(stroke(1, { ...ok, hitch: 'technical-error' }, 'silent'))).toBe(
      'fault-silent',
    );
    expect(strokeVerdict(stroke(1, { ...ok, hitch: 'fatigue-related' }))).toBe('fatigue');
    expect(
      strokeVerdict(
        stroke(1, { ...ok, hitch: 'fatigue-related', 'face-closed': 'technical-error' }),
      ),
    ).toBe('fault-silent');
    expect(strokeVerdict(stroke(1, { ...ok, hitch: 'uncertain' }))).toBe('uncertain');
    expect(strokeVerdict(stroke(1, ok))).toBe('style');
    expect(strokeVerdict(stroke(1, { 'face-open': 'improvement' }, 'better'))).toBe('style');
    expect(strokeVerdict(stroke(1, { 'face-open': 'not-assessable' }))).toBe('not-assessable');
    expect(strokeVerdict(stroke(1, {}))).toBe('not-assessable');
  });

  it('reads older records by their cue', () => {
    const base = strokeRecord(GOOD_FOREHAND_V3, 1);
    const withCue = (severity: 'good' | 'fix' | 'none'): StrokeRecord => ({
      ...base,
      cue: { ruleId: 'face-open', severity, text: 'x' },
    });
    expect(strokeVerdict(withCue('fix'))).toBe('correction');
    expect(strokeVerdict(withCue('good'))).toBe('style');
    expect(strokeVerdict(withCue('none'))).toBe('not-assessable');
  });

  it('counts strokes, not elements: 9 strokes never give "99"', () => {
    const many = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`e${i}`, 'not-assessable' as const]),
    );
    const records = Array.from({ length: 9 }, (_, i) => stroke(i, many));
    const counts = verdictCounts(records);
    expect(counts['not-assessable']).toBe(9);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(9);
  });
});

describe('tallyCorrections', () => {
  it('counts judged, faulty and in-band strokes per correction', () => {
    const t = tallyCorrections([
      stroke(1, { 'face-open': 'variation', hitch: 'technical-error' }),
      stroke(2, { 'face-open': 'uncertain', hitch: 'not-assessable' }),
      stroke(3, { 'face-open': 'technical-error' }),
    ]);
    const get = (id: string) => t.find((x) => x.correctionId === id);
    expect(get('face-open')).toMatchObject({ assessed: 3, faults: 1, inBand: 1 });
    expect(get('hitch')).toMatchObject({ assessed: 1, faults: 1, inBand: 0 });
  });

  it('treats older rated records as judged on every correction, one fault at most', () => {
    const base = strokeRecord(GOOD_FOREHAND_V3, 1);
    const fix: StrokeRecord = { ...base, cue: { ruleId: 'face-open', severity: 'fix', text: 'x' } };
    const t = tallyCorrections([base, fix, stroke(3, { hitch: 'variation' })]);
    expect(t.find((x) => x.correctionId === 'face-open')).toMatchObject({ assessed: 2, faults: 1 });
    expect(t.find((x) => x.correctionId === 'hitch')).toMatchObject({ assessed: 3, faults: 0 });
  });
});

describe('consistency score', () => {
  const withValues = (n: number, f: (i: number) => Partial<StrokeMetrics>): StrokeRecord[] =>
    Array.from({ length: n }, (_, i) => strokeRecord({ ...GOOD_FOREHAND_V3, ...f(i) }, i));

  it('is 100 within the noise floor and falls off with the spread', () => {
    expect(spreadScore(0, 3)).toBe(100);
    expect(spreadScore(3, 3)).toBe(100);
    expect(spreadScore(6, 3)).toBeCloseTo(77.9, 1);
    expect(spreadScore(15, 3)).toBeCloseTo(36.8, 1);
    expect(spreadScore(30, 3)).toBeLessThan(spreadScore(15, 3));
  });

  it('identical strokes score 100; a wide spread scores low', () => {
    const same = consistencyOf(withValues(8, () => ({})));
    expect(same?.score).toBe(100);
    expect(same?.n).toBe(8);
    const wild = consistencyOf(
      withValues(10, (i) => ({
        faceTiltDeg: -40 + i * 8,
        swingPathDeg: 0 + i * 8,
        headSpeedMps: 10 + i * 2,
      })),
    );
    expect(wild?.score).toBeLessThan(40);
  });

  it('uses the MAD, so one outlier does not matter', () => {
    const records = withValues(11, (i) => (i === 0 ? { faceTiltDeg: 60 } : {}));
    expect(consistencyOf(records)?.parts.face).toBe(100);
  });

  it('needs enough strokes and skips slices and clipped speeds', () => {
    expect(consistencyOf(withValues(MIN_CONSISTENCY_STROKES - 1, () => ({})))).toBeNull();
    expect(consistencyOf([])).toBeNull();
    const slices = withValues(10, (i) => ({ swingStyle: 'slice', faceTiltDeg: i * 10 }));
    expect(consistencyOf(slices)?.parts.face).toBeNull();
    const clipped = withValues(10, (i) => ({
      headSpeedMps: 10 + i * 3,
      quality: { ...GOOD_FOREHAND_V3.quality, gyroSaturated: true },
    }));
    expect(consistencyOf(clipped)?.parts.speed).toBeNull();
  });

  it('uses the engine noise floors', () => {
    expect(NOISE_FLOORS.faceDeg).toBe(3);
    expect(NOISE_FLOORS.pathDeg).toBe(3.5);
  });

  it('weights the session score by stroke type counts', () => {
    const fh = withValues(10, () => ({}));
    const serves = Array.from({ length: 5 }, (_, i) =>
      strokeRecord({ ...GOOD_SERVE, faceTiltDeg: i * 30 }, 100 + i),
    );
    const all = overallConsistency([...fh, ...serves]);
    expect(all?.n).toBe(15);
    expect(all?.score).toBeGreaterThan(60);
    expect(all?.score).toBeLessThan(100);
  });
});

describe('speedEstimate', () => {
  it('averages speeds and marks clipped ones as a lower bound', () => {
    const a = strokeRecord({ ...GOOD_FOREHAND_V3, headSpeedMps: 20 }, 1);
    const b = strokeRecord(
      {
        ...GOOD_FOREHAND_V3,
        headSpeedMps: 30,
        quality: { ...GOOD_FOREHAND_V3.quality, gyroSaturated: true },
      },
      2,
    );
    expect(speedEstimate([a])).toEqual({ meanMps: 20, n: 1, lowerBound: false });
    expect(speedEstimate([a, b])).toEqual({ meanMps: 25, n: 2, lowerBound: true });
    expect(speedEstimate([])).toBeNull();
  });

  it('ignores strokes without contact', () => {
    const noContact = strokeRecord({ ...GOOD_FOREHAND_V3, impactDetected: false }, 1);
    expect(speedEstimate([noContact])).toBeNull();
  });
});

describe('buildTrainingReport', () => {
  it('handles no strokes', () => {
    const r = buildTrainingReport([]);
    expect(r.totals).toEqual({ all: 0, forehand: 0, backhand: 0, overhead: 0 });
    expect(r.speed).toEqual({});
    expect(r.overallConsistency).toBeNull();
    expect(r.strengths).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.improvement.enough).toBe(false);
    expect(r.durationMs).toBeNull();
    expect(r.mode).toBeNull();
  });

  it('handles serves only and records without features', () => {
    const serves = Array.from({ length: 6 }, (_, i) => strokeRecord(GOOD_SERVE, i * 1000));
    const r = buildTrainingReport(serves);
    expect(r.totals).toMatchObject({ all: 6, overhead: 6, forehand: 0 });
    expect(Object.keys(r.speed)).toEqual(['overhead']);
    expect(r.durationMs).toBe(5000);
    const bare = strokeRecord({ ...GOOD_FOREHAND_V3, ...{ features: undefined } } as never, 1);
    const b = buildTrainingReport([bare]);
    expect(b.totals.all).toBe(1);
    expect(b.verdicts.style).toBe(1);
  });

  it('reports a clipped speed as a lower bound', () => {
    const r = buildTrainingReport([
      strokeRecord(
        { ...GOOD_FOREHAND_V3, quality: { ...GOOD_FOREHAND_V3.quality, gyroSaturated: true } },
        1,
      ),
    ]);
    expect(r.speed.forehand?.lowerBound).toBe(true);
  });

  it('lists strengths only with ≥ 10 judged strokes and a high in-band share', () => {
    const fine = Array.from({ length: 12 }, (_, i) =>
      stroke(i, { 'face-open': 'variation', hitch: i < 3 ? 'technical-error' : 'variation' }),
    );
    const few = [stroke(100, { 'path-flat': 'variation' })];
    const s = topStrengths([...fine, ...few]);
    expect(s.map((x) => x.correctionId)).toEqual(['face-open', 'hitch']);
    expect(s[0]?.share).toBe(1);
    expect(s[1]?.share).toBe(0.75);
    expect(topStrengths(fine.slice(0, 9))).toEqual([]);
  });

  it('lists the top 3 errors by count with their share, ignoring one-offs', () => {
    const records = [
      ...Array.from({ length: 6 }, (_, i) => stroke(i, { 'face-open': 'technical-error' })),
      ...Array.from({ length: 4 }, (_, i) => stroke(10 + i, { hitch: 'technical-error' })),
      ...Array.from({ length: 3 }, (_, i) => stroke(20 + i, { 'path-flat': 'technical-error' })),
      ...Array.from({ length: 2 }, (_, i) => stroke(30 + i, { 'path-steep': 'technical-error' })),
      stroke(40, { 'small-turn': 'technical-error' }),
    ];
    const errors = topErrors(records);
    expect(errors.map((e) => e.correctionId)).toEqual(['face-open', 'hitch', 'path-flat']);
    expect(errors[0]).toMatchObject({ count: 6, assessed: 6, share: 1 });
  });

  it('compares the halves only from 20 strokes', () => {
    const run = (n: number): StrokeRecord[] =>
      Array.from({ length: n }, (_, i) =>
        stroke(i, { 'face-open': i < n / 2 ? 'technical-error' : 'variation' }),
      );
    expect(buildTrainingReport(run(IMPROVEMENT_MIN_STROKES - 1)).improvement.enough).toBe(false);
    const imp = buildTrainingReport(run(24)).improvement;
    expect(imp.enough).toBe(true);
    expect(imp.errors[0]).toMatchObject({ first: 1, second: 0, direction: 'better' });
  });

  it('flags a worsening fault and an unchanged one', () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      stroke(i, {
        'face-open': i >= 10 ? 'technical-error' : 'variation',
        hitch: i % 2 === 0 ? 'technical-error' : 'variation',
      }),
    );
    const imp = buildTrainingReport(records).improvement;
    const by = Object.fromEntries(imp.errors.map((e) => [e.correctionId, e.direction]));
    expect(by['face-open']).toBe('worse');
    expect(by.hitch).toBe('same');
  });

  it('takes the mode from the strokes', () => {
    const r = buildTrainingReport([stroke(1, {}), stroke(2, {})]);
    expect(r.mode).toBe('training');
  });
});
