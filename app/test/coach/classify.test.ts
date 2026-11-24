import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import { type ClassifyContext, classifyStroke } from '../../src/coach/classify';
import type { StrokeMetrics } from '../../src/domain/types';
import { assessStroke } from '../../src/elements/assess';
import { GOOD_FEATURES, GOOD_FOREHAND_V3, GOOD_SERVE } from '../fixtures';
import { baselineFrom } from './harness';

const NONE: ClassifyContext = { fatigueActive: false, focusBefore: null, improved: false };
const path = (deg: number, sigma = 3.3): StrokeMetrics => ({
  ...GOOD_FOREHAND_V3,
  swingPathDeg: deg,
  features: { ...GOOD_FEATURES, sigma: { ...GOOD_FEATURES.sigma, swingPathDeg: sigma } },
});
const classify = (m: StrokeMetrics, ctx: ClassifyContext = NONE, baseline = EMPTY_BASELINE) =>
  classifyStroke(assessStroke(m, baseline), ctx);

describe('deviation categories', () => {
  it('a fault with p ≥ pMin is a technical error', () => {
    expect(classify(path(0)).byElement['path-flat']).toBe('technical-error');
  });

  it('outside the band with p < pMin is uncertain', () => {
    // d = 1°, σ = 3.3° → p ≈ 0.62.
    expect(classify(path(11)).byElement['path-flat']).toBe('uncertain');
  });

  it('inside the band but σ larger than the spread and the margin is uncertain', () => {
    expect(classify(path(14, 6)).byElement['path-flat']).toBe('uncertain');
    expect(classify(path(14, 1)).byElement['path-flat']).toBe('variation');
  });

  it('inside the population band without a baseline is variation, and inside the personal band too', () => {
    expect(classify(path(25)).byElement['path-flat']).toBe('variation');
    const baseline = baselineFrom(Array.from({ length: 20 }, (_, i) => path(20 + (i % 5))));
    expect(classify(path(21), NONE, baseline).byElement['path-flat']).toBe('variation');
  });

  it('marks unjudged elements not assessable and leaves out the ones that do not apply', () => {
    const c = classify(GOOD_FOREHAND_V3);
    expect(c.byElement['stiff-arm']).toBe('not-assessable'); // no baseline, no population limit
    expect(c.byElement['serve-no-drop']).toBeUndefined();
    const serve = classify(GOOD_SERVE);
    expect(serve.byElement['face-open']).toBeUndefined();
    const total = Object.values(c.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(Object.keys(c.byElement).length);
  });

  it('a fault during fatigue is fatigue-related', () => {
    const c = classify(path(0), { ...NONE, fatigueActive: true });
    expect(c.byElement['path-flat']).toBe('fatigue-related');
    expect(c.counts['technical-error']).toBe(0);
  });

  it('the focus improving, or back inside its band, is an improvement', () => {
    expect(
      classify(path(0), { ...NONE, focusBefore: 'path-flat', improved: true }).byElement[
        'path-flat'
      ],
    ).toBe('improvement');
    expect(classify(path(25), { ...NONE, focusBefore: 'path-flat' }).byElement['path-flat']).toBe(
      'improvement',
    );
    // Not the focus: plain variation.
    expect(classify(path(25), { ...NONE, focusBefore: 'face-open' }).byElement['path-flat']).toBe(
      'variation',
    );
  });
});
