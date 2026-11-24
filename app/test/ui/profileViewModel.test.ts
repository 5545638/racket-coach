import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import { buildPlan } from '../../src/coach/plan';
import {
  DEFAULT_PLAYER_INPUTS,
  type PlayerProfile,
  type TypicalSwing,
  type Weakness,
} from '../../src/coach/profile';
import { FEEDBACK_LABELS } from '../../src/coaching/corrections';
import { EMPTY_COUNTS } from '../../src/coach/classify';
import type { StrokeCoaching } from '../../src/domain/types';
import {
  SPARK_HEIGHT,
  SPARK_WIDTH,
  categorySummary,
  inputsSummary,
  liveExtras,
  matchLiveView,
  planViews,
  profileViewModel,
  sessionAdaptive,
  sparkline,
  typicalViews,
} from '../../src/ui/profileViewModel';
import { GOOD_FOREHAND_V3, strokeRecord } from '../fixtures';

const none: TypicalSwing = {
  n: 0,
  headSpeedMps: null,
  swingPathDeg: null,
  faceTiltDeg: null,
  brushAngleDeg: null,
  forwardSwingMs: null,
  takebackTurnDeg: null,
  followThroughArcDeg: null,
};

const weakness = (patch: Partial<Weakness> = {}): Weakness => ({
  correctionId: 'path-flat',
  label: 'x',
  weight: 1,
  faultRate: 0.32,
  faults: 32,
  assessed: 100,
  sessions: 3,
  isNew: false,
  trend: 'improving',
  sessionRates: [0.5, 0.4, 0.32],
  ...patch,
});

const profile = (patch: Partial<PlayerProfile> = {}): PlayerProfile => ({
  inputs: DEFAULT_PLAYER_INPUTS,
  baseline: EMPTY_BASELINE,
  typical: { forehand: none, backhand: none, overhead: none },
  weaknesses: [],
  progress: [],
  betterByLevel: {},
  ratedStrokes: 0,
  ...patch,
});

describe('sparkline', () => {
  it('draws nothing for no sessions and a single dot for one', () => {
    const empty = sparkline([]);
    expect(empty.points).toEqual([]);
    expect(empty.path).toBe('');
    const one = sparkline([0.3]);
    expect(one.path).toBe('');
    expect(one.points).toHaveLength(1);
    expect(one.points[0]?.x).toBe(SPARK_WIDTH / 2);
  });

  it('scales rates to the top of the box and spaces sessions evenly', () => {
    const s = sparkline([0, 0.5, 1]);
    expect(s.yMax).toBe(1);
    expect(s.points.map((p) => p.x)).toEqual([5, 80, 155]);
    expect(s.points.map((p) => p.y)).toEqual([SPARK_HEIGHT - 5, SPARK_HEIGHT / 2, 5]);
    expect(s.path).toBe(`M5 ${SPARK_HEIGHT - 5} L80 ${SPARK_HEIGHT / 2} L155 5`);
    expect(s.percents).toEqual([0, 50, 100]);
  });

  it('keeps a floor of 20 % for the scale and rounds the top up to 10 %', () => {
    expect(sparkline([0.05, 0.1]).yMax).toBe(0.2);
    expect(sparkline([0.05, 0.33]).yMax).toBe(0.4);
  });

  it('keeps the last 12 sessions only and stays inside the box', () => {
    const rates = Array.from({ length: 20 }, (_, i) => i / 20);
    const s = sparkline(rates);
    expect(s.points).toHaveLength(12);
    expect(s.percents[0]).toBe(40);
    for (const p of s.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(SPARK_WIDTH);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(SPARK_HEIGHT);
    }
  });
});

