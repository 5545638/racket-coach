import { describe, expect, it } from 'vitest';
import { focusByStroke, matchIdle } from '../../src/coach/coachEngine';
import {
  cueVariant,
  feedbackPhrase,
  learningSentence,
  overcorrectedPhrase,
  reinforcePhrase,
  stuckPhrase,
} from '../../src/coach/phrases';
import type { CorrectionId } from '../../src/coaching/corrections';
import type { PhraseLevel, StrokeMetrics } from '../../src/domain/types';
import { GOOD_FEATURES, GOOD_FOREHAND_V3, GOOD_SERVE } from '../fixtures';
import { type StrokeRow, baselineFrom, play, rows } from './harness';

/*
 * Example sessions as step tables: one line per stroke, "stroke → what the
 * coach says" ('—' = nothing). Expected phrases are read through the phrase
 * adapter, so the tables hold with and without the richer cue texts.
 */

const cue = (id: CorrectionId, level: PhraseLevel = 0): string => cueVariant(id, level);
const SAY = {
  better: feedbackPhrase('better'),
  same: feedbackPhrase('consistency'),
  rest: feedbackPhrase('fatigue'),
};
const line = (label: string, said: string): string => `${label} → ${said}`;

const early = (offsetMs: number): StrokeMetrics => ({
  ...GOOD_FOREHAND_V3,
  peakSpeedOffsetMs: offsetMs,
});
const face = (deg: number): StrokeMetrics => ({ ...GOOD_FOREHAND_V3, faceTiltDeg: deg });
const path = (deg: number): StrokeMetrics => ({ ...GOOD_FOREHAND_V3, swingPathDeg: deg });

describe('scenario: early acceleration ladder', () => {
  it('climbs v0 ×2, v1 ×2, v2, "Try the drill", then only every 3rd faulty stroke', () => {
    const run = play(rows(12, 'peak −100 ms', early(-100)));
    const id = 'accelerated-early';
    expect(run.table).toEqual([
      line('peak −100 ms', cue(id, 0)),
      line('peak −100 ms', cue(id, 0)),
      line('peak −100 ms', cue(id, 1)),
      line('peak −100 ms', cue(id, 1)),
      line('peak −100 ms', cue(id, 2)),
      line('peak −100 ms', stuckPhrase(id)),
      line('peak −100 ms', '—'),
      line('peak −100 ms', '—'),
      line('peak −100 ms', cue(id, 0)),
      line('peak −100 ms', '—'),
      line('peak −100 ms', '—'),
      line('peak −100 ms', cue(id, 1)),
    ]);
    expect(cue(id, 0)).toBe('Accelerate through contact');
    // The drill is named when it has a short name.
    expect(stuckPhrase(id)).toBe('Try the whoosh drill');
    // Every stroke is one technical error.
    for (const p of run.played) expect(p.step.categories.counts['technical-error']).toBe(1);
  });
});

