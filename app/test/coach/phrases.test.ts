import { describe, expect, it } from 'vitest';
import {
  cueVariant,
  cueVariants,
  drillText,
  feedbackPhrase,
  learningSentence,
  reinforcePhrase,
  weaknessLabel,
} from '../../src/coach/phrases';
import { CORRECTIONS, type CorrectionId, FEEDBACK_PHRASES } from '../../src/coaching/corrections';

const IDS = Object.keys(CORRECTIONS.en) as CorrectionId[];
/** A field of the (possibly extended) correction text, read without its static type. */
const extra = (id: CorrectionId, key: string): unknown =>
  (CORRECTIONS.en[id] as unknown as Record<string, unknown>)[key];

describe('phrase adapter', () => {
  it('gives three cue variants per correction, v0 being the spoken cue', () => {
    for (const id of IDS) {
      const variants = cueVariants(id);
      expect(variants).toHaveLength(3);
      expect(variants[0]).toBe(CORRECTIONS.en[id].spoken);
      for (const v of variants) expect(v.trim()).not.toBe('');
      const given = extra(id, 'spokenVariants');
      if (Array.isArray(given)) expect(variants).toEqual(given.slice(0, 3));
      else expect(variants).toEqual([variants[0], variants[0], variants[0]]);
      expect(cueVariant(id, 2)).toBe(variants[2]);
    }
  });

  it('falls back for the reinforce phrase, the learning sentence and the weakness label', () => {
    for (const id of IDS) {
      expect(reinforcePhrase(id)).toBe(extra(id, 'reinforce') ?? FEEDBACK_PHRASES.keepIt);
      expect(learningSentence(id)).toBe(
        extra(id, 'learningSpoken') ?? CORRECTIONS.en[id].adjustment,
      );
      expect(weaknessLabel(id)).toBe(extra(id, 'weaknessLabel') ?? CORRECTIONS.en[id].title);
      expect(drillText(id, 'et')).toBe(CORRECTIONS.et[id].drill);
    }
  });

  it('has every feedback phrase', () => {
    expect(feedbackPhrase('better')).toBe('Better');
    expect(feedbackPhrase('keepIt')).toBe("That's it");
    expect(feedbackPhrase('overcorrected')).toBe('A little less');
    expect(feedbackPhrase('consistency')).toBe('Same swing every time');
    expect(feedbackPhrase('fatigue')).toBe('Take a short break');
    expect(feedbackPhrase('stuck')).toBe('Try the drill');
  });
});
