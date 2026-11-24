import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE, buildBaseline } from '../../src/coach/baseline';
import { CORRECTIONS, type CorrectionId } from '../../src/coaching/corrections';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import type { StrokeMetrics } from '../../src/domain/types';
import { type ElementAssessment, assessStroke, byCorrection } from '../../src/elements/assess';
import { ELEMENT_CATALOG } from '../../src/elements/catalog';
import { normalCdf } from '../../src/math/stats';
import {
  GOOD_FOREHAND,
  GOOD_FOREHAND_V3,
  GOOD_SERVE,
  strokeRecord,
  withFeatures,
} from '../fixtures';

const element = (m: StrokeMetrics, key: string, baseline = EMPTY_BASELINE): ElementAssessment => {
  const e = assessStroke(m, baseline).elements.find((x) => x.key === key);
  if (!e) throw new Error(`no element ${key}`);
  return e;
};

/** A baseline of `n` strokes made by `make(i)`. */
const baselineOf = (n: number, make: (i: number) => StrokeMetrics) =>
  buildBaseline(Array.from({ length: n }, (_, i) => strokeRecord(make(i), i + 1)));

describe('element catalogue', () => {
  it('covers every correction and has unique keys', () => {
    const ids = Object.keys(CORRECTIONS.en) as CorrectionId[];
    for (const id of ids) {
      expect(
        ELEMENT_CATALOG.some((e) => e.correctionId === id),
        id,
      ).toBe(true);
    }
    const keys = ELEMENT_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives entries that share a metric on the same strokes the same noise floor', () => {
    for (const a of ELEMENT_CATALOG) {
      for (const b of ELEMENT_CATALOG) {
        if (a.metric === b.metric) expect(a.sMin, `${a.key}/${b.key}`).toBe(b.sMin);
      }
    }
  });

  it('reuses the rule limits as population limits', () => {
    for (const rule of DEFAULT_RULES.rules) {
      if (rule.id === 'stiff-arm') continue; // now personal-only, on a different metric
      const spec = ELEMENT_CATALOG.find((e) => e.key === rule.id);
      expect(spec, rule.id).toBeDefined();
      expect(spec?.populationLimit).toBe(rule.above ?? rule.below);
      expect(spec?.direction).toBe(rule.above !== undefined ? 'above' : 'below');
      expect(spec?.strokes).toEqual(rule.strokes);
      expect(spec?.swingSizes).toEqual(rule.swingSizes);
    }
    const stiff = ELEMENT_CATALOG.find((e) => e.key === 'stiff-arm');
    expect(stiff?.populationLimit).toBeNull();
    expect(CORRECTIONS.en['stiff-arm'].spoken).toBe('Loosen the wrist');
  });
});