describe('scenario: improvement', () => {
  // Changed with H2: the reinforce phrase needs two strokes inside the band
  // (one could be luck), so it moved from the first to the second fixed stroke.
  it('"Better", then the reinforce phrase on the second fixed stroke, then the focus is cleared', () => {
    const run = play([
      { label: 'peak −100 ms', metrics: early(-100) },
      { label: 'peak −60 ms', metrics: early(-60) },
      { label: 'peak 0 ms', metrics: early(0) },
      { label: 'peak 0 ms', metrics: early(0) },
      { label: 'peak 0 ms', metrics: early(0) },
    ]);
    expect(run.table).toEqual([
      line('peak −100 ms', cue('accelerated-early')),
      line('peak −60 ms', SAY.better),
      line('peak 0 ms', '—'),
      line('peak 0 ms', reinforcePhrase('accelerated-early')),
      line('peak 0 ms', '—'),
    ]);
    expect(run.played[1]?.step.categories.byElement['accelerated-early']).toBe('improvement');
    expect(run.played[2]?.step.categories.byElement['accelerated-early']).toBe('improvement');
    expect(focusByStroke(run.state).forehand).toBeNull();
  });

  // Changed with H1: "Better" no longer resets the ladder (only the reinforce
  // phrase does), and it is said at most once per 3 strokes.
  it('"Better" does not reset the ladder and comes at most once per 3 strokes', () => {
    const id = 'accelerated-early';
    const run = play([
      ...rows(3, 'peak −200 ms', early(-200)),
      ...rows(4, 'peak −150 ms', early(-150)),
    ]);
    expect(run.table).toEqual([
      line('peak −200 ms', cue(id, 0)),
      line('peak −200 ms', cue(id, 0)),
      line('peak −200 ms', cue(id, 1)),
      line('peak −150 ms', SAY.better),
      // Still better than the median, but "Better" was just said: the ladder goes on.
      line('peak −150 ms', cue(id, 1)),
      line('peak −150 ms', cue(id, 2)),
      // The median has caught up: no improvement any more, and the ladder has run out.
      line('peak −150 ms', stuckPhrase(id)),
    ]);
    expect(run.played[3]?.step.utterance.level).toBe(1);
  });

  it('the reinforce phrase resets the ladder to the variant that worked', () => {
    const id = 'path-flat';
    const run = play([
      ...rows(3, 'path 0°', path(0)),
      ...rows(2, 'path 25°', path(25)),
      ...rows(2, 'path 0°', path(0)),
    ]);
    expect(run.table).toEqual([
      line('path 0°', cue(id, 0)),
      line('path 0°', cue(id, 0)),
      line('path 0°', cue(id, 1)),
      line('path 25°', '—'),
      line('path 25°', reinforcePhrase(id)),
      line('path 0°', cue(id, 1)),
      line('path 0°', cue(id, 1)),
    ]);
  });
});

/** Deterministic N(mean, sd) samples (Box–Muller on a small LCG). */
function normals(n: number, mean: number, sd: number, seed = 7): number[] {
  let x = seed;
  const uniform = (): number => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (x + 1) / 2_147_483_649;
  };
  return Array.from(
    { length: n },
    () => mean + sd * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()),
  );
}

const spokenShare = (said: readonly string[]): number =>
  said.filter((s) => s !== '—').length / said.length;

describe('scenario: the ladder ends on a noisy or alternating player (H1)', () => {
  it('a noisy player (path ~ N(2°, 5°), limit 12°) is not talked to on every stroke', () => {
    const paths = normals(60, 2, 5);
    const run = play(paths.map((p) => ({ label: `path ${p.toFixed(0)}°`, metrics: path(p) })));
    const said = run.played.map((p) => p.said);
    // Before: 59 of 60 strokes were spoken ("Better" against the previous
    // stroke, praise for one lucky stroke, both resetting the ladder).
    expect(spokenShare(said.slice(10))).toBeLessThanOrEqual(1 / 3);
    expect(said).toContain(stuckPhrase('path-flat'));
    // "Better" at most once per 3 strokes.
    const betters = said.flatMap((s, i) => (s === SAY.better ? [i] : []));
    for (let i = 1; i < betters.length; i++) {
      expect((betters[i] ?? 0) - (betters[i - 1] ?? 0)).toBeGreaterThanOrEqual(3);
    }
  });

  it('alternating fault / ok does not get a cue or praise forever', () => {
    const run = play(
      Array.from({ length: 60 }, (_, i) =>
        i % 2 === 0
          ? { label: 'path 0°', metrics: path(0) }
          : { label: 'path 25°', metrics: path(25) },
      ),
    );
    const said = run.played.map((p) => p.said);
    expect(spokenShare(said.slice(10))).toBeLessThanOrEqual(1 / 3);
    // One stroke inside the band is not "fixed": no praise.
    expect(said).not.toContain(reinforcePhrase('path-flat'));
  });
});

describe('scenario: praise only inside the band (H2)', () => {
  it('no reinforce phrase while the focus is outside the band but not a sure fault', () => {
    // path 11°: d = 1°, p ≈ 0.62 < pMin: no fault, but not fixed either ('uncertain').
    const run = play([
      { label: 'path 0°', metrics: path(0) },
      { label: 'path 11°', metrics: path(11) },
      { label: 'path 11°', metrics: path(11) },
    ]);
    expect(run.table).toEqual([
      line('path 0°', cue('path-flat')),
      line('path 11°', '—'),
      line('path 11°', '—'),
    ]);
    expect(run.played[1]?.step.categories.byElement['path-flat']).toBe('uncertain');
  });
});

