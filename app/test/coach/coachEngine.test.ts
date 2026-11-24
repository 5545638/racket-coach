import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE, type PersonalBaseline, buildBaseline } from '../../src/coach/baseline';
import {
  type CoachConfig,
  type CoachState,
  DEFAULT_COACH_CONFIG,
  INITIAL_COACH_STATE,
  type Utterance,
  coachStep,
  cueForStroke,
  focusByStroke,
  ladderLevel,
  oppositeOf,
  phraseLevelOf,
} from '../../src/coach/coachEngine';
import { cueVariant, reinforcePhrase, stuckPhrase } from '../../src/coach/phrases';
import type { StrokeMetrics } from '../../src/domain/types';
import { type StrokeAssessment, assessStroke } from '../../src/elements/assess';
import { DEFAULT_ANALYSIS_PARAMS, analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import { DEFAULT_SWING, type SwingSpec, simulateSwing } from '../../src/simulation/swingModel';
import { GOOD_FOREHAND_V3, GOOD_SERVE, strokeRecord } from '../fixtures';
import { SETUP, SKEWED_MOUNT } from '../helpers';

/** Feeds strokes through assessment and the coach; returns every utterance and the final state. */
function session(
  strokes: readonly StrokeMetrics[],
  options: { baseline?: PersonalBaseline; config?: Partial<CoachConfig>; state?: CoachState } = {},
): { readonly said: Utterance[]; readonly state: CoachState } {
  const config = { ...DEFAULT_COACH_CONFIG, ...options.config };
  let state = options.state ?? INITIAL_COACH_STATE;
  const said: Utterance[] = [];
  for (const m of strokes) {
    const step = coachStep(state, assessStroke(m, options.baseline ?? EMPTY_BASELINE), config);
    state = step.state;
    said.push(step.utterance);
  }
  return { said, state };
}

const spoken = (us: readonly Utterance[]): string[] => us.map((u) => u.spoken);
const path = (deg: number): StrokeMetrics => ({ ...GOOD_FOREHAND_V3, swingPathDeg: deg });
const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
const flatCue = (level: 0 | 1 | 2): string => cueVariant('path-flat', level);

describe('coach engine', () => {
  // Intent changed with the adaptive coach: a persistent fault now walks the
  // phrase ladder (v0, v0, v1, v1, v2, "Try the drill", then every 3rd stroke)
  // instead of "three times, then two silent strokes".
  it('walks the phrase ladder on a persistent fault instead of repeating one cue', () => {
    const { said, state } = session(repeat(9, path(0)));
    expect(spoken(said)).toEqual([
      flatCue(0),
      flatCue(0),
      flatCue(1),
      flatCue(1),
      flatCue(2),
      stuckPhrase('path-flat'),
      '',
      '',
      flatCue(0),
    ]);
    expect(said.map((u) => u.kind)).toEqual([
      'correction',
      'correction',
      'correction',
      'correction',
      'correction',
      'stuck',
      'silent',
      'silent',
      'correction',
    ]);
    expect(said.map((u) => u.level)).toEqual([0, 0, 1, 1, 2, undefined, undefined, undefined, 0]);
    expect(said[6]).toMatchObject({ reason: 'ladder-sparse', correctionId: 'path-flat' });
    expect(focusByStroke(state).forehand).toBe('path-flat');
  });

  // Changed with H1: "Better" now comes at most once per 3 strokes, so it can
  // no longer run three times in a row; the repeat limit is shown with "Good".
  it('still pauses a phrase said three times in a row ("Good")', () => {
    const { said } = session(repeat(6, GOOD_FOREHAND_V3), { config: { speakGood: true } });
    expect(said.map((u) => u.spoken)).toEqual(['Good', 'Good', 'Good', '', '', 'Good']);
    expect(said[3]).toMatchObject({ kind: 'silent', reason: 'repeat-pause' });
  });

  it('says "Better" at most once per 3 strokes, even when every stroke improves', () => {
    const { said } = session([path(-30), path(-24), path(-18), path(-12), path(-6)]);
    expect(said.map((u) => u.kind)).toEqual([
      'correction',
      'better',
      'correction',
      'correction',
      'better',
    ]);
  });

  it('says "Better" after a clear improvement of the focus fault', () => {
    // d: 12° → 3°; √(3.3² + 3.3²) ≈ 4.7° < 9°.
    const { said } = session([path(0), path(9)]);
    expect(said[1]).toMatchObject({ kind: 'better', spoken: 'Better', correctionId: 'path-flat' });
  });

  it('repeats the cue when the change is within measurement noise', () => {
    // d: 12° → 9°: 3° < 4.7°.
    const { said } = session([path(0), path(3)]);
    expect(said[1]).toMatchObject({ kind: 'correction', reason: 'focus-persists' });
  });

  // Changed with H2: praise needs two strokes inside the band in a row.
  it('says "That\'s it" when the fault is gone twice and clears the focus after three ok strokes', () => {
    const { said, state } = session([path(0), path(25), path(25)]);
    expect(said[1]).toMatchObject({ kind: 'good', spoken: '' });
    expect(said[2]).toMatchObject({ kind: 'keep-it', spoken: reinforcePhrase('path-flat') });
    expect(focusByStroke(state).forehand).toBe('path-flat');
    const after = session([path(25)], { state });
    expect(focusByStroke(after.state).forehand).toBeNull();
    expect(after.said[0]?.kind).toBe('good');
  });

  it('says "Good" only when asked to', () => {
    expect(session([GOOD_FOREHAND_V3]).said[0]).toMatchObject({ kind: 'good', spoken: '' });
    const loud = session([GOOD_FOREHAND_V3], { config: { speakGood: true } });
    expect(loud.said[0]).toMatchObject({ kind: 'good', spoken: 'Good' });
  });

  it('lets a much bigger new fault take over the focus, but not a small one', () => {
    // Focus: path 8° (d = 4°, score ≈ 0.91).
    const small = session([path(8), { ...path(8), faceTiltDeg: 2 }]);
    expect(small.said[1]?.correctionId).toBe('path-flat');
    const big = session([path(8), { ...path(8), faceTiltDeg: 15 }]);
    expect(big.said[1]).toMatchObject({
      kind: 'correction',
      correctionId: 'face-open',
      reason: 'focus-replaced',
      spoken: 'Face too open',
    });
    expect(focusByStroke(big.state).forehand).toBe('face-open');
  });

  it('gives no face cue without an attitude anchor, but can give a timing cue', () => {
    const noAnchor: StrokeMetrics = {
      ...GOOD_FOREHAND_V3,
      swingStyle: null,
      faceTiltDeg: 25,
      swingPathDeg: null,
      backswingPauseMs: 450,
    };
    // A face value without its σ (attitude not trusted) must not fire either.
    const features = GOOD_FOREHAND_V3.features;
    if (!features) throw new Error('fixture');
    const stroke = {
      ...noAnchor,
      features: { ...features, sigma: { ...features.sigma, faceTiltDeg: null } },
    };
    const { said } = session([stroke]);
    expect(said[0]).toMatchObject({ kind: 'correction', correctionId: 'hitch' });
  });

  it('stays silent on a shadow swing and keeps its state', () => {
    const start = session([path(0)]).state;
    const step = coachStep(
      start,
      assessStroke({ ...path(0), impactDetected: false }, EMPTY_BASELINE),
    );
    expect(step.utterance).toMatchObject({ kind: 'silent', spoken: '', reason: 'no-contact' });
    expect(step.state).toBe(start);
  });

  it('stays silent while the focus cannot be assessed and drops it after five such strokes', () => {
    const blind = { ...path(0), swingPathDeg: null };
    const { said, state } = session([path(0), ...repeat(4, blind)]);
    expect(said.slice(1).every((u) => u.reason === 'focus-not-assessable')).toBe(true);
    expect(focusByStroke(state).forehand).toBe('path-flat');
    const after = session([blind], { state });
    expect(focusByStroke(after.state).forehand).toBeNull();
  });

  it('keeps a separate focus per stroke type', () => {
    const backhand: StrokeMetrics = {
      ...GOOD_FOREHAND_V3,
      strokeType: 'backhand',
      faceTiltDeg: 12,
    };
    const { said, state } = session([path(0), backhand, path(0)]);
    expect(said.map((u) => u.correctionId)).toEqual(['path-flat', 'face-open', 'path-flat']);
    expect(focusByStroke(state)).toEqual({
      forehand: 'path-flat',
      backhand: 'face-open',
      overhead: null,
    });
  });

  it('only corrects a backhand on its face without a baseline', () => {
    const backhand: StrokeMetrics = {
      ...GOOD_FOREHAND_V3,
      strokeType: 'backhand',
      swingPathDeg: 0,
      racketDropDeg: 5,
      followThroughArcDeg: 30,
    };
    expect(session([backhand]).said[0]?.kind).toBe('good');
    expect(session([{ ...backhand, faceTiltDeg: -45 }]).said[0]?.correctionId).toBe('face-closed');
  });

  it('gives no correction to a stable personal style once the baseline exists', () => {
    const style = (i: number): StrokeMetrics => ({
      ...GOOD_FOREHAND_V3,
      faceTiltDeg: -4 + (i % 3),
      swingPathDeg: 15 + (i % 4),
    });
    const history = Array.from({ length: 20 }, (_, i) => strokeRecord(style(i), i + 1));
    const { said } = session(
      Array.from({ length: 10 }, (_, i) => style(i)),
      { baseline: buildBaseline(history) },
    );
    expect(said.every((u) => u.kind === 'good')).toBe(true);
  });

  it('does not correct serves before a baseline exists', () => {
    const { said } = session([GOOD_SERVE]);
    expect(said[0]).toMatchObject({ kind: 'silent', reason: 'not-assessable' });
  });
});

describe('legacy cue of a coached stroke', () => {
  const cueOf = (strokes: readonly StrokeMetrics[]) => {
    const { said } = session(strokes);
    const last = strokes.at(-1);
    const u = said.at(-1);
    if (!last || !u) throw new Error('empty');
    return cueForStroke(u, assessStroke(last, EMPTY_BASELINE));
  };

  it('records the fault even when the coach says "Better" or stays silent', () => {
    expect(cueOf([path(0)])).toEqual({
      ruleId: 'path-flat',
      severity: 'fix',
      text: 'Swing low to high',
    });
    expect(cueOf([path(0), path(9)]).ruleId).toBe('path-flat');
    expect(cueOf(repeat(4, path(0))).severity).toBe('fix');
  });

  it('marks good strokes good, shadow swings counted and unjudged serves counted', () => {
    expect(cueOf([path(0), path(25)])).toMatchObject({ severity: 'good', ruleId: 'good' });
    expect(cueOf([GOOD_FOREHAND_V3]).severity).toBe('good');
    expect(cueOf([{ ...GOOD_FOREHAND_V3, impactDetected: false }]).ruleId).toBe('not-rated');
    expect(cueOf([GOOD_SERVE]).ruleId).toBe('not-rated');
  });
});

describe('coaching simulated strokes', () => {
  const LONG = { ...SETUP, durationS: 2.4, contactTimeS: 1.6 };
  const simulate = (overrides: Partial<SwingSpec>, seed: number): StrokeMetrics => {
    const spec = {
      ...DEFAULT_SWING,
      backswingRateRadPerS: 6,
      noiseStd: { accelG: 0.01, gyroDps: 0.3 },
      seed,
      ...overrides,
    };
    const params = { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: spec.leverRadiusM };
    return analyzeSwing(toImuSeries(simulateSwing(spec, LONG).capture), SKEWED_MOUNT, params);
  };

  // Changed with H2: the praise comes on the second fixed stroke.
  it('corrects a flat swing path and then praises the fix', () => {
    const flat = [1, 2, 3].map((seed) => simulate({ swingPathDeg: 0 }, seed));
    const fixed = [4, 5].map((seed) => simulate({ swingPathDeg: 25 }, seed));
    for (const m of [...flat, ...fixed]) expect(m.impactDetected).toBe(true);
    const { said } = session([...flat, ...fixed]);
    expect(spoken(said)).toEqual([
      flatCue(0),
      flatCue(0),
      flatCue(1),
      '',
      reinforcePhrase('path-flat'),
    ]);
  });

  it('stays silent on a shadow swing', () => {
    const shadow = simulate({ swingPathDeg: 0, withImpact: false }, 5);
    expect(shadow.impactDetected).toBe(false);
    expect(session([shadow]).said[0]?.kind).toBe('silent');
  });
});

describe('coach engine review fixes', () => {
  const assess = (m: StrokeMetrics): StrokeAssessment => assessStroke(m, EMPTY_BASELINE);
  /** The same assessment with its path fault element patched. */
  const patched = (
    m: StrokeMetrics,
    patch: Partial<StrokeAssessment['faults'][number]>,
  ): StrokeAssessment => {
    const a = assess(m);
    const change = (e: StrokeAssessment['faults'][number]) =>
      e.correctionId === 'path-flat' ? { ...e, ...patch } : e;
    return { ...a, elements: a.elements.map(change), faults: a.faults.map(change) };
  };
  const runAll = (steps: readonly [StrokeAssessment, boolean][]) => {
    let state = INITIAL_COACH_STATE;
    const said: Utterance[] = [];
    for (const [a, speaking] of steps) {
      const step = coachStep(state, a, DEFAULT_COACH_CONFIG, speaking);
      state = step.state;
      said.push(step.utterance);
    }
    return { said, state };
  };

  it('does not say "Better" across elements of one correction with different units', () => {
    // 12° → 3° would be "Better", but the second reading is another element (other unit).
    const { said } = runAll([
      [assess(path(0)), true],
      [patched(path(9), { key: 'path-flat-other' }), true],
    ]);
    expect(said[1]).toMatchObject({ kind: 'correction', reason: 'focus-persists' });
    // The new key is stored, so the next stroke of that element can be "Better".
    const third = runAll([
      [assess(path(0)), true],
      [patched(path(3), { key: 'path-flat-other' }), true],
      [patched(path(9), { key: 'path-flat-other' }), true],
    ]);
    expect(third.said[2]?.kind).toBe('better');
  });

  it('does not say "Better" when the band changed since the last stroke', () => {
    const { said } = runAll([
      [assess(path(0)), true],
      [patched(path(9), { bandSource: 'personal' }), true],
    ]);
    expect(said[1]).toMatchObject({ kind: 'correction', reason: 'focus-persists' });
    const moved = assess(path(9)).faults[0]?.band;
    if (!moved) throw new Error('fixture');
    const shifted = runAll([
      [assess(path(0)), true],
      [patched(path(9), { band: { ...moved, lo: (moved.lo ?? 0) + 1 } }), true],
    ]);
    expect(shifted.said[1]?.kind).toBe('correction');
  });

  it('records no fix for a focus that was not assessable on this stroke', () => {
    const blind = { ...path(0), swingPathDeg: null };
    const a = assess(blind);
    const { said } = runAll([
      [assess(path(0)), true],
      [a, true],
    ]);
    expect(said[1]?.reason).toBe('focus-not-assessable');
    expect(cueForStroke(said[1] as Utterance, a).severity).not.toBe('fix');
  });

  it('keeps the repeat count and the one-shot phrases for drill while nothing is heard', () => {
    // Rally strokes do not use up the three repetitions.
    const rally = runAll([
      ...repeat(3, [assess(path(0)), false] as [StrokeAssessment, boolean]),
      ...repeat(3, [assess(path(0)), true] as [StrokeAssessment, boolean]),
    ]);
    expect(spoken(rally.said.slice(3))).toEqual([flatCue(0), flatCue(0), flatCue(1)]);
    // An unheard "Better" is still said later.
    const better = runAll([
      [assess(path(0)), true],
      [assess(path(9)), false],
      [assess(path(9)), true],
    ]);
    expect(better.said[2]?.kind).toBe('better');
    // So is an unheard "That's it".
    const thatsIt = runAll([
      [assess(path(0)), true],
      [assess(path(25)), false],
      [assess(path(25)), true],
    ]);
    expect(thatsIt.said[2]).toMatchObject({
      kind: 'keep-it',
      spoken: reinforcePhrase('path-flat'),
    });
  });

  it('starts a returning cue fresh after the focus was cleared', () => {
    const blind = { ...path(0), swingPathDeg: null };
    const { said } = runAll([
      ...repeat(3, [assess(path(0)), true] as [StrokeAssessment, boolean]),
      ...repeat(5, [assess(blind), true] as [StrokeAssessment, boolean]),
      [assess(path(0)), true],
    ]);
    expect(said.at(-1)).toMatchObject({ kind: 'correction', spoken: 'Swing low to high' });
  });
});

describe('adaptive coach building blocks', () => {
  it('maps the n-th spoken correction to a variant from the base', () => {
    expect([1, 2, 3, 4, 5].map((n) => ladderLevel(n, 0))).toEqual([0, 0, 1, 1, 2]);
    expect([1, 2, 3, 4, 5].map((n) => ladderLevel(n, 2))).toEqual([2, 2, 0, 0, 1]);
  });

  it('pairs only corrections of the same metric as opposites', () => {
    expect(oppositeOf('face-open')).toBe('face-closed');
    expect(oppositeOf('path-steep')).toBe('path-flat');
    expect(oppositeOf('slice-chop')).toBeNull();
    expect(oppositeOf('slice-face-closed')).toBeNull();
    expect(oppositeOf('high-takeback')).toBeNull();
  });

  it('classifies a shadow swing as not assessable and returns no speech', () => {
    const step = coachStep(
      INITIAL_COACH_STATE,
      assessStroke({ ...path(0), impactDetected: false }, EMPTY_BASELINE),
    );
    expect(step.speech).toBeNull();
    expect(step.categories.counts['technical-error']).toBe(0);
    expect(step.categories.counts['not-assessable']).toBeGreaterThan(0);
  });

  it('records the cue variant of a correction and the one that worked for "Better"', () => {
    const { said } = session([path(-30), path(-30), path(-30), path(-24)]);
    expect(said.map(phraseLevelOf)).toEqual([0, 0, 1, 1]);
    expect(said[3]?.kind).toBe('better');
  });
});
