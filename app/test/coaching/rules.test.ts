import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import { NOT_RATED_CUE, NO_READING_CUE, evaluateRules, selectCue } from '../../src/coaching/rules';
import { wristHint } from '../../src/coaching/wrist';
import { GOOD_FOREHAND } from '../fixtures';

describe('strokes without ball contact', () => {
  const shadow = { ...GOOD_FOREHAND, impactDetected: false };

  it('are counted, not rated', () => {
    expect(selectCue(shadow, DEFAULT_RULES)).toEqual(NOT_RATED_CUE);
  });

  it('are not corrected even when a rule would fire', () => {
    const faulty = { ...shadow, faceTiltDeg: 20, swingPathDeg: 0 };
    expect(evaluateRules(faulty, DEFAULT_RULES)).toEqual({ violations: [], unchecked: [] });
    expect(selectCue(faulty, DEFAULT_RULES)).toEqual(NOT_RATED_CUE);
  });

  it('are not called "No reading" either', () => {
    expect(selectCue({ ...shadow, faceTiltDeg: null }, DEFAULT_RULES)).toEqual(NOT_RATED_CUE);
  });
});

describe('withheld timing metrics', () => {
  const clipped = { ...GOOD_FOREHAND, peakSpeedOffsetMs: null, peakAccelerationOffsetMs: null };

  it('never fire a rule and leave the stroke unrated instead of good', () => {
    const { violations, unchecked } = evaluateRules(clipped, DEFAULT_RULES);
    expect(violations).toEqual([]);
    expect(unchecked.length).toBeGreaterThan(0);
    for (const rule of unchecked) {
      expect(['peakSpeedOffsetMs', 'peakAccelerationOffsetMs']).toContain(rule.metric);
    }
    expect(selectCue(clipped, DEFAULT_RULES)).toEqual(NO_READING_CUE);
  });

  it('do not block corrections from other metrics', () => {
    expect(selectCue({ ...clipped, faceTiltDeg: 10 }, DEFAULT_RULES).ruleId).toBe('face-open');
  });

  it('give no wrist hint', () => {
    expect(wristHint(clipped)).toBeNull();
  });
});