describe('scenario: no praise for a cue never heard (M1)', () => {
  it('a focus found in match mode gets no reinforce phrase in training', () => {
    const match = play([{ label: 'path 0°', metrics: path(0) }], { mode: 'match' });
    const run = play(rows(2, 'path 25°', path(25)), { state: match.state });
    expect(run.table).toEqual([line('path 25°', '—'), line('path 25°', '—')]);
  });
});

describe('scenario: slice and drive are coached separately (M3)', () => {
  it('a slice chop does not block the path cue of the next drives', () => {
    const chop: StrokeMetrics = {
      ...GOOD_FOREHAND_V3,
      swingStyle: 'slice',
      faceTiltDeg: 10,
      swingPathDeg: -50,
    };
    const run = play([
      { label: 'slice, path −50°', metrics: chop },
      ...rows(4, 'drive, path 0°', path(0)),
    ]);
    expect(run.table.slice(0, 2)).toEqual([
      line('slice, path −50°', cue('slice-chop')),
      line('drive, path 0°', cue('path-flat')),
    ]);
  });
});

describe('scenario: the drill is named when it is suggested', () => {
  it('"Try the brush-up drill" for a flat swing path', () => {
    const run = play(rows(6, 'path 0°', path(0)));
    expect(run.table.at(-1)).toBe(line('path 0°', 'Try the brush-up drill'));
  });
});

describe("scenario: the profile's best cue variant starts the ladder", () => {
  it('starts at the variant that earned the most "Better"s', () => {
    const run = play(rows(3, 'path 0°', path(0)), { preferredLevels: { 'path-flat': 1 } });
    expect(run.table).toEqual([
      line('path 0°', cue('path-flat', 1)),
      line('path 0°', cue('path-flat', 1)),
      line('path 0°', cue('path-flat', 2)),
    ]);
  });
});

describe('scenario: a break restarts the "Better" reference', () => {
  it('no "Better" against a stroke from before a 4-minute break', () => {
    const run = play([
      { label: 'path −30°', metrics: path(-30), at: 0 },
      { label: 'path −30°', metrics: path(-30), at: 5_000 },
      { label: 'after break, path −20°', metrics: path(-20), at: 5_000 + 4 * 60_000 },
    ]);
    expect(run.table.at(-1)).toBe(line('after break, path −20°', cue('path-flat', 1)));
  });
});

describe('scenario: normal variation inside the personal band', () => {
  it('stays silent and reads every deviation as variation', () => {
    const style = (i: number): StrokeMetrics => ({
      ...GOOD_FOREHAND_V3,
      faceTiltDeg: -12 + ((i % 5) - 2),
      swingPathDeg: 22 + ((i % 7) - 3),
    });
    const baseline = baselineFrom(Array.from({ length: 30 }, (_, i) => style(i)));
    const run = play(
      [0, 1, 2, 3, 4, 5].map((i) => ({
        label: `path ${String(style(i).swingPathDeg)}°`,
        metrics: style(i),
      })),
      { baseline },
    );
    expect(run.played.map((p) => p.said)).toEqual(['—', '—', '—', '—', '—', '—']);
    for (const p of run.played) {
      expect(p.step.categories.counts['technical-error']).toBe(0);
      expect(p.step.categories.byElement['path-flat']).toBe('variation');
      expect(p.step.categories.byElement['face-open']).toBe('variation');
    }
  });
});

describe('scenario: uncertain stroke', () => {
  it('gives no correction when σ is large', () => {
    const noisy: StrokeMetrics = {
      ...path(8),
      features: { ...GOOD_FEATURES, sigma: { ...GOOD_FEATURES.sigma, swingPathDeg: 12 } },
    };
    const run = play([
      { label: 'path 8°, σ 12°', metrics: noisy },
      { label: 'path 8°, σ 3.3°', metrics: path(8) },
    ]);
    expect(run.table).toEqual([
      line('path 8°, σ 12°', '—'),
      line('path 8°, σ 3.3°', cue('path-flat')),
    ]);
    expect(run.played[0]?.step.categories.byElement['path-flat']).toBe('uncertain');
    expect(run.played[1]?.step.categories.byElement['path-flat']).toBe('technical-error');
  });
});