describe('profile sections', () => {
  it('summarises the player inputs in the UI language', () => {
    const rows = inputsSummary(DEFAULT_PLAYER_INPUTS, 'et');
    expect(rows.map((r) => r.id)).toEqual(['hand', 'backhand', 'style', 'level']);
    expect(rows[0]).toEqual({ id: 'hand', label: 'Mängiv käsi', value: 'Parem' });
  });

  it('formats the typical stroke with a typographic minus and dashes for unknowns', () => {
    const typical = {
      forehand: {
        ...none,
        n: 42,
        headSpeedMps: 25,
        swingPathDeg: 20,
        faceTiltDeg: -3.2,
        forwardSwingMs: 180,
        takebackTurnDeg: 80,
        followThroughArcDeg: 120,
      },
      backhand: none,
      overhead: none,
    };
    const views = typicalViews(typical, 'et');
    expect(views).toHaveLength(1);
    const rows = Object.fromEntries((views[0]?.rows ?? []).map((r) => [r.id, r.value]));
    expect(views[0]?.n).toBe(42);
    expect(rows).toMatchObject({
      speed: '90 km/h',
      path: '20°',
      face: '−3°',
      brush: '—',
      forward: '180 ms',
      takeback: '80°',
      follow: '120°',
    });
  });

  it('shows weaknesses with rate, sessions and trend', () => {
    const view = profileViewModel(
      profile({
        weaknesses: [weakness(), weakness({ correctionId: 'face-open', trend: 'worsening' })],
        ratedStrokes: 100,
      }),
      { items: [], basedOnStrokes: 100 },
      'et',
    );
    expect(view.weaknesses[0]).toMatchObject({
      rate: '32%',
      sessionsText: '3 trenni',
      trendLabel: 'paraneb',
      arrow: '↑',
    });
    expect(view.weaknesses[1]).toMatchObject({ trendLabel: 'halveneb', arrow: '↓' });
    expect(view.progress[0]?.aria).toBe(
      `${view.progress[0]?.label}: vigade osakaal trennis, 50%, 40%, 32%`,
    );
    expect(view.empty).toBe(false);
  });

  it('limits progress to the top three weaknesses with session rates', () => {
    const ws = ['path-flat', 'face-open', 'face-closed', 'path-steep'].map((id, i) =>
      weakness({
        correctionId: id as Weakness['correctionId'],
        sessionRates: i === 1 ? [] : [0.3, 0.2],
      }),
    );
    expect(
      profileViewModel(profile({ weaknesses: ws }), { items: [], basedOnStrokes: 0 }, 'en')
        .progress,
    ).toHaveLength(3);
  });

  it('is empty without history', () => {
    const p = profile();
    const view = profileViewModel(p, buildPlan(p, 'et'), 'et');
    expect(view.empty).toBe(true);
    expect(view.typical).toEqual([]);
    expect(view.weaknesses).toEqual([]);
    expect(view.plan).toEqual([]);
    expect(view.inputs).toHaveLength(4);
  });
});

describe('plan formatting', () => {
  it('shows title, drill, 3 × 15 balls, best cue and target', () => {
    const p = profile({
      // The target starts from the latest session's rate (30 %).
      weaknesses: [weakness({ faultRate: 0.3, sessionRates: [0.5, 0.4, 0.3] })],
      ratedStrokes: 100,
    });
    const [item] = planViews(buildPlan(p, 'et'), 'et');
    expect(item).toMatchObject({
      kind: 'weakness',
      volume: '3 × 15 palli',
      target: 'Eesmärk: alla 15% vigu',
    });
    expect(item?.drill.length).toBeGreaterThan(0);
    expect(item?.cue).toBe('Swing low to high');
    expect(planViews(buildPlan(p, 'en'), 'en')[0]?.target).toBe('Goal: under 15% faults');
  });

  it('labels the maintenance item', () => {
    const p = profile({
      weaknesses: [weakness()],
      progress: [
        {
          sessionId: 'a',
          startedAt: 1,
          label: null,
          rated: 50,
          elements: {},
          corrections: { 'face-open': 0.5 },
        },
        {
          sessionId: 'b',
          startedAt: 2,
          label: null,
          rated: 50,
          elements: {},
          corrections: { 'face-open': 0.1 },
        },
      ],
      ratedStrokes: 100,
    });
    const items = planViews(buildPlan(p, 'et'), 'et');
    expect(items.at(-1)).toMatchObject({
      kind: 'maintenance',
      volume: '1 × 15 palli',
      kindLabel: 'Hoia samas vaimus',
    });
    expect(items.at(-1)?.target).toBe('Eesmärk: hoia alla 10% vigu');
  });
});