describe('assessStroke without a baseline', () => {
  it('finds no fault on a textbook forehand and leaves personal-only elements unjudged', () => {
    const a = assessStroke(GOOD_FOREHAND_V3, EMPTY_BASELINE);
    expect(a.faults).toEqual([]);
    expect(element(GOOD_FOREHAND_V3, 'face-open').status).toBe('ok');
    expect(element(GOOD_FOREHAND_V3, 'face-open').bandSource).toBe('population');
    expect(element(GOOD_FOREHAND_V3, 'late-preparation').reason).toBe('no-baseline');
    expect(element(GOOD_FOREHAND_V3, 'slice-chop').reason).toBe('wrong-stroke');
    expect(element(GOOD_FOREHAND_V3, 'serve-no-drop').reason).toBe('wrong-stroke');
  });

  it('computes d, p = Φ(d/σ) and score = w · min(d/s, 3) · p', () => {
    const flat = { ...GOOD_FOREHAND_V3, swingPathDeg: 8 };
    const e = element(flat, 'path-flat');
    expect(e.band).toEqual({ lo: 12, hi: null });
    expect(e.distance).toBeCloseTo(4, 12);
    expect(e.sigma).toBe(3.3);
    expect(e.probability).toBeCloseTo(normalCdf(4 / 3.3), 12);
    expect(e.status).toBe('fault');
    expect(e.score).toBeCloseTo(0.9 * (4 / 3.5) * normalCdf(4 / 3.3), 12);
    // Capped at 3 spreads.
    const veryFlat = element({ ...GOOD_FOREHAND_V3, swingPathDeg: -20 }, 'path-flat');
    expect(veryFlat.score).toBeCloseTo(0.9 * 3 * veryFlat.probability, 12);
  });

  it('calls a deviation a fault only when p ≥ 0.8', () => {
    // d = 2°, σ = 3.3° → p = Φ(0.61) ≈ 0.73.
    const e = element({ ...GOOD_FOREHAND_V3, swingPathDeg: 10 }, 'path-flat');
    expect(e.distance).toBeCloseTo(2, 12);
    expect(e.probability).toBeLessThan(0.8);
    expect(e.status).toBe('ok');
    expect(e.score).toBe(0);
  });

  it('judges nothing on a stroke without contact', () => {
    const a = assessStroke(
      { ...GOOD_FOREHAND_V3, impactDetected: false, faceTiltDeg: 30 },
      EMPTY_BASELINE,
    );
    expect(a.contact).toBe(false);
    expect(a.faults).toEqual([]);
    expect(a.elements.every((e) => e.reason === 'no-contact')).toBe(true);
  });

  it('needs σ: strokes analysed before version 3 cannot be judged on angles', () => {
    const old = { ...GOOD_FOREHAND, faceTiltDeg: 20 };
    expect(old.features).toBeUndefined();
    expect(element(old, 'face-open').reason).toBe('no-sigma');
  });

  it('applies only the face limits to backhands without a baseline', () => {
    const bad: StrokeMetrics = withFeatures(
      {
        ...GOOD_FOREHAND_V3,
        strokeType: 'backhand',
        faceTiltDeg: 15,
        swingPathDeg: 0,
        peakSpeedOffsetMs: -120,
        racketDropDeg: 10,
        faceAtDropDeg: 60,
        backswingPauseMs: 500,
        followThroughArcDeg: 40,
      },
      { hitchCount: 3, lateGainFraction: -0.5 },
    );
    const a = assessStroke(bad, EMPTY_BASELINE);
    expect(a.faults.map((f) => f.key)).toEqual(['face-open']);
    expect(element(bad, 'path-flat').reason).toBe('no-baseline');
    expect(element(bad, 'hitch').reason).toBe('no-baseline');
    // The same stroke as a forehand fires the population limits.
    const asForehand = assessStroke({ ...bad, strokeType: 'forehand' }, EMPTY_BASELINE);
    expect(asForehand.faults.length).toBeGreaterThan(4);
  });

  it('allows a slice backhand face fault from the population limit', () => {
    const slice = {
      ...GOOD_FOREHAND_V3,
      strokeType: 'backhand' as const,
      swingStyle: 'slice' as const,
      faceTiltDeg: -10,
      swingPathDeg: -20,
    };
    expect(assessStroke(slice, EMPTY_BASELINE).faults.map((f) => f.key)).toEqual([
      'slice-face-closed',
    ]);
  });

  it('judges timing elements when the style is unknown (no attitude anchor), but no angles', () => {
    const noAnchor: StrokeMetrics = {
      ...GOOD_FOREHAND_V3,
      swingStyle: null,
      faceTiltDeg: null,
      swingPathDeg: null,
      racketDropDeg: null,
      faceAtDropDeg: null,
      backswingPauseMs: 400,
    };
    const a = assessStroke(noAnchor, EMPTY_BASELINE);
    expect(element(noAnchor, 'face-open').reason).toBe('no-value');
    expect(a.faults.map((f) => f.key)).toEqual(['hitch']);
  });
});

