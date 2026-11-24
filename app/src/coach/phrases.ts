import {
  CORRECTIONS,
  type CorrectionId,
  type CorrectionText,
  FEEDBACK_PHRASES,
} from '../coaching/corrections';
import type { Language } from '../coaching/guidance';
import type { PhraseLevel } from '../domain/types';

/**
 * Adapter over the correction texts for the adaptive coach. The richer
 * fields (`spokenVariants`, `reinforce`, `learningSpoken`, `weaknessLabel`,
 * and the extra FEEDBACK_PHRASES) are read defensively, so this module
 * compiles and works both with and without them; each missing field falls
 * back to a phrase that exists today. Spoken phrases are always English.
 */

/** A field of an object read without trusting its static type. */
const field = (o: object, key: string): unknown => (o as Record<string, unknown>)[key];

const text = (o: object, key: string): string | null => {
  const v = field(o, key);
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

const entry = (id: CorrectionId, language: Language = 'en'): CorrectionText =>
  CORRECTIONS[language][id];

/** Fallbacks for the feedback phrases that may be missing from FEEDBACK_PHRASES. */
const FALLBACK_FEEDBACK = {
  overcorrected: 'A little less',
  consistency: 'Same swing every time',
  fatigue: 'Take a short break',
  stuck: 'Try the drill',
} as const;

export type FeedbackPhrase = 'better' | 'keepIt' | keyof typeof FALLBACK_FEEDBACK;

/** The spoken feedback phrase `key` (FEEDBACK_PHRASES, else the fallback). */
export function feedbackPhrase(key: FeedbackPhrase): string {
  if (key === 'better') return FEEDBACK_PHRASES.better;
  if (key === 'keepIt') return FEEDBACK_PHRASES.keepIt;
  return text(FEEDBACK_PHRASES, key) ?? FALLBACK_FEEDBACK[key];
}

/** The three spoken cue variants [v0, v1, v2] (v0 = `spoken`); without variants, [spoken × 3]. */
export function cueVariants(id: CorrectionId): readonly [string, string, string] {
  const c = entry(id);
  const v = field(c, 'spokenVariants');
  if (Array.isArray(v) && v.length >= 3) {
    const [a, b, d] = v as unknown[];
    if (typeof a === 'string' && typeof b === 'string' && typeof d === 'string') {
      return [a, b, d];
    }
  }
  return [c.spoken, c.spoken, c.spoken];
}

/** Spoken cue variant `level` of a correction. */
export const cueVariant = (id: CorrectionId, level: PhraseLevel): string => cueVariants(id)[level];

/** Phrase for a fixed focus (e.g. "Good. Keep that acceleration."); else "That's it". */
export const reinforcePhrase = (id: CorrectionId): string =>
  text(entry(id), 'reinforce') ?? FEEDBACK_PHRASES.keepIt;

/**
 * One spoken sentence explaining the cue (learning mode); else the English
 * adjustment text.
 */
export const learningSentence = (id: CorrectionId): string =>
  text(entry(id), 'learningSpoken') ?? entry(id).adjustment;

/** Short name of a correction as a weakness (profile, plan); else its title. */
export const weaknessLabel = (id: CorrectionId, language: Language = 'en'): string =>
  text(entry(id, language), 'weaknessLabel') ?? entry(id, language).title;

/** The catalogue drill of a correction, in the UI language. */
export const drillText = (id: CorrectionId, language: Language = 'en'): string =>
  entry(id, language).drill;