describe('scenario: fatigue onset in a long session', () => {
  const fresh = GOOD_FOREHAND_V3;
  // −12.5 % head speed, +14 % forward swing, and sloppier: face open, short finish.
  const tired: StrokeMetrics = {
    ...GOOD_FOREHAND_V3,
    headSpeedMps: 21,
    faceTiltDeg: 8,
    followThroughArcDeg: 30,
    features: { ...GOOD_FEATURES, forwardSwingMs: 200 },
  };

  // Changed with H3: fatigue now needs the faults as well as the speed drop
  // and 15 minutes of play, so the tired strokes carry faults (coached
  // normally until the detector fires) and come every 30 s.
  it('says "Take a short break" once, freezes the focus and tags faults', () => {
    const sequence: StrokeRow[] = [
      ...rows(34, 'fresh', fresh, 0, 30_000),
      ...rows(12, 'tired', tired, 34, 30_000),
    ];
    const run = play(sequence, { detectFatigue: true });
    // The 6th tired stroke moves the median of the last 10.
    expect(run.table[39]).toBe(line('tired', SAY.rest));
    expect(run.table.slice(40)).toEqual(Array.from({ length: 6 }, () => line('tired', '—')));
    expect(run.played.filter((p) => p.said === SAY.rest)).toHaveLength(1);
    const last = run.played.at(-1)?.step;
    expect(last?.categories.byElement['face-open']).toBe('fatigue-related');
    expect(last?.utterance.reason).toBe('fatigue-hold');

    // After a 3-minute break the detector clears and coaching resumes.
    const after = play(
      [{ label: 'after break, face open', metrics: face(8), at: 45 * 30_000 + 180_000 }],
      { detectFatigue: true, state: run.state, fatigue: run.fatigue },
    );
    expect(after.played[0]?.step.utterance.reason).not.toBe('fatigue-hold');
    expect(after.played[0]?.step.categories.byElement['face-open']).toBe('technical-error');
  });

  // H3 regression: before, coaching stayed frozen for as long as the flag did.
  it('freezes coaching for at most 20 strokes, then coaches normally while still flagged', () => {
    const run = play(
      [...rows(34, 'fresh', fresh, 0, 30_000), ...rows(40, 'tired', tired, 34, 30_000)],
      { detectFatigue: true },
    );
    const reasons = run.played.map((p) => p.step.utterance.reason);
    const held = reasons.filter((r) => r === 'fatigue' || r === 'fatigue-hold');
    expect(held).toHaveLength(20);
    expect(reasons.slice(39, 59).every((r) => r === 'fatigue' || r === 'fatigue-hold')).toBe(true);
    expect(run.fatigue.byType.forehand.active).toBe(true);
    expect(reasons[59]).not.toBe('fatigue-hold');
    // Coaching is back: something about the focus is said again.
    expect(run.played.slice(59).some((p) => p.said !== '—')).toBe(true);
  });
});

describe('scenario: overcorrection', () => {
  // Changed with M2: the overcorrection phrase names the new fault and is
  // said once per episode; then the opposite gets its own cue.
  it('face open → face closed: "Now too closed" once, then "Face too closed"', () => {
    const run = play([
      { label: 'face +8°', metrics: face(8) },
      { label: 'face −40°', metrics: face(-40) },
      { label: 'face −40°', metrics: face(-40) },
      { label: 'face −40°', metrics: face(-40) },
    ]);
    expect(run.table).toEqual([
      line('face +8°', cue('face-open')),
      line('face −40°', 'Now too closed'),
      line('face −40°', cue('face-closed')),
      line('face −40°', cue('face-closed')),
    ]);
    expect(run.played[1]?.step.utterance).toMatchObject({
      kind: 'overcorrected',
      correctionId: 'face-open',
      reason: 'overcorrected',
    });
    expect(run.played[2]?.step.utterance.reason).toBe('focus-replaced');
    expect(focusByStroke(run.state).forehand).toBe('face-closed');
  });

  it('a switch the player did not hear about: the phrase once, then the cue', () => {
    const run = play(
      [
        { label: 'path 0°', metrics: path(0) },
        { label: 'path 70°', metrics: path(70) },
        { label: 'path 70°', metrics: path(70) },
      ],
      { config: { oppositeStreakToSwitch: 1 } },
    );
    expect(run.table).toEqual([
      line('path 0°', cue('path-flat')),
      line('path 70°', overcorrectedPhrase('path-steep')),
      line('path 70°', cue('path-steep')),
    ]);
    expect(overcorrectedPhrase('path-steep')).toBe('Now too steep');
    expect(run.played[1]?.step.utterance.reason).toBe('contradiction');
  });

  // M2 regression: before, a fixed and cleared focus still blocked its opposite
  // for 5 strokes with "A little less".
  it('after a focus was fixed and cleared, a new opposite fault gets its own cue', () => {
    const run = play([
      { label: 'path 0°', metrics: path(0) },
      ...rows(3, 'path 25°', path(25)),
      ...rows(3, 'path 70°', path(70)),
    ]);
    expect(run.table).toEqual([
      line('path 0°', cue('path-flat')),
      line('path 25°', '—'),
      line('path 25°', reinforcePhrase('path-flat')),
      // Third ok stroke: path-flat cleared.
      line('path 25°', '—'),
      line('path 70°', cue('path-steep')),
      line('path 70°', cue('path-steep')),
      line('path 70°', cue('path-steep', 1)),
    ]);
  });
});

