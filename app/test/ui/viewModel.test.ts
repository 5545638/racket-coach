import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE, buildBaseline } from '../../src/coach/baseline';
import { INITIAL_COACH_STATE, type Utterance, coachStep } from '../../src/coach/coachEngine';
import { CORRECTIONS } from '../../src/coaching/corrections';
import { NOT_RATED_CUE } from '../../src/coaching/rules';
import type { StrokeCoaching, StrokeMetrics, StrokeRecord } from '../../src/domain/types';
import { assessStroke } from '../../src/elements/assess';
import {
  formatMeasure,
  liveViewModel,
  metricGroups,
  sessionCoachSummary,
} from '../../src/ui/viewModel';
import { GOOD_FOREHAND_V3, GOOD_SERVE, strokeRecord, withFeatures } from '../fixtures';

const GOOD_CUE = { ruleId: 'good', severity: 'good', text: 'Good' } as const;
const flat: StrokeMetrics = { ...GOOD_FOREHAND_V3, swingPathDeg: 0 };

function view(
  metrics: StrokeMetrics,
  options: {
    language?: 'et' | 'en';
    baselineCount?: number;
    loading?: boolean;
    utterance?: Utterance | null;
  } = {},
) {
  const assessment = assessStroke(metrics, EMPTY_BASELINE);
  const step = coachStep(INITIAL_COACH_STATE, assessment);
  const utterance = options.utterance === undefined ? step.utterance : options.utterance;
  return liveViewModel({
    metrics,
    assessment,
    utterance,
    cue: GOOD_CUE,
    focus: step.state.byStroke[metrics.strokeType].focus?.correctionId ?? null,
    baselineCount: options.baselineCount ?? 0,
    baselineLoading: options.loading ?? false,
    language: options.language ?? 'et',
  });
}

describe('live view model: headline', () => {
  it('shows the correction title in the UI language with the English cue small', () => {
    const et = view(flat, { language: 'et' });
    expect(et.headline.kind).toBe('correction');
    expect(et.headline.title).toBe(CORRECTIONS.et['path-flat'].title);
    expect(et.headline.spoken).toBe('Swing low to high');
    const en = view(flat, { language: 'en' });
    expect(en.headline.title).toBe(CORRECTIONS.en['path-flat'].title);
  });

  it('shows why / change / drill from the correction catalogue', () => {
    const { blocks } = view(flat, { language: 'et' });
    const c = CORRECTIONS.et['path-flat'];
    expect(blocks).toEqual({ why: c.explanation, change: c.adjustment, drill: c.drill });
  });

  it.each([
    ['better', 'Paremini', 'Better'],
    ['keep-it', 'Just nii', "That's it"],
    ['good', 'Hea', 'Good'],
  ] as const)('names a "%s" utterance in both languages', (kind, et, en) => {
    const utterance: Utterance = {
      kind,
      spoken: kind === 'good' ? '' : en,
      reason: kind === 'better' ? 'improved' : kind === 'keep-it' ? 'focus-ok' : 'no-faults',
      ...(kind === 'good' ? {} : { correctionId: 'path-flat' as const }),
    };
    expect(view(GOOD_FOREHAND_V3, { language: 'et', utterance }).headline.title).toBe(et);
    const english = view(GOOD_FOREHAND_V3, { language: 'en', utterance });
    expect(english.headline.title).toBe(en);
    expect(english.blocks).toBeNull();
  });

  it('counts a silent stroke and says why', () => {
    const noContact = { ...GOOD_FOREHAND_V3, impactDetected: false };
    const m = view(noContact, { language: 'et' });
    expect(m.headline).toMatchObject({
      kind: 'silent',
      title: 'Löök loetud',
      detail: 'Palli tabamust ei tuvastatud.',
      spoken: null,
    });
    const quiet: Utterance = { kind: 'silent', spoken: '', reason: 'not-assessable' };
    expect(view(GOOD_FOREHAND_V3, { language: 'en', utterance: quiet }).headline).toMatchObject({
      title: 'Counted',
      detail: 'Not enough data to judge this stroke yet.',
    });
  });

  it('falls back to the legacy guidance for a stroke without an utterance', () => {
    const legacy = liveViewModel({
      metrics: GOOD_FOREHAND_V3,
      assessment: null,
      utterance: null,
      cue: NOT_RATED_CUE,
      focus: null,
      baselineCount: 0,
      baselineLoading: false,
      language: 'en',
    });
    expect(legacy.headline.title).toBe('Counted');
    expect(legacy.blocks?.why).toContain('counted');
  });
});

