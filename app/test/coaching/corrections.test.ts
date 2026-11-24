import { describe, expect, it } from 'vitest';
import {
  CORRECTIONS,
  FEEDBACK_LABELS,
  FEEDBACK_PHRASES,
  type CorrectionId,
} from '../../src/coaching/corrections';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';

const ids = Object.keys(CORRECTIONS.en) as CorrectionId[];
const LANGS = ['en', 'et'] as const;

/** Cues inherited from defaultRules.ts; their wording is fixed. */
const LEGACY_LONG_CUES = new Set([
  'Open the face for the slice',
  'Slice through the ball, not down',
  'Face down on the take-back',
]);

const FORBIDDEN =
  /grip pressure|elbow|shoulder rotation|wrist angle|haardejõud|küünarnukk|õlgade pööre|randme nurk/i;
const NEGATION = /cannot|can't|not measure|\bei\b/i;

function sentences(text: string): number {
  return text.split(/[.!?](?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

describe('correction catalogue', () => {
  it('has the same ids in both languages', () => {
    expect(Object.keys(CORRECTIONS.et).sort()).toEqual(Object.keys(CORRECTIONS.en).sort());
    expect(ids.length).toBe(23);
  });

  it.each(LANGS)('has non-empty fields in %s', (lang) => {
    for (const id of ids) {
      const c = CORRECTIONS[lang][id];
      for (const field of ['spoken', 'explanation', 'adjustment', 'drill', 'title'] as const) {
        expect(c[field].trim().length, `${lang}/${id}/${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('uses identical spoken cues of at most 4 words', () => {
    for (const id of ids) {
      const spoken = CORRECTIONS.en[id].spoken;
      expect(CORRECTIONS.et[id].spoken).toBe(spoken);
      if (!LEGACY_LONG_CUES.has(spoken)) {
        expect(spoken.split(/\s+/).length, id).toBeLessThanOrEqual(4);
      }
    }
  });

  it('keeps explanations to two sentences, or three for the wrist proxy', () => {
    for (const lang of LANGS) {
      for (const id of ids) {
        const max = id === 'stiff-arm' ? 3 : 2;
        expect(sentences(CORRECTIONS[lang][id].explanation), `${lang}/${id}`).toBeLessThanOrEqual(
          max,
        );
      }
    }
  });

  it('uses Estonian quotation marks', () => {
    for (const id of ids) {
      for (const field of ['explanation', 'adjustment', 'drill', 'title'] as const) {
        expect(CORRECTIONS.et[id][field], `${id}/${field}`).not.toMatch(/"/);
      }
    }
    const all = ids.map((id) => CORRECTIONS.et[id].drill + CORRECTIONS.et[id].adjustment).join(' ');
    expect(all).toMatch(/„[^„“"]+“/);
  });

  it('never claims to measure what the sensor cannot see', () => {
    for (const lang of LANGS) {
      for (const id of ids) {
        const text = CORRECTIONS[lang][id].explanation;
        if (FORBIDDEN.test(text)) expect(text, `${lang}/${id}`).toMatch(NEGATION);
      }
    }
  });

  it('labels the wrist cue and pronation cue as indirect', () => {
    expect(CORRECTIONS.en['stiff-arm'].explanation).toMatch(/indirect proxy/);
    expect(CORRECTIONS.en['stiff-arm'].explanation).toMatch(/50 ms/);
    expect(CORRECTIONS.et['stiff-arm'].explanation).toMatch(/kaudne/);
    expect(CORRECTIONS.en['serve-no-pronation'].explanation).toMatch(/cannot tell/);
  });

  it('keeps the existing rule cues unchanged', () => {
    for (const rule of DEFAULT_RULES.rules) {
      expect(CORRECTIONS.en[rule.id as CorrectionId].spoken).toBe(rule.cue);
    }
  });

  it('has feedback phrases', () => {
    expect(FEEDBACK_PHRASES).toEqual({
      better: 'Better',
      keepIt: "That's it",
      overcorrected: 'A little less',
      consistency: 'Same swing every time',
      fatigue: 'Take a short break',
      stuck: 'Try the drill',
    });
  });

  it('has complete feedback labels with Estonian quotes', () => {
    const keys = Object.keys(FEEDBACK_PHRASES).sort();
    for (const lang of LANGS) {
      expect(Object.keys(FEEDBACK_LABELS[lang]).sort()).toEqual(keys);
      for (const k of keys) {
        expect(
          FEEDBACK_LABELS[lang][k as keyof typeof FEEDBACK_PHRASES].trim().length,
        ).toBeGreaterThan(0);
      }
    }
    for (const k of keys) {
      expect(FEEDBACK_LABELS.et[k as keyof typeof FEEDBACK_PHRASES]).toMatch(/„[^„“"]+“/);
    }
  });

  it('has three distinct spoken variants, variant 0 equal to spoken', () => {
    for (const lang of LANGS) {
      for (const id of ids) {
        const c = CORRECTIONS[lang][id];
        expect(c.spokenVariants[0], `${lang}/${id}`).toBe(c.spoken);
        expect(new Set(c.spokenVariants.map((v) => v.toLowerCase())).size, `${lang}/${id}`).toBe(3);
      }
    }
  });

  it('respects word limits on spoken fields', () => {
    const words = (s: string) => s.trim().split(/\s+/).length;
    for (const id of ids) {
      const c = CORRECTIONS.en[id];
      c.spokenVariants.forEach((v, i) => {
        if (i === 0 && LEGACY_LONG_CUES.has(v)) return;
        expect(words(v), `${id}/variant${i}`).toBeLessThanOrEqual(5);
      });
      expect(words(c.reinforce), `${id}/reinforce`).toBeLessThanOrEqual(6);
      expect(words(c.learningSpoken), `${id}/learning`).toBeLessThanOrEqual(14);
      expect(c.learningSpoken, id).toMatch(/[.]$/);
    }
  });

  it('starts reinforcement with Good or Yes', () => {
    for (const id of ids) expect(CORRECTIONS.en[id].reinforce, id).toMatch(/^(Good|Yes)\b/);
  });

  it('keeps the new English fields identical across languages', () => {
    for (const id of ids) {
      for (const f of ['spokenVariants', 'reinforce', 'learningSpoken'] as const) {
        expect(CORRECTIONS.et[id][f], `${id}/${f}`).toEqual(CORRECTIONS.en[id][f]);
      }
    }
  });

  it('has Estonian weakness labels without ASCII double quotes', () => {
    for (const lang of LANGS) {
      for (const id of ids) {
        const l = CORRECTIONS[lang][id].weaknessLabel;
        expect(l.trim().length, `${lang}/${id}`).toBeGreaterThan(0);
        if (lang === 'et') expect(l).not.toMatch(/"/);
      }
    }
  });

  it('makes no body claims in spoken fields except the wrist cue', () => {
    const body = /wrist|elbow|shoulder|grip/i;
    for (const id of ids) {
      if (id === 'stiff-arm') continue;
      const c = CORRECTIONS.en[id];
      for (const text of [...c.spokenVariants, c.reinforce, c.learningSpoken]) {
        expect(text, id).not.toMatch(body);
      }
    }
  });
});
