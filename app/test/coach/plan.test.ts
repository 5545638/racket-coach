import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import { cueVariant } from '../../src/coach/phrases';
import {
  type PlanEnhancer,
  bestLevel,
  buildPlan,
  rankWeaknesses,
  targetRate,
} from '../../src/coach/plan';
import {
  DEFAULT_PLAYER_INPUTS,
  type PlayerProfile,
  type SessionProgress,
  type Weakness,
} from '../../src/coach/profile';
import { CORRECTIONS } from '../../src/coaching/corrections';

const weakness = (patch: Partial<Weakness> & Pick<Weakness, 'correctionId'>): Weakness => ({
  label: patch.correctionId,
  weight: 1,
  faultRate: 0.3,
  faults: 30,
  assessed: 100,
  sessions: 3,
  trend: 'stable',
  sessionRates: [],
  ...patch,
});

const progress = (corrections: SessionProgress['corrections'], i: number): SessionProgress => ({
  sessionId: `s${String(i)}`,
  startedAt: i,
  label: null,
  rated: 50,
  elements: {},
  corrections,
});

const profile = (patch: Partial<PlayerProfile>): PlayerProfile => ({
  inputs: DEFAULT_PLAYER_INPUTS,
  baseline: EMPTY_BASELINE,
  typical: {
    forehand: emptyTypical,
    backhand: emptyTypical,
    overhead: emptyTypical,
  },
  weaknesses: [],
  progress: [],
  betterByLevel: {},
  ratedStrokes: 120,
  ...patch,
});
const emptyTypical = {
  n: 0,
  headSpeedMps: null,
  swingPathDeg: null,
  faceTiltDeg: null,
  brushAngleDeg: null,
  forwardSwingMs: null,
  takebackTurnDeg: null,
  followThroughArcDeg: null,
};

describe('training plan', () => {
  it('ranks worsening weaknesses first, then by weight × fault rate', () => {
    const ranked = rankWeaknesses([
      weakness({ correctionId: 'face-open', weight: 1, faultRate: 0.5 }),
      weakness({ correctionId: 'short-finish', weight: 0.5, faultRate: 0.3, trend: 'worsening' }),
      weakness({ correctionId: 'path-flat', weight: 0.9, faultRate: 0.6 }),
    ]);
    expect(ranked.map((w) => w.correctionId)).toEqual(['short-finish', 'path-flat', 'face-open']);
  });

  it('plans up to two weaknesses: catalogue drill, 3 × 15 balls, the cue that worked, a target', () => {
    const plan = buildPlan(
      profile({
        weaknesses: [
          weakness({ correctionId: 'face-open', faultRate: 0.5 }),
          weakness({ correctionId: 'path-flat', weight: 0.9, faultRate: 0.6, trend: 'worsening' }),
          weakness({ correctionId: 'hitch', weight: 0.8, faultRate: 0.25 }),
        ],
        betterByLevel: { 'path-flat': [1, 3, 2] },
      }),
      'et',
    );
    expect(plan.items.map((i) => [i.kind, i.correctionId])).toEqual([
      ['weakness', 'path-flat'],
      ['weakness', 'face-open'],
    ]);
    const [first] = plan.items;
    expect(first).toMatchObject({
      drill: CORRECTIONS.et['path-flat'].drill,
      sets: 3,
      ballsPerSet: 15,
      cueLevel: 1,
      cue: cueVariant('path-flat', 1),
      currentFaultRate: 0.6,
      targetFaultRate: 0.3,
      trend: 'worsening',
    });
    expect(plan.basedOnStrokes).toBe(120);
  });

  it('adds one maintenance item for the best-improved correction', () => {
    const plan = buildPlan(
      profile({
        weaknesses: [weakness({ correctionId: 'face-open' })],
        progress: [
          progress({ hitch: 0.5, 'face-open': 0.6, 'short-finish': 0.3 }, 1),
          progress({ hitch: 0.1, 'face-open': 0.2, 'short-finish': 0.2 }, 2),
        ],
      }),
    );
    expect(plan.items.at(-1)).toMatchObject({
      kind: 'maintenance',
      correctionId: 'hitch',
      sets: 1,
      currentFaultRate: 0.1,
      targetFaultRate: 0.1,
      trend: 'improving',
    });
  });

  it('is empty without weaknesses or improvement', () => {
    expect(buildPlan(profile({})).items).toEqual([]);
  });

  it('picks the variant with the most "Better"s; variant 0 by default', () => {
    expect(bestLevel(undefined)).toBe(0);
    expect(bestLevel([0, 0, 0])).toBe(0);
    expect(bestLevel([1, 1, 2])).toBe(2);
    expect(bestLevel([2, 2, 1])).toBe(0);
  });

  it('targets half the current rate, at least 10 %, rounded up to 5 %', () => {
    expect(targetRate(0.6)).toBe(0.3);
    expect(targetRate(0.33)).toBe(0.2);
    expect(targetRate(0.12)).toBe(0.1);
  });

  it('leaves an enhancer interface that is optional and asynchronous', async () => {
    // Only the shape is defined; nothing in the app implements or calls it.
    const identity: PlanEnhancer = { enhance: (plan) => Promise.resolve(plan) };
    const plan = buildPlan(profile({}));
    await expect(identity.enhance(plan, profile({}), { language: 'en' })).resolves.toBe(plan);
  });
});
