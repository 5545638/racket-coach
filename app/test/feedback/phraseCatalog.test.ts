import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GOOD_PHRASE } from '../../src/coach/coachEngine';
import {
  cueVariants,
  learningSentence,
  reinforcePhrase,
  stuckPhrase,
} from '../../src/coach/phrases';
import { CORRECTIONS, type CorrectionId, FEEDBACK_PHRASES } from '../../src/coaching/corrections';
import {
  clipKey,
  clipSequence,
  englishPhrases,
  spokenPhrases,
} from '../../src/feedback/phraseCatalog';
import { SYSTEM_PHRASES, TEST_PHRASES } from '../../src/feedback/speechStrings';
import { estonianPhrases } from '../../src/feedback/spokenText';

const ids = Object.keys(CORRECTIONS.en) as CorrectionId[];

describe('phrase catalogue', () => {
  it('lists every English phrase the coach and the app can speak', () => {
    const en = new Set(englishPhrases());
    for (const id of ids) {
      for (const v of cueVariants(id)) expect(en).toContain(v);
      expect(en).toContain(reinforcePhrase(id));
      expect(en).toContain(stuckPhrase(id));
      expect(en).toContain(learningSentence(id));
    }
    for (const p of Object.values(FEEDBACK_PHRASES)) expect(en).toContain(p);
    for (const p of Object.values(SYSTEM_PHRASES.en)) expect(en).toContain(p);
    expect(en).toContain(GOOD_PHRASE);
    expect(en).toContain(TEST_PHRASES.en);
  });

  it('lists the Estonian cue, feedback and system phrases (about 100)', () => {
    const et = spokenPhrases('et');
    expect(et).toEqual(expect.arrayContaining([...estonianPhrases(), TEST_PHRASES.et]));
    expect(et).toEqual(expect.arrayContaining(['Parem', 'Hea', 'Andur kadus']));
    expect(et.length).toBeGreaterThan(80);
    expect(new Set(et).size).toBe(et.length);
  });

  it('every learning-mode text can be played from recorded parts', () => {
    const keys = new Set(englishPhrases().map(clipKey));
    for (const id of ids) {
      for (const v of cueVariants(id)) {
        const text = `${v}. ${learningSentence(id)}`;
        expect(clipSequence(text, (k) => keys.has(k))).toEqual([
          clipKey(v),
          clipKey(learningSentence(id)),
        ]);
      }
    }
  });
});

describe('clip lookup by text', () => {
  it('matches the exact text, ignoring outer / repeated white space and a final full stop', () => {
    expect(clipKey('Better')).toBe('Better');
    expect(clipKey('  Better. ')).toBe('Better');
    expect(clipKey('Good.  Keep that acceleration.')).toBe('Good. Keep that acceleration');
    expect(clipKey('Better!')).toBe('Better');
  });

  it('does not match other wording, letter case or inner punctuation', () => {
    const has = (k: string) => k === 'Face too open';
    expect(clipSequence('Face too open', has)).toEqual(['Face too open']);
    expect(clipSequence('face too open', has)).toBeNull();
    expect(clipSequence('Face too opened', has)).toBeNull();
    expect(clipSequence('Face, too open', has)).toBeNull();
    expect(clipSequence('', has)).toBeNull();
  });

  it('splits into the fewest recorded runs of sentences, or none', () => {
    const keys = new Set(['A', 'B. C', 'B', 'C']);
    const has = (k: string) => keys.has(k);
    expect(clipSequence('A. B. C.', has)).toEqual(['A', 'B. C']);
    expect(clipSequence('A. D.', has)).toBeNull();
  });
});

describe('generated English clips (app/public/voice)', () => {
  const root = fileURLToPath(new URL('../../public/voice', import.meta.url));
  for (const profile of ['female', 'male']) {
    const path = join(root, `en-${profile}`, 'manifest.json');
    it(`en-${profile} has a clip for every English phrase (else run npm run voice:generate)`, () => {
      expect(existsSync(path)).toBe(true);
      const manifest = JSON.parse(readFileSync(path, 'utf-8')) as {
        clips: Record<string, { file: string; durationMs: number }>;
      };
      const missing = englishPhrases()
        .map(clipKey)
        .filter((k) => !(k in manifest.clips));
      expect(missing).toEqual([]);
      for (const entry of Object.values(manifest.clips)) {
        expect(existsSync(join(root, `en-${profile}`, entry.file))).toBe(true);
        expect(entry.durationMs).toBeGreaterThanOrEqual(400);
        expect(entry.durationMs).toBeLessThanOrEqual(5000);
      }
    });
  }
});