describe('scenario: oscillation', () => {
  it('open / closed / open / closed: "Same swing every time" instead of either cue', () => {
    const run = play([
      { label: 'face +8°', metrics: face(8) },
      { label: 'face −40°', metrics: face(-40) },
      { label: 'face +8°', metrics: face(8) },
      { label: 'face −40°', metrics: face(-40) },
      { label: 'face +8°', metrics: face(8) },
    ]);
    expect(run.table).toEqual([
      line('face +8°', cue('face-open')),
      line('face −40°', overcorrectedPhrase('face-closed')),
      line('face +8°', cue('face-open')),
      line('face −40°', SAY.same),
      // At most once per 10 strokes: silent, and still neither cue.
      line('face +8°', '—'),
    ]);
    expect(run.played[4]?.step.utterance.reason).toBe('oscillation');
  });

  // Regression: the oscillation branch dropped decide()'s bookkeeping, so the
  // switch to the opposite (its phrase already heard) never happened.
  it('keeps the focus bookkeeping while it says "Same swing every time"', () => {
    const run = play([
      { label: 'face +8°', metrics: face(8) },
      { label: 'face −40°', metrics: face(-40) },
      { label: 'face +8°', metrics: face(8) },
      { label: 'face −40°', metrics: face(-40) },
    ]);
    expect(run.table.at(-1)).toBe(line('face −40°', SAY.same));
    expect(focusByStroke(run.state).forehand).toBe('face-closed');
  });
});

describe('scenario: match mode', () => {
  const at = (i: number): number => 1_000_000 + i * 3_000;

  it('is silent per stroke; speaks a persistent major fault between points, once per 10 min', () => {
    const strokes: StrokeRow[] = [
      { label: 'good', metrics: GOOD_FOREHAND_V3, at: at(0) },
      { label: 'face +8°', metrics: face(8), at: at(1) },
      { label: 'good', metrics: GOOD_FOREHAND_V3, at: at(2) },
      { label: 'face +8°', metrics: face(8), at: at(3) },
      { label: 'face +8°', metrics: face(8), at: at(4) },
      { label: 'face +8°', metrics: face(8), at: at(5) },
      { label: 'face +8°', metrics: face(8), at: at(6) },
    ];
    const run = play(strokes, { mode: 'match' });
    expect(run.played.map((p) => p.said)).toEqual(['—', '—', '—', '—', '—', '—', '—']);
    // Decisions are still stored.
    expect(run.played[1]?.step.utterance.kind).toBe('correction');
    expect(run.state.match.pending?.correctionId).toBe('face-open');

    // During the rally (3 s after the stroke): nothing.
    expect(matchIdle(run.state, at(6) + 3_000)).toBeNull();
    // Between points (≥ 8 s since the last stroke): the cue.
    const spoken = matchIdle(run.state, at(6) + 8_000);
    expect(spoken?.speech).toBe(cue('face-open'));
    if (!spoken) throw new Error('no cue');

    // The fault persists, but at most once per 10 minutes.
    const later = play(
      rows(6, 'face +8°', face(8), 0, 3_000).map((r) => ({ ...r, at: at(10) + (r.at ?? 0) })),
      {
        mode: 'match',
        state: spoken.state,
      },
    );
    const end = later.state.lastStrokeAt ?? 0;
    expect(matchIdle(later.state, end + 9_000)).toBeNull();
    const tenMinutes = spoken.state.match.lastSpokenAt ?? 0;
    expect(matchIdle(later.state, tenMinutes + 10 * 60_000)?.speech).toBe(cue('face-open'));
  });

  it('never speaks a minor fault or praise', () => {
    const shortFinish: StrokeMetrics = { ...GOOD_FOREHAND_V3, followThroughArcDeg: 30 };
    const run = play(rows(8, 'short finish', shortFinish), {
      mode: 'match',
      config: { speakGood: true },
    });
    expect(run.played.every((p) => p.said === '—')).toBe(true);
    expect(run.state.match.pending).toBeNull();
    const good = play(rows(3, 'good', GOOD_FOREHAND_V3), {
      mode: 'match',
      config: { speakGood: true },
    });
    expect(good.played.every((p) => p.said === '—')).toBe(true);
  });
});