describe('live view model: focus and baseline', () => {
  it('reports the confidence of the focus fault and what it is compared with', () => {
    const m = view(flat, { language: 'et' });
    expect(m.focus.correctionId).toBe('path-flat');
    expect(m.focus.status).toBe('fault');
    const p = assessStroke(flat, EMPTY_BASELINE).faults[0]?.probability ?? 0;
    expect(m.focus.confidencePercent).toBe(Math.min(99, Math.round(p * 100)));
    expect(m.focus.comparedWith).toBe('Võrdlus: viitepiirid');
  });

  it('compares with the usual stroke once the baseline is active', () => {
    const records = Array.from({ length: 20 }, (_, i) => strokeRecord(GOOD_FOREHAND_V3, i));
    const baseline = buildBaseline(records);
    const assessment = assessStroke(flat, baseline);
    const m = liveViewModel({
      metrics: flat,
      assessment,
      utterance: coachStep(INITIAL_COACH_STATE, assessment).utterance,
      cue: GOOD_CUE,
      focus: 'path-flat',
      baselineCount: 20,
      baselineLoading: false,
      language: 'en',
    });
    expect(m.focus.comparedWith).toMatch(/^Compared with: your usual stroke \(20 strokes\)/);
    expect(m.baselineProgress).toBeNull();
  });

  it('says the focus is fine, or not judged, when it is not at fault', () => {
    const ok = liveViewModel({
      metrics: GOOD_FOREHAND_V3,
      assessment: assessStroke(GOOD_FOREHAND_V3, EMPTY_BASELINE),
      utterance: null,
      cue: GOOD_CUE,
      focus: 'path-flat',
      baselineCount: 0,
      baselineLoading: false,
      language: 'et',
    });
    expect(ok.focus).toMatchObject({ status: 'ok', confidencePercent: null });
    expect(ok.focus.statusText).toBe('sellel löögil korras');
    const none = view(GOOD_FOREHAND_V3);
    expect(none.focus.status).toBe('none');
  });

  it('shows baseline progress below 15 strokes only', () => {
    expect(view(flat, { baselineCount: 9 }).baselineProgress).toBe('Isiklik baas: 9/15 lööki');
    expect(view(flat, { baselineCount: 9, language: 'en' }).baselineProgress).toBe(
      'Personal baseline: 9/15 strokes',
    );
    expect(view(flat, { baselineCount: 15 }).baselineProgress).toBeNull();
    expect(view(flat, { loading: true }).baselineProgress).toBe('Laen isiklikku baasi…');
  });
});