describe('live extras', () => {
  it('summarises categories, leaving out zeros', () => {
    const counts = {
      ...EMPTY_COUNTS,
      'technical-error': 1,
      variation: 6,
      uncertain: 2,
      'not-assessable': 3,
    };
    expect(categorySummary(counts, 'et')).toBe('Viga 1 · Sinu stiil 6 · Ebakindel 2 · Hindamata 3');
    expect(categorySummary(counts, 'en')).toBe('Fault 1 · Your style 6 · Unsure 2 · Not judged 3');
    expect(categorySummary(EMPTY_COUNTS, 'et')).toBeNull();
    expect(categorySummary(null, 'et')).toBeNull();
  });

  const correction = {
    kind: 'correction',
    correctionId: 'path-flat',
    spoken: 'Swing low to high',
    reason: 'new-focus',
  } as const;

  it('adds the learning sentence only in learning mode', () => {
    const base = {
      utterance: correction,
      fatigueActive: false,
      categories: null,
      language: 'et',
    } as const;
    expect(liveExtras({ ...base, mode: 'learning' }).learningLine).toMatch(/\w/);
    expect(liveExtras({ ...base, mode: 'training' }).learningLine).toBeNull();
  });

  it('shows the fatigue badge while fatigue is active', () => {
    const base = { mode: 'training', utterance: null, categories: null } as const;
    expect(liveExtras({ ...base, fatigueActive: true, language: 'et' }).fatigueBadge).toBe(
      'Väsinud',
    );
    expect(liveExtras({ ...base, fatigueActive: false, language: 'et' }).fatigueBadge).toBeNull();
  });

  it('keeps match mode minimal', () => {
    const e = liveExtras({
      mode: 'match',
      utterance: correction,
      fatigueActive: false,
      categories: { ...EMPTY_COUNTS, 'technical-error': 2 },
      language: 'et',
    });
    expect(e.categoryLine).toBeNull();
    expect(e.learningLine).toBeNull();
  });

  it('match view: counter, stroke type, and a fault only after it was spoken', () => {
    expect(
      matchLiveView({ count: 7, strokeType: 'backhand', lastSpeech: null, language: 'et' }),
    ).toEqual({
      count: 7,
      strokeType: 'Backhand',
      pendingFault: null,
    });
    const spoken = matchLiveView({
      count: 9,
      strokeType: 'forehand',
      lastSpeech: 'Swing low to high',
      language: 'en',
    });
    expect(spoken.pendingFault).toBeTruthy();
    expect(
      matchLiveView({ count: 0, strokeType: null, lastSpeech: null, language: 'en' }).strokeType,
    ).toBeNull();
  });
});

describe('session adaptive summary', () => {
  const rec = (utterance: StrokeCoaching['utterance'], technical: number) => ({
    ...strokeRecord(GOOD_FOREHAND_V3, 1),
    coach: {
      utterance,
      correctionId: null,
      focus: null,
      categories: {
        counts: { ...EMPTY_COUNTS, 'technical-error': technical, variation: 2 },
        byElement: {},
      },
    } satisfies StrokeCoaching,
  });

  it('sums categories and counts each feedback kind with its label', () => {
    const s = sessionAdaptive(
      [
        rec('better', 1),
        rec('keep-it', 0),
        rec('overcorrected', 2),
        rec('fatigue', 0),
        strokeRecord(GOOD_FOREHAND_V3, 2),
      ],
      'et',
    );
    expect(s.categories.find((c) => c.id === 'technical-error')?.count).toBe(3);
    expect(s.categories.find((c) => c.id === 'variation')?.count).toBe(8);
    const byKind = Object.fromEntries(s.feedback.map((f) => [f.kind, f.count]));
    expect(byKind).toEqual({
      better: 1,
      'keep-it': 1,
      overcorrected: 1,
      consistency: 0,
      fatigue: 1,
      stuck: 0,
    });
    expect(s.feedback[2]?.label).toBe(FEEDBACK_LABELS.et.overcorrected);
  });
});