describe('scenario: learning mode', () => {
  it('says the cue and then one sentence about it', () => {
    const run = play([{ label: 'path 0°', metrics: path(0) }], { mode: 'learning' });
    expect(run.table).toEqual([
      line('path 0°', `${cue('path-flat')}. ${learningSentence('path-flat')}`),
    ]);
    expect(run.played[0]?.step.utterance.spoken).toBe(cue('path-flat'));
  });

  // H4 regression: before, every correction in learning mode carried the sentence.
  it('explains only the first cue of a focus, once per correction per session', () => {
    const run = play(
      [
        ...rows(3, 'path 0°', path(0), 0, 8_000),
        ...rows(3, 'path 25°', path(25), 3, 8_000),
        ...rows(2, 'path 0°', path(0), 6, 8_000),
        // Another lane, another correction: its own explanation.
        { label: 'backhand face +8°', metrics: { ...face(8), strokeType: 'backhand' }, at: 64_000 },
      ],
      { mode: 'learning' },
    );
    expect(run.table).toEqual([
      line('path 0°', `${cue('path-flat')}. ${learningSentence('path-flat')}`),
      line('path 0°', cue('path-flat')),
      line('path 0°', cue('path-flat', 1)),
      line('path 25°', '—'),
      line('path 25°', reinforcePhrase('path-flat')),
      line('path 25°', '—'),
      // A new focus of the same correction: already explained this session.
      line('path 0°', cue('path-flat')),
      line('path 0°', cue('path-flat')),
      line('backhand face +8°', `${cue('face-open')}. ${learningSentence('face-open')}`),
    ]);
  });

  it('keeps to the short cue when the strokes come fast (gap < 6 s)', () => {
    const run = play(
      [
        { label: 'good', metrics: GOOD_FOREHAND_V3, at: 0 },
        { label: 'path 0°', metrics: path(0), at: 3_000 },
        { label: 'path 0°', metrics: path(0), at: 11_000 },
      ],
      { mode: 'learning' },
    );
    expect(run.table).toEqual([
      line('good', '—'),
      line('path 0°', cue('path-flat')),
      // Not the first cue of the focus any more.
      line('path 0°', cue('path-flat')),
    ]);
  });
});

describe('scenario: soft contradictions (M6)', () => {
  const style = (i: number): StrokeMetrics => ({
    ...GOOD_FOREHAND_V3,
    features: {
      ...GOOD_FEATURES,
      lateGainFraction: 0.28 + (i % 5) * 0.01,
      contactStabilityDps: 190 + (i % 5) * 5,
    },
  });
  const baseline = baselineFrom(Array.from({ length: 30 }, (_, i) => style(i)));
  const stiff: StrokeMetrics = {
    ...GOOD_FOREHAND_V3,
    features: { ...GOOD_FEATURES, lateGainFraction: 0.05 },
  };
  const unstable: StrokeMetrics = {
    ...GOOD_FOREHAND_V3,
    features: { ...GOOD_FEATURES, contactStabilityDps: 900 },
  };

  it('no "steady" cue within 5 strokes of "Loosen the wrist", unless it is the focus', () => {
    const run = play(
      [
        { label: 'late gain 5 %', metrics: stiff },
        ...rows(3, 'usual', style(2)),
        ...rows(3, 'unstable', unstable),
      ],
      { baseline },
    );
    expect(run.table).toEqual([
      line('late gain 5 %', 'Loosen the wrist'),
      line('usual', '—'),
      line('usual', reinforcePhrase('stiff-arm')),
      line('usual', '—'),
      // "Steady through contact" could pull against "Loosen the wrist" said
      // within the previous 5 strokes.
      line('unstable', '—'),
      line('unstable', '—'),
      line('unstable', cue('unstable-contact')),
    ]);
    expect(run.played[4]?.step.utterance.reason).toBe('soft-conflict');
  });
});