describe('live view model: metric rows', () => {
  const rows = (m: StrokeMetrics, language: 'et' | 'en' = 'et') =>
    metricGroups(m, assessStroke(m, EMPTY_BASELINE), language).flatMap((g) => g.rows);
  const row = (id: string, m: StrokeMetrics, language: 'et' | 'en' = 'et') =>
    rows(m, language).find((r) => r.id === id);

  it('shows assessed values with ± σ and a proper minus sign', () => {
    expect(row('face', GOOD_FOREHAND_V3)).toMatchObject({ value: '−12° ± 2°', status: 'ok' });
  });

  it('marks a fault and shows the limit that was crossed', () => {
    expect(row('path', flat)).toMatchObject({ status: 'fault', note: 'Piir ≥ 12°' });
    expect(row('path', flat, 'en')?.note).toBe('Limit ≥ 12°');
  });

  it('greys out values that cannot be judged and gives the reason', () => {
    const miss = { ...GOOD_FOREHAND_V3, impactDetected: false };
    expect(row('face', miss)).toMatchObject({
      status: 'not-assessable',
      note: 'Palli tabamust ei olnud',
    });
    // Personal baseline only, no baseline yet.
    expect(row('hitchCount', GOOD_FOREHAND_V3)).toMatchObject({
      status: 'not-assessable',
      note: 'Võrdlust veel pole: isiklik baas alles koguneb',
    });
  });

  it('shows G50 as a percentage and labels it a proxy, never a wrist measurement', () => {
    const m = withFeatures(GOOD_FOREHAND_V3, { lateGainFraction: 0.34 });
    const g50 = row('lateAcceleration', m);
    expect(g50?.value).toBe('34% ± 2%');
    expect(g50?.label).toBe('Hiline kiirendus (kaudne)');
    expect(row('lateAcceleration', m, 'en')?.label).toBe('Late acceleration (proxy)');
  });

  it('adds the new features with their own labels', () => {
    const ids = rows(GOOD_FOREHAND_V3).map((r) => r.id);
    for (const id of [
      'takebackTurn',
      'takebackTip',
      'takebackFace',
      'brush',
      'braking',
      'recovery',
    ])
      expect(ids).toContain(id);
    expect(ids).not.toContain('serveRoll');
  });

  it('shows the serve rows for overheads only', () => {
    const ids = rows(GOOD_SERVE).map((r) => r.id);
    for (const id of ['serveDrop', 'serveContactTip', 'serveRoll']) expect(ids).toContain(id);
    expect(row('serveRoll', GOOD_SERVE)?.status).toBe('not-assessable');
  });

  it('formats units', () => {
    expect(formatMeasure('ms', -45, 10, true)).toBe('−45 ms ± 10 ms');
    expect(formatMeasure('ms', 12, null, true)).toBe('+12 ms');
    expect(formatMeasure('deg', null, 2)).toBe('—');
    expect(formatMeasure('count', 2, 0.25)).toBe('2');
    expect(formatMeasure('deg', -0.2, 0.3)).toBe('0° ± 0.3°');
  });
});

describe('session coach summary', () => {
  const stroke = (
    id: string,
    type: StrokeMetrics['strokeType'],
    coach: StrokeCoaching | undefined,
  ): StrokeRecord => ({
    ...strokeRecord({ ...GOOD_FOREHAND_V3, strokeType: type }, Number(id.slice(1))),
    id,
    ...(coach ? { coach } : {}),
  });
  const say = (
    utterance: StrokeCoaching['utterance'],
    correctionId: StrokeCoaching['correctionId'],
    focus: StrokeCoaching['focus'] = correctionId,
  ): StrokeCoaching => ({ utterance, correctionId, focus });

  it('counts corrections, "Better", "That\'s it" and takes the latest focus per stroke type', () => {
    const records = [
      stroke('s1', 'forehand', say('correction', 'path-flat')),
      stroke('s2', 'forehand', say('correction', 'path-flat')),
      stroke('s3', 'forehand', say('correction', 'face-open', 'path-flat')),
      stroke('s4', 'forehand', say('better', 'path-flat')),
      stroke('s5', 'forehand', say('keep-it', null, 'path-flat')),
      stroke('s6', 'backhand', say('silent', null, null)),
      stroke('s7', 'forehand', say('good', null, null)),
    ];
    const [fh, bh, ...rest] = sessionCoachSummary(records);
    expect(rest).toEqual([]);
    expect(fh).toEqual({
      strokeType: 'forehand',
      counted: 6,
      corrections: [
        { correctionId: 'path-flat', count: 2 },
        { correctionId: 'face-open', count: 1 },
      ],
      better: 1,
      keepIt: 1,
      focus: null,
    });
    expect(bh).toMatchObject({ strokeType: 'backhand', counted: 1, corrections: [], focus: null });
  });

  it('keeps the focus of the latest stroke and counts legacy fix cues without a focus', () => {
    const legacy: StrokeRecord = {
      ...stroke('s1', 'forehand', undefined),
      cue: { ruleId: 'face-open', severity: 'fix', text: 'Face too open' },
    };
    const [only] = sessionCoachSummary([
      legacy,
      stroke('s2', 'forehand', say('correction', 'path-flat')),
    ]);
    expect(only?.focus).toBe('path-flat');
    expect(only?.corrections).toHaveLength(2);
    expect(sessionCoachSummary([legacy])[0]?.focus).toBeNull();
    expect(sessionCoachSummary([])).toEqual([]);
  });
});

describe('display formatting', () => {
  it('uses a typographic minus and never shows −0', async () => {
    const { deg, minus } = await import('../../src/ui/format');
    expect(deg(-12.2)).toBe('−12°');
    expect(deg(-0.3)).toBe('0°');
    expect(minus('-18')).toBe('−18');
  });
});
