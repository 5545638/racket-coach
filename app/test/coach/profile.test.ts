import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import {
  DEFAULT_PLAYER_INPUTS,
  EMPTY_PROFILE_STATE,
  LEVEL_POLICY,
  STYLE_PATH_LIMITS,
  addStrokeToProfile,
  buildProfileState,
  coachingPolicy,
  deriveProfile,
  servePronationDeg,
  trendOf,
} from '../../src/coach/profile';
import type { StrokeMetrics, StrokeRecord } from '../../src/domain/types';
import { ELEMENT_CATALOG } from '../../src/elements/catalog';
import { GOOD_FOREHAND_V3, GOOD_SERVE, strokeRecord } from '../fixtures';
import { coachedRecord } from './harness';

const path = (deg: number): StrokeMetrics => ({ ...GOOD_FOREHAND_V3, swingPathDeg: deg });
const early = (ms: number): StrokeMetrics => ({ ...GOOD_FOREHAND_V3, peakSpeedOffsetMs: ms });

/** A session of `count` forehands; the first `flat` have a flat path, the next `earlyCount` peak early. */
function session(
  id: string,
  start: number,
  count: number,
  faults: { flat?: number; early?: number } = {},
): StrokeRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const flat = i < (faults.flat ?? 0);
    const isEarly = !flat && i < (faults.flat ?? 0) + (faults.early ?? 0);
    const m = flat ? path(0) : isEarly ? early(-100) : GOOD_FOREHAND_V3;
    return coachedRecord(m, id, start + i * 1000);
  });
}

describe('player policy from the inputs', () => {
  it('defaults: every element, pMin 0.8, literature path limits', () => {
    const p = coachingPolicy();
    expect(p.inputs).toEqual(DEFAULT_PLAYER_INPUTS);
    expect(p.assess.pMin).toBe(0.8);
    expect(p.catalog).toHaveLength(ELEMENT_CATALOG.length);
    const flat = p.catalog.find((s) => s.key === 'path-flat');
    expect(flat?.populationLimit).toBe(12);
    expect(flat?.populationOnly).toBeUndefined();
  });

  it('beginner: only elements with weight ≥ 0.8 and pMin 0.85; advanced: all', () => {
    const beginner = coachingPolicy({ ...DEFAULT_PLAYER_INPUTS, level: 'beginner' });
    expect(beginner.assess.pMin).toBe(LEVEL_POLICY.beginner.pMin);
    expect(beginner.catalog.every((s) => s.weight >= 0.8)).toBe(true);
    expect(beginner.catalog.map((s) => s.key)).toContain('accelerated-early');
    expect(beginner.catalog.map((s) => s.key)).not.toContain('short-finish');
    // The baseline still keeps every element.
    expect(beginner.baselineCatalog).toHaveLength(ELEMENT_CATALOG.length);
    expect(coachingPolicy({ ...DEFAULT_PLAYER_INPUTS, level: 'advanced' }).catalog).toHaveLength(
      ELEMENT_CATALOG.length,
    );
  });

  it('flat and topspin styles relax one side of the swing path', () => {
    const flat = coachingPolicy({ ...DEFAULT_PLAYER_INPUTS, forehandStyle: 'flat' }).catalog;
    expect(flat.find((s) => s.key === 'path-flat')).toMatchObject({
      populationLimit: STYLE_PATH_LIMITS.flatMinDeg,
      populationOnly: true,
    });
    expect(flat.find((s) => s.key === 'path-steep')?.populationLimit).toBe(55);
    const topspin = coachingPolicy({ ...DEFAULT_PLAYER_INPUTS, forehandStyle: 'topspin' }).catalog;
    expect(topspin.find((s) => s.key === 'path-steep')).toMatchObject({
      populationLimit: STYLE_PATH_LIMITS.topspinMaxDeg,
      populationOnly: true,
    });
    expect(topspin.find((s) => s.key === 'path-flat')?.populationLimit).toBe(12);
  });

  it('reads serve pronation for the playing hand; the wrong direction counts as none', () => {
    const serve = (roll: number): StrokeMetrics => {
      const f = GOOD_SERVE.features;
      if (!f?.serve) throw new Error('fixture');
      return { ...GOOD_SERVE, features: { ...f, serve: { ...f.serve, rollAngleDeg: roll } } };
    };
    expect(servePronationDeg(serve(40), 'right')).toBe(40);
    expect(servePronationDeg(serve(-40), 'right')).toBe(0);
    expect(servePronationDeg(serve(-40), 'left')).toBe(40);
    expect(servePronationDeg(serve(40), 'left')).toBe(0);
    const left = coachingPolicy({ ...DEFAULT_PLAYER_INPUTS, dominantHand: 'left' });
    const spec = left.catalog.find((s) => s.key === 'serve-no-pronation');
    expect(spec?.value(serve(-30))).toBe(30);
  });
});

