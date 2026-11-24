import { describe, expect, it } from 'vitest';
import { CORRECTIONS, type CorrectionId } from '../../src/coaching/corrections';
import { strings } from '../../src/ui/strings';

/** Every string leaf, with functions called on sample arguments. */
function leaves(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const call = value as (...args: unknown[]) => unknown;
    return [[path, String(call('A', 3, 15, 'B'))]];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  }
  return [];
}

describe('UI strings', () => {
  const en = leaves(strings('en'));
  const et = leaves(strings('et'));

  it('have the same keys in Estonian and English, none empty', () => {
    expect(et.map(([k]) => k)).toEqual(en.map(([k]) => k));
    for (const [key, text] of [...en, ...et]) expect(text.trim(), key).not.toBe('');
  });

  it('keep Estonian different from English for the new live texts', () => {
    const t = strings('et').live;
    expect([t.better, t.thatsIt, t.good, t.counted]).toEqual([
      'Paremini',
      'Just nii',
      'Hea',
      'Löök loetud',
    ]);
    expect(t.confidence(92)).toBe('Kindlus 92%');
    expect(t.baselineProgress(9, 15)).toBe('Isiklik baas: 9/15 lööki');
    expect(strings('et').setup.resetBaseline).toBe('Lähtesta isiklik baas');
  });

  it('name the new tab, the profile texts and the adaptive live texts in Estonian', () => {
    const t = strings('et');
    expect([t.tabs.live, t.tabs.session, t.tabs.profile, t.tabs.setup]).toEqual([
      'Löök',
      'Trenn',
      'Profiil',
      'Seaded',
    ]);
    expect(t.live.overcorrected).toBe('Liiga palju – veidi vähem');
    expect(t.profile.empty).toBe('Profiil täitub pärast paari trenni.');
    expect(t.profile.target(15)).toBe('Eesmärk: alla 15% vigu');
    expect(t.profile.volume(3, 15)).toBe('3 × 15 palli');
    expect(t.category['technical-error']).toBe('Viga');
    expect(strings('en').tabs.profile).toBe('Profile');
  });

  it('use Estonian quotation marks „…“, never straight or English ones', () => {
    const count = (text: string, ch: string): number => text.split(ch).length - 1;
    for (const [key, text] of et) {
      expect(text, key).not.toMatch(/["”]/);
      expect(count(text, '„'), key).toBe(count(text, '“'));
    }
    expect(strings('et').session.betterTimes(2)).toBe('„Paremini“ 2×');
  });

  it('have a title for every correction id and the legacy cue ids, in both languages', () => {
    for (const language of ['en', 'et'] as const) {
      const { cueTitle } = strings(language);
      for (const id of Object.keys(CORRECTIONS[language]) as CorrectionId[]) {
        expect(cueTitle[id], `${language}:${id}`).toBe(CORRECTIONS[language][id].title);
      }
      for (const id of ['good', 'not-rated', 'no-reading']) expect(cueTitle[id]).toBeTruthy();
    }
  });

  it('never call the late-acceleration proxy a wrist measurement', () => {
    expect(strings('en').metric.lateAcceleration).toBe('Late acceleration (proxy)');
    expect(strings('et').metric.lateAcceleration).toBe('Hiline kiirendus (kaudne)');
    // "wrist" / "ranne" appears only in the stiff-arm cue title (and its catalogue text).
    for (const language of ['en', 'et'] as const) {
      const wording = language === 'en' ? /wrist/i : /\bran(ne|net|de)\b|\brandme/i;
      const hits = leaves(strings(language))
        .filter(([key]) => !key.startsWith('cueTitle.'))
        .filter(([, text]) => wording.test(text));
      expect(hits, language).toEqual([]);
      const titled = Object.entries(strings(language).cueTitle).filter(([, v]) => wording.test(v));
      expect(titled.map(([id]) => id)).toEqual(['stiff-arm']);
    }
  });
});
