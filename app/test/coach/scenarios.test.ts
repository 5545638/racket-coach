import { describe, expect, it } from 'vitest';
import { focusByStroke, matchIdle } from '../../src/coach/coachEngine';
import {
  cueVariant,
  feedbackPhrase,
  learningSentence,
  reinforcePhrase,
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
  stuck: feedbackPhrase('stuck'),
  less: feedbackPhrase('overcorrected'),
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
      line('peak −100 ms', SAY.stuck),
      line('peak −100 ms', '—'),
      line('peak −100 ms', '—'),
      line('peak −100 ms', cue(id, 0)),
      line('peak −100 ms', '—'),
      line('peak −100 ms', '—'),
      line('peak −100 ms', cue(id, 1)),
    ]);
    expect(cue(id, 0)).toBe('Accelerate through contact');
    // Every stroke is one technical error.
    for (const p of run.played) expect(p.step.categories.counts['technical-error']).toBe(1);
  });
});

describe('scenario: improvement', () => {
  it('"Better", then the reinforce phrase, then the focus is cleared', () => {
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
      line('peak 0 ms', reinforcePhrase('accelerated-early')),
      line('peak 0 ms', '—'),
      line('peak 0 ms', '—'),
    ]);
    expect(run.played[1]?.step.categories.byElement['accelerated-early']).toBe('improvement');
    expect(run.played[2]?.step.categories.byElement['accelerated-early']).toBe('improvement');
    expect(focusByStroke(run.state).forehand).toBeNull();
  });

  it('keeps the variant that worked after "Better"', () => {
    const id = 'accelerated-early';
    const run = play([
      ...rows(3, 'peak −200 ms', early(-200)),
      { label: 'peak −150 ms', metrics: early(-150) },
      ...rows(3, 'peak −150 ms', early(-150)),
    ]);
    expect(run.table).toEqual([
      line('peak −200 ms', cue(id, 0)),
      line('peak −200 ms', cue(id, 0)),
      line('peak −200 ms', cue(id, 1)),
      line('peak −150 ms', SAY.better),
      // The ladder restarts from variant 1, the one that earned the "Better".
      line('peak −150 ms', cue(id, 1)),
      line('peak −150 ms', cue(id, 1)),
      line('peak −150 ms', cue(id, 2)),
    ]);
    expect(run.played[3]?.step.utterance.level).toBe(1);
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
  const tired: StrokeMetrics = {
    ...GOOD_FOREHAND_V3,
    headSpeedMps: 21, // −12.5 %
    features: { ...GOOD_FEATURES, forwardSwingMs: 200 }, // +14 %
  };
  const tiredFaulty: StrokeMetrics = { ...tired, faceTiltDeg: 8 };

  it('says "Take a short break" once, freezes the focus and tags faults', () => {
    const sequence: StrokeRow[] = [
      ...rows(34, 'fresh', fresh, 0, 20_000),
      ...rows(6, 'slower', tired, 34, 20_000),
      ...rows(6, 'slower + face open', tiredFaulty, 40, 20_000),
    ];
    const run = play(sequence, { detectFatigue: true });
    const tail = run.table.slice(33);
    expect(tail).toEqual([
      line('fresh', '—'),
      line('slower', '—'),
      line('slower', '—'),
      line('slower', '—'),
      line('slower', '—'),
      line('slower', '—'),
      // 40 rated strokes, last-10 median speed −12.5 %, forward swing +14 %.
      line('slower', SAY.rest),
      line('slower + face open', '—'),
      line('slower + face open', '—'),
      line('slower + face open', '—'),
      line('slower + face open', '—'),
      line('slower + face open', '—'),
      line('slower + face open', '—'),
    ]);
    expect(run.played.filter((p) => p.said === SAY.rest)).toHaveLength(1);
    // No new focus while tired; the face faults are fatigue-related.
    expect(focusByStroke(run.state).forehand).toBeNull();
    const last = run.played.at(-1)?.step;
    expect(last?.categories.byElement['face-open']).toBe('fatigue-related');
    expect(last?.utterance.reason).toBe('fatigue-hold');

    // After a 3-minute break the detector clears and coaching resumes.
    const after = play(
      [{ label: 'after break, face open', metrics: face(8), at: 46 * 20_000 + 180_000 }],
      {
        detectFatigue: true,
        state: run.state,
        fatigue: run.fatigue,
      },
    );
    expect(after.table).toEqual([line('after break, face open', cue('face-open'))]);
  });
});

describe('scenario: overcorrection', () => {
  it('face open → face closed: "A little less", and the focus stays until the third', () => {
    const run = play([
      { label: 'face +8°', metrics: face(8) },
      { label: 'face −40°', metrics: face(-40) },
      { label: 'face −40°', metrics: face(-40) },
      { label: 'face −40°', metrics: face(-40) },
    ]);
    expect(run.table).toEqual([
      line('face +8°', cue('face-open')),
      line('face −40°', SAY.less),
      line('face −40°', SAY.less),
      // Third opposite fault in a row: the focus switches, but "Face too
      // closed" would contradict "Face too open" said 3 strokes ago.
      line('face −40°', SAY.less),
    ]);
    expect(run.played[1]?.step.utterance).toMatchObject({
      kind: 'overcorrected',
      correctionId: 'face-open',
      reason: 'overcorrected',
    });
    expect(run.played[3]?.step.utterance.reason).toBe('contradiction');
    expect(focusByStroke(run.state).forehand).toBe('face-closed');
  });

  it('never contradicts a cue of the last 5 strokes', () => {
    const run = play([
      { label: 'path 0°', metrics: path(0) },
      ...rows(3, 'path 25°', path(25)),
      ...rows(3, 'path 70°', path(70)),
    ]);
    expect(run.table).toEqual([
      line('path 0°', cue('path-flat')),
      line('path 25°', reinforcePhrase('path-flat')),
      line('path 25°', '—'),
      // Third ok stroke: path-flat cleared.
      line('path 25°', '—'),
      // New focus path-steep, but "Swing low to high" was said 4 strokes ago.
      line('path 70°', SAY.less),
      // Still within 5 strokes of it (strokes 1–5 before this one).
      line('path 70°', SAY.less),
      // The window (the previous 5 strokes) is clear: the steep cue may be said.
      line('path 70°', cue('path-steep')),
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
      line('face −40°', SAY.less),
      line('face +8°', cue('face-open')),
      line('face −40°', SAY.same),
      // At most once per 10 strokes: silent, and still neither cue.
      line('face +8°', '—'),
    ]);
    expect(run.played[4]?.step.utterance.reason).toBe('oscillation');
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
