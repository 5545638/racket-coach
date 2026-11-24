import type { Utterance } from '../coach/coachEngine';
import * as catalogue from '../coaching/corrections';
import { CORRECTIONS, FEEDBACK_PHRASES } from '../coaching/corrections';
import type { CorrectionId } from '../coaching/corrections';
import type { SpokenLanguage } from '../domain/types';
import { SYSTEM_PHRASES, type SystemPhrase } from './speechStrings';

/**
 * Spoken text in the spoken language. Tolerant adapter: Estonian cue texts
 * (`spokenEt` on a CorrectionText, `FEEDBACK_PHRASES_ET`) are read when the
 * catalogue has them and fall back to the English phrase (spoken with an
 * English voice) when not, so this compiles and works with and without them.
 */

export interface SpokenText {
  readonly text: string;
  /** Language of `text`: 'en' when the Estonian text is missing. */
  readonly lang: SpokenLanguage;
}

const record = (o: unknown): Record<string, unknown> | null =>
  typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** `spokenEt` of a correction (looked up in every language's entry), validated. */
function spokenEt(id: CorrectionId): {
  readonly variants: readonly [string, string, string];
  readonly reinforce: string | null;
} | null {
  for (const language of ['et', 'en'] as const) {
    const et = record(record(CORRECTIONS[language][id])?.['spokenEt']);
    const variants = et?.['variants'];
    if (!et || !Array.isArray(variants) || variants.length < 3) continue;
    const [a, b, c] = (variants as unknown[]).map(str);
    if (a && b && c) return { variants: [a, b, c], reinforce: str(et['reinforce']) };
  }
  return null;
}

/** FEEDBACK_PHRASES_ET[key], when the catalogue has it. */
function feedbackEt(key: string): string | null {
  return str(record(record(catalogue)?.['FEEDBACK_PHRASES_ET'])?.[key]);
}

/** Built-in Estonian for phrases the catalogue does not own. */
const BUILT_IN_ET: Readonly<Record<string, string>> = { good: 'Hea' };

/** Key of an English feedback phrase in FEEDBACK_PHRASES, or null. */
function feedbackKeyOf(text: string): string | null {
  for (const [key, value] of Object.entries(FEEDBACK_PHRASES)) if (value === text) return key;
  return null;
}

/** The Estonian text of a stroke utterance, or null when any part is missing. */
function estonian(utterance: Utterance, _speech: string): string | null {
  const id = utterance.correctionId;
  switch (utterance.kind) {
    case 'correction': {
      if (id === undefined) return null;
      const cue = spokenEt(id)?.variants[utterance.level ?? 0] ?? null;
      if (cue === null) return null;
      // Learning mode adds an English explanation sentence (≤ 12 words). The
      // Estonian on-screen adjustment texts are longer than the gap between
      // two balls, so in Estonian only the cue is spoken; the explanation
      // stays on screen.
      return cue;
    }
    case 'keep-it':
      return id === undefined ? null : (spokenEt(id)?.reinforce ?? feedbackEt('keepIt'));
    case 'good':
      return feedbackEt('good') ?? BUILT_IN_ET['good'] ?? null;
    case 'stuck':
      return feedbackEt('stuck');
    case 'better':
    case 'overcorrected':
    case 'consistency':
    case 'fatigue': {
      const key = feedbackKeyOf(utterance.spoken);
      return key === null ? null : feedbackEt(key);
    }
    case 'silent':
      return null;
  }
}

/**
 * What to say for a stroke utterance: the coach's English `speech`, or its
 * Estonian version when `lang` is 'et' and every part of it exists.
 */
export function strokeSpeech(
  utterance: Utterance,
  speech: string,
  lang: SpokenLanguage,
): SpokenText {
  if (lang === 'et') {
    const text = estonian(utterance, speech);
    if (text !== null) return { text, lang: 'et' };
  }
  return { text: speech, lang: 'en' };
}

/** A system message (connection, battery) in the spoken language. */
export const systemSpeech = (key: SystemPhrase, lang: SpokenLanguage): SpokenText => ({
  text: SYSTEM_PHRASES[lang][key],
  lang,
});

/**
 * Every Estonian text `strokeSpeech` and `systemSpeech` can return (cue
 * variants, reinforce phrases, feedback phrases, system messages), without
 * duplicates. The natural Estonian voice is downloaded for exactly these.
 */
export function estonianPhrases(): readonly string[] {
  const out = new Set<string>();
  const add = (text: string | null | undefined): void => {
    if (text) out.add(text);
  };
  for (const id of Object.keys(CORRECTIONS.en) as CorrectionId[]) {
    const et = spokenEt(id);
    if (et) for (const v of et.variants) add(v);
    add(et?.reinforce ?? feedbackEt('keepIt'));
  }
  for (const key of Object.keys(FEEDBACK_PHRASES)) add(feedbackEt(key));
  add(BUILT_IN_ET['good']);
  for (const text of Object.values(SYSTEM_PHRASES.et)) add(text);
  return [...out];
}