describe('profile from the stroke history', () => {
  const history = [
    ...session('s1', 1_000_000, 30, { flat: 6, early: 18 }),
    ...session('s2', 2_000_000, 30, { flat: 9, early: 12 }),
    ...session('s3', 3_000_000, 30, { flat: 15, early: 6 }),
  ];
  const sessions = [
    { id: 's1', startedAt: 1_000_000, label: 'Monday' },
    { id: 's2', startedAt: 2_000_000, label: 'Wednesday' },
    { id: 's3', startedAt: 3_000_000, label: 'Friday' },
  ];

  it('finds the weaknesses (≥ 20 % over the last 200 rated strokes, in ≥ 2 sessions) with their trend', () => {
    const profile = deriveProfile(
      buildProfileState(history, sessions),
      DEFAULT_PLAYER_INPUTS,
      EMPTY_BASELINE,
    );
    const byId = new Map(profile.weaknesses.map((w) => [w.correctionId, w]));
    // path-flat: 30/90 ≈ 33 %, getting worse (20 % → 30 % → 50 %).
    expect(byId.get('path-flat')).toMatchObject({
      faults: 30,
      assessed: 90,
      sessions: 3,
      trend: 'worsening',
    });
    expect(byId.get('path-flat')?.sessionRates).toEqual([0.2, 0.3, 0.5]);
    // accelerated-early: 36/90 = 40 %, getting better (60 % → 40 % → 20 %).
    expect(byId.get('accelerated-early')).toMatchObject({ trend: 'improving', weight: 0.8 });
    expect(byId.get('accelerated-early')?.faultRate).toBeCloseTo(0.4, 12);
    expect(profile.weaknesses).toHaveLength(2);
    expect(profile.ratedStrokes).toBe(90);
  });

  it('needs faults in two sessions', () => {
    const one = [...session('a', 0, 30, { flat: 20 }), ...session('b', 100_000, 30)];
    const profile = deriveProfile(buildProfileState(one), DEFAULT_PLAYER_INPUTS, EMPTY_BASELINE);
    expect(profile.weaknesses).toEqual([]);
  });

  it('uses only the last 200 rated strokes', () => {
    const old = session('old', 0, 150, { flat: 150 });
    const recent = [...session('n1', 1_000_000, 100), ...session('n2', 2_000_000, 100)];
    const state = buildProfileState([...old, ...recent]);
    expect(state.window).toHaveLength(200);
    expect(deriveProfile(state, DEFAULT_PLAYER_INPUTS, EMPTY_BASELINE).weaknesses).toEqual([]);
  });

  it('keeps per-session progress per element, oldest first, with labels', () => {
    const progress = deriveProfile(
      buildProfileState(history, sessions),
      DEFAULT_PLAYER_INPUTS,
      EMPTY_BASELINE,
    ).progress;
    expect(progress.map((p) => p.label)).toEqual(['Monday', 'Wednesday', 'Friday']);
    const first = progress[0]?.elements['path-flat'];
    expect(first).toEqual({ n: 30, faultRate: 0.2, median: 25 });
    expect(progress[2]?.elements['path-flat']?.faultRate).toBe(0.5);
    expect(progress[2]?.corrections['path-flat']).toBe(0.5);
    expect(progress[0]?.rated).toBe(30);
  });

  it('gives the typical swing per stroke type', () => {
    const records = [140, 150, 160].map((ms, i) =>
      strokeRecord(
        { ...GOOD_FOREHAND_V3, headSpeedMps: 20 + i * 2, forwardSwingArcDeg: ms },
        i + 1,
      ),
    );
    const typical = deriveProfile(
      buildProfileState(records),
      DEFAULT_PLAYER_INPUTS,
      EMPTY_BASELINE,
    ).typical;
    expect(typical.forehand).toMatchObject({
      n: 3,
      headSpeedMps: 22,
      swingPathDeg: 25,
      faceTiltDeg: -12,
      brushAngleDeg: 37,
      forwardSwingMs: 175,
      takebackTurnDeg: 90,
      followThroughArcDeg: 260,
    });
    expect(typical.backhand.n).toBe(0);
    expect(typical.backhand.headSpeedMps).toBeNull();
  });

  it('is updated incrementally to the same result as a rebuild', () => {
    const incremental = history.reduce((s, r) => addStrokeToProfile(s, r), EMPTY_PROFILE_STATE);
    const derive = (s: typeof incremental) =>
      deriveProfile(s, DEFAULT_PLAYER_INPUTS, EMPTY_BASELINE);
    expect(derive(incremental)).toEqual(derive(buildProfileState(history)));
  });

  it('reads older records by their stored cue', () => {
    const legacy = (m: StrokeMetrics, session: string, t: number): StrokeRecord => {
      const fix = m.swingPathDeg === 0;
      return {
        ...strokeRecord(m, t),
        id: `${session}-${String(t)}`,
        sessionId: session,
        cue: fix
          ? { ruleId: 'path-flat', severity: 'fix', text: 'Swing low to high' }
          : { ruleId: 'good', severity: 'good', text: 'Good' },
      };
    };
    const records = [
      ...Array.from({ length: 20 }, (_, i) => legacy(i < 8 ? path(0) : GOOD_FOREHAND_V3, 'x', i)),
      ...Array.from({ length: 20 }, (_, i) =>
        legacy(i < 8 ? path(0) : GOOD_FOREHAND_V3, 'y', 100 + i),
      ),
    ];
    const profile = deriveProfile(
      buildProfileState(records),
      DEFAULT_PLAYER_INPUTS,
      EMPTY_BASELINE,
    );
    expect(profile.weaknesses.map((w) => w.correctionId)).toEqual(['path-flat']);
    // Element fault rates are unknown without stored categories.
    expect(profile.progress[0]?.elements['path-flat']?.faultRate).toBeNull();
  });

  it('counts the "Better"s per cue variant', () => {
    const better = (level: 0 | 1 | 2, t: number) =>
      coachedRecord(path(0), 's', t, {
        utterance: 'better',
        correctionId: 'path-flat',
        phraseLevel: level,
      });
    const state = buildProfileState([better(1, 1), better(1, 2), better(2, 3)]);
    expect(state.betterByLevel['path-flat']).toEqual([0, 2, 1]);
  });

  it('trend: latest session against the mean of up to three earlier ones', () => {
    expect(trendOf([0.3], 0.1)).toBe('stable');
    expect(trendOf([0.3, 0.35], 0.1)).toBe('stable');
    expect(trendOf([0.5, 0.5, 0.3], 0.1)).toBe('improving');
    expect(trendOf([0.9, 0.1, 0.1, 0.1, 0.25], 0.1)).toBe('worsening');
  });
});
