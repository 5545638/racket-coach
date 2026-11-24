import { GOOD_PHRASE } from '../coach/coachEngine';
import {
  cueVariants,
  feedbackPhrase,
  learningSentence,
  overcorrectedPhrase,
  reinforcePhrase,
  stuckPhrase,
  type FeedbackPhrase,
} from '../coach/phrases';
import { CORRECTIONS, type CorrectionId, FEEDBACK_PHRASES } from '../coaching/corrections';
import type { SpokenLanguage } from '../domain/types';
import { SYSTEM_PHRASES, TEST_PHRASES } from './speechStrings';
import { estonianPhrases } from './spokenText';

/**
 * Every phrase the app can speak, per spoken language. The natural voice is
 * pre-recorded for exactly these (tools/voice exports the English list and
 * synthesises it; the Estonian list is downloaded in the app), so the clip
 * lookup is by text: `clipKey`.
 *
 * Learning mode joins a cue and its explanation ("Swing low to high. Brush
 * up the back of the ball."): such a text is played as a sequence of clips
 * (`clipSequence`), so only the parts are recorded.
 */

const correctionIds = (): CorrectionId[] => Object.keys(CORRECTIONS.en) as CorrectionId[];

/** English phrases: cue variants, reinforce, "Try the … drill", learning sentences, feedback, system. */
export function englishPhrases(): readonly string[] {
  const out = new Set<string>();
  for (const id of correctionIds()) {
    for (const v of cueVariants(id)) out.add(v);
    out.add(reinforcePhrase(id));
    out.add(stuckPhrase(id));
    out.add(learningSentence(id));
    out.add(overcorrectedPhrase(id));
  }
  for (const key of Object.keys(FEEDBACK_PHRASES)) out.add(feedbackPhrase(key as FeedbackPhrase));
  out.add(GOOD_PHRASE);
  for (const text of Object.values(SYSTEM_PHRASES.en)) out.add(text);
  out.add(TEST_PHRASES.en);
  return [...out].filter((t) => t.trim() !== '');
}

/** Every phrase spoken in `lang` (Estonian: the cue texts plus system and test phrases). */
export function spokenPhrases(lang: SpokenLanguage): readonly string[] {
  if (lang === 'en') return englishPhrases();
  return [...new Set([...estonianPhrases(), TEST_PHRASES.et])];
}

/**
 * Lookup key of a phrase: the exact text with outer and repeated white space
 * and final sentence punctuation removed ("Better", " Better. " → "Better").
 * Wording, letter case and inner punctuation must match exactly.
 */
export const clipKey = (text: string): string =>
  text
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();

/** Sentences of a text ("A. B." → ["A.", "B."]). */
const sentences = (text: string): string[] =>
  text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() !== '');

/**
 * The clip keys that voice `text`: the whole text if it is recorded, else the
 * fewest runs of whole sentences that are all recorded (learning mode's
 * "cue. explanation"). Null when some part has no clip.
 */
export function clipSequence(text: string, has: (key: string) => boolean): string[] | null {
  const whole = clipKey(text);
  if (whole === '') return null;
  if (has(whole)) return [whole];
  const parts = sentences(text);
  if (parts.length < 2) return null;
  // best[i]: fewest keys covering parts[i..]; next[i]: the end of the first run.
  const n = parts.length;
  const best = new Array<number>(n + 1).fill(Infinity);
  const next = new Array<number>(n + 1).fill(-1);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = n; j > i; j--) {
      const rest = best[j] ?? Infinity;
      if (rest + 1 < (best[i] ?? Infinity) && has(clipKey(parts.slice(i, j).join(' ')))) {
        best[i] = rest + 1;
        next[i] = j;
      }
    }
  }
  if (!Number.isFinite(best[0])) return null;
  const keys: string[] = [];
  for (let i = 0; i < n;) {
    const j = next[i] ?? -1;
    keys.push(clipKey(parts.slice(i, j).join(' ')));
    i = j;
  }
  return keys;
}
