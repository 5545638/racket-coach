import { describe, expect, it } from 'vitest';
import type { Utterance } from '../../src/coach/coachEngine';
import { CORRECTIONS, FEEDBACK_PHRASES_ET } from '../../src/coaching/corrections';
import { strokeSpeech, systemSpeech } from '../../src/feedback/spokenText';

const cue = (level: 0 | 1 | 2, spoken = 'Swing low to high'): Utterance => ({
  kind: 'correction',
  correctionId: 'path-flat',
  spoken,
  reason: 'new-focus',
  level,
});
const et = CORRECTIONS.et['path-flat'].spokenEt;

describe('spoken text', () => {
  it('speaks the catalogue Estonian variant for the ladder level, English when asked', () => {
    expect(et).toBeDefined();
    expect(strokeSpeech(cue(0), 'Swing low to high', 'et')).toEqual({
      text: et?.variants[0],
      lang: 'et',
    });
    expect(strokeSpeech(cue(1), 'x', 'et')).toEqual({ text: et?.variants[1], lang: 'et' });
    expect(strokeSpeech(cue(0), 'Swing low to high', 'en')).toEqual({
      text: 'Swing low to high',
      lang: 'en',
    });
  });

  it('learning mode in Estonian speaks only the short cue (the explanation stays on screen)', () => {
    expect(strokeSpeech(cue(0), 'Swing low to high. Because…', 'et').text).toBe(et?.variants[0]);
  });

  it('reinforce and feedback phrases come from the Estonian catalogue', () => {
    const keepIt: Utterance = {
      kind: 'keep-it',
      correctionId: 'path-flat',
      spoken: 'y',
      reason: 'focus-ok',
    };
    expect(strokeSpeech(keepIt, 'y', 'et').text).toBe(et?.reinforce);
    const better: Utterance = {
      kind: 'better',
      correctionId: 'path-flat',
      spoken: 'Better',
      reason: 'improved',
    };
    expect(strokeSpeech(better, 'Better', 'et')).toEqual({
      text: FEEDBACK_PHRASES_ET.better,
      lang: 'et',
    });
  });

  it('has system messages in both languages', () => {
    expect(systemSpeech('disconnected', 'en')).toEqual({ text: 'Sensor disconnected', lang: 'en' });
    expect(systemSpeech('connected', 'et')).toEqual({ text: 'Andur ühendatud', lang: 'et' });
    expect(systemSpeech('lost', 'et').text).toBe('Andur kadus');
  });
});