describe('assessStroke with a personal baseline', () => {
  it('narrows the population band to the personal one (combined)', () => {
    // Usual path 30° ± spread; band lo = max(12, m − 2s).
    const baseline = baselineOf(20, (i) => ({
      ...GOOD_FOREHAND_V3,
      swingPathDeg: 30 + (i % 5) - 2,
    }));
    const e = element({ ...GOOD_FOREHAND_V3, swingPathDeg: 14 }, 'path-flat', baseline);
    expect(e.personal?.n).toBe(20);
    expect(e.bandSource).toBe('combined');
    const s = e.personal?.spread ?? NaN;
    expect(s).toBeCloseTo(Math.max(1.4826 * 1, 3.5), 12);
    expect(e.band?.lo).toBeCloseTo(30 - 2 * s, 12);
    expect(e.status).toBe('fault');
    expect(e.score).toBeCloseTo(0.9 * Math.min((30 - 2 * s - 14) / s, 3) * e.probability, 12);
  });

  it('keeps the population limit when the personal band is wider', () => {
    const baseline = baselineOf(20, (i) => ({
      ...GOOD_FOREHAND_V3,
      swingPathDeg: 14 + (i % 2) * 8,
    }));
    const e = element({ ...GOOD_FOREHAND_V3, swingPathDeg: 11 }, 'path-flat', baseline);
    expect(e.bandSource).toBe('combined');
    expect(e.band?.lo).toBe(12);
  });

  it('uses the population limit alone when the personal median is beyond it', () => {
    const baseline = baselineOf(20, () => ({ ...GOOD_FOREHAND_V3, swingPathDeg: 5 }));
    const e = element({ ...GOOD_FOREHAND_V3, swingPathDeg: 5 }, 'path-flat', baseline);
    expect(e.bandSource).toBe('population');
    expect(e.band?.lo).toBe(12);
    expect(e.status).toBe('fault');
  });

  it('fires personal-only elements once the baseline is active', () => {
    const usual = (i: number) =>
      withFeatures(GOOD_FOREHAND_V3, { takebackTimeMs: 900 + (i % 3) * 20 });
    const late = withFeatures(GOOD_FOREHAND_V3, { takebackTimeMs: 600 });
    expect(element(late, 'late-preparation', baselineOf(14, usual)).reason).toBe('no-baseline');
    const e = element(late, 'late-preparation', baselineOf(15, usual));
    expect(e.bandSource).toBe('personal');
    expect(e.status).toBe('fault');
  });

  it('gives no correction to a stable personal style inside the population limits', () => {
    const style = (i: number): StrokeMetrics =>
      withFeatures(
        {
          ...GOOD_FOREHAND_V3,
          faceTiltDeg: -3 + ((i * 7) % 5) * 0.5, // habitually near the open limit
          swingPathDeg: 16 + ((i * 3) % 4), // habitually flat but inside the limit
          peakSpeedOffsetMs: -30 + (i % 3) * 3,
          racketDropDeg: -20 + (i % 4),
        },
        {
          takebackTimeMs: 700 + (i % 4) * 15,
          takebackTurnDeg: 60 + (i % 3) * 4,
          lateGainFraction: 0.15 + (i % 3) * 0.02,
          brakingTimeMs: 200 + (i % 5) * 6,
          recoveryMs: 700 + (i % 4) * 20,
          contactStabilityDps: 260 + (i % 4) * 10,
          takebackTipDeg: 40 + (i % 3),
        },
      );
    const baseline = baselineOf(30, style);
    for (let i = 0; i < 30; i++) {
      expect(assessStroke(style(i), baseline).faults, `stroke ${String(i)}`).toEqual([]);
    }
  });
});

describe('serve elements', () => {
  const serves = (n: number) =>
    buildBaseline(Array.from({ length: n }, (_, i) => strokeRecord(GOOD_SERVE, i + 1)));
  const weakRoll = (saturated: boolean): StrokeMetrics => {
    const f = GOOD_SERVE.features;
    if (!f?.serve) throw new Error('fixture');
    return withFeatures(GOOD_SERVE, {
      serve: { ...f.serve, rollAngleDeg: 5, rollSaturated: saturated },
    });
  };

  it('are personal-only', () => {
    const a = assessStroke(weakRoll(false), EMPTY_BASELINE);
    expect(a.faults).toEqual([]);
    expect(element(weakRoll(false), 'serve-no-pronation').reason).toBe('no-baseline');
  });

  it('cannot call a too-small roll when the roll was clipped (a lower bound)', () => {
    const baseline = serves(20);
    expect(element(weakRoll(false), 'serve-no-pronation', baseline).status).toBe('fault');
    const clipped = element(weakRoll(true), 'serve-no-pronation', baseline);
    expect(clipped.status).toBe('not-assessable');
    expect(clipped.reason).toBe('saturated');
  });

  it('judge the contact tip only with a reliable attitude', () => {
    const f = GOOD_SERVE.features;
    if (!f?.serve) throw new Error('fixture');
    const low = withFeatures(GOOD_SERVE, {
      serve: { ...f.serve, contactTipDeg: 40, contactTipReliable: false },
    });
    expect(element(low, 'serve-low-contact', serves(20)).reason).toBe('saturated');
  });
});

describe('byCorrection', () => {
  it('merges the elements of one correction, fault first', () => {
    const m = withFeatures({ ...GOOD_FOREHAND_V3, backswingPauseMs: 0 }, { hitchCount: 2 });
    const baseline = baselineOf(20, () => GOOD_FOREHAND_V3);
    const hitch = byCorrection(assessStroke(m, baseline)).get('hitch');
    expect(hitch?.key).toBe('hitch-count');
    expect(hitch?.status).toBe('fault');
    expect(byCorrection(assessStroke(m, baseline)).has('serve-hitch')).toBe(false);
  });
});
