import { describe, expect, it, vi } from 'vitest';
import type { Utterance } from '../../src/coach/coachEngine';
import { CORRECTIONS } from '../../src/coaching/corrections';
import { strokeSpeech } from '../../src/feedback/spokenText';

// The catalogue as another branch extends it: optional `spokenEt` and FEEDBACK_PHRASES_ET.
vi.mock('../../src/coaching/corrections', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/coaching/corrections')>();
  return {
    ...original,
    CORRECTIONS: {
      ...original.CORRECTIONS,
      en: {
        ...original.CORRECTIONS.en,
        'path-flat': {
          ...original.CORRECTIONS.en['path-flat'],
          spokenEt: {
            variants: ['Madalalt kõrgele', 'Alt üles', 'Pintsel üles'],
            reinforce: 'Hea. Just nii alt üles.',
          },
        },
      },
    },
    FEEDBACK_PHRASES_ET: { better: 'Parem', keepIt: 'Just nii', fatigue: 'Tee lühike paus' },
  };
});

const cue = (level: 0 | 1 | 2): Utterance => ({
  kind: 'correction',
  correctionId: 'path-flat',
  spoken: 'x',
  reason: 'new-focus',
  level,
});

describe('spoken text with Estonian cue texts', () => {
  it('reads the cue variants, reinforce and feedback phrases through the adapter', () => {
    expect(strokeSpeech(cue(1), 'x', 'et')).toEqual({ text: 'Alt üles', lang: 'et' });
    expect(strokeSpeech(cue(1), 'x', 'en')).toEqual({ text: 'x', lang: 'en' });
    const keepIt: Utterance = {
      kind: 'keep-it',
      correctionId: 'path-flat',
      spoken: 'y',
      reason: 'focus-ok',
    };
    expect(strokeSpeech(keepIt, 'y', 'et').text).toBe('Hea. Just nii alt üles.');
    const better: Utterance = {
      kind: 'better',
      correctionId: 'path-flat',
      spoken: 'Better',
      reason: 'improved',
    };
    expect(strokeSpeech(better, 'Better', 'et')).toEqual({ text: 'Parem', lang: 'et' });
    const fatigue: Utterance = { kind: 'fatigue', spoken: 'Take a short break', reason: 'fatigue' };
    expect(strokeSpeech(fatigue, fatigue.spoken, 'et').text).toBe('Tee lühike paus');
  });

  it('learning mode: the Estonian cue with the Estonian adjustment text', () => {
    const text = strokeSpeech(cue(0), 'x. Because…', 'et').text;
    expect(text).toBe(`Madalalt kõrgele. ${CORRECTIONS.et['path-flat'].adjustment}`);
  });

  it('falls back to English for a phrase without Estonian text', () => {
    const other: Utterance = { ...cue(0), correctionId: 'face-open', spoken: 'Face too open' };
    expect(strokeSpeech(other, 'Face too open', 'et')).toEqual({
      text: 'Face too open',
      lang: 'en',
    });
    const consistency: Utterance = {
      kind: 'consistency',
      spoken: 'Same swing every time',
      reason: 'oscillation',
    };
    expect(strokeSpeech(consistency, consistency.spoken, 'et').lang).toBe('en');
  });
});