describe('scenario: player level', () => {
  it('a beginner hears only fundamental cues (weight ≥ 0.8)', () => {
    const shortFinish: StrokeMetrics = { ...GOOD_FOREHAND_V3, followThroughArcDeg: 30 };
    expect(play([{ label: 'finish 30°', metrics: shortFinish }]).table).toEqual([
      line('finish 30°', cue('short-finish')),
    ]);
    expect(
      play([{ label: 'finish 30°', metrics: shortFinish }], { inputs: { level: 'beginner' } })
        .table,
    ).toEqual([line('finish 30°', '—')]);
  });

  it('a beginner needs p ≥ 0.85', () => {
    // path 9°: d = 3°, σ = 3.3° → p ≈ 0.82.
    expect(play([{ label: 'path 9°', metrics: path(9) }]).table).toEqual([
      line('path 9°', cue('path-flat')),
    ]);
    expect(
      play([{ label: 'path 9°', metrics: path(9) }], { inputs: { level: 'beginner' } }).table,
    ).toEqual([line('path 9°', '—')]);
  });
});

describe('scenario: forehand style', () => {
  const usual = Array.from({ length: 20 }, (_, i) => path(23 + (i % 5)));

  it('a flat hitter is not nagged with "Swing low to high" at 14°', () => {
    const mixed = play([{ label: 'path 14°', metrics: path(14) }], {
      baseline: baselineFrom(usual),
    });
    expect(mixed.table).toEqual([line('path 14°', cue('path-flat'))]);
    const flat = play([{ label: 'path 14°', metrics: path(14) }], {
      inputs: { forehandStyle: 'flat' },
      baseline: baselineFrom(usual, { forehandStyle: 'flat' }),
    });
    expect(flat.table).toEqual([line('path 14°', '—')]);
    // Even without a baseline the flat limit is relaxed (8° fires for mixed only).
    expect(
      play([{ label: 'path 8°', metrics: path(8) }], { inputs: { forehandStyle: 'flat' } }).table,
    ).toEqual([line('path 8°', '—')]);
  });

  it('a topspin hitter is not told to drive through at 60°', () => {
    expect(play([{ label: 'path 60°', metrics: path(60) }]).table).toEqual([
      line('path 60°', cue('path-steep')),
    ]);
    expect(
      play([{ label: 'path 60°', metrics: path(60) }], { inputs: { forehandStyle: 'topspin' } })
        .table,
    ).toEqual([line('path 60°', '—')]);
  });
});

describe('scenario: left-handed serve', () => {
  const serve = (rollDeg: number): StrokeMetrics => {
    const features = GOOD_SERVE.features;
    if (!features?.serve) throw new Error('fixture');
    return {
      ...GOOD_SERVE,
      features: { ...features, serve: { ...features.serve, rollAngleDeg: rollDeg } },
    };
  };
  const history = (sign: 1 | -1) =>
    Array.from({ length: 20 }, (_, i) => serve(sign * (36 + (i % 9))));

  it('mirrors the roll: a left-hander pronates with a negative roll', () => {
    const left = { dominantHand: 'left' } as const;
    const run = play(
      [
        { label: 'roll −40°', metrics: serve(-40) },
        { label: 'roll +40°', metrics: serve(40) },
      ],
      { inputs: left, baseline: baselineFrom(history(-1), left) },
    );
    expect(run.table).toEqual([
      line('roll −40°', '—'),
      // A roll in the wrong direction is not pronation.
      line('roll +40°', cue('serve-no-pronation')),
    ]);
  });

  it('a right-hander pronates with a positive roll', () => {
    const run = play(
      [
        { label: 'roll +40°', metrics: serve(40) },
        { label: 'roll −40°', metrics: serve(-40) },
      ],
      { baseline: baselineFrom(history(1)) },
    );
    expect(run.table).toEqual([
      line('roll +40°', '—'),
      line('roll −40°', cue('serve-no-pronation')),
    ]);
  });
});
