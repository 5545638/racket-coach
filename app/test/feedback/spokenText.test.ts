import { describe, expect, it } from 'vitest';
import type { Utterance } from '../../src/coach/coachEngine';
import { strokeSpeech, systemSpeech } from '../../src/feedback/spokenText';

const cue: Utterance = {
  kind: 'correction',
  correctionId: 'path-flat',
  spoken: 'Swing low to high',
  reason: 'new-focus',
  level: 0,
};

describe('spoken text without Estonian cue texts in the catalogue', () => {
  it('speaks the English phrase (lang en) even when Estonian is wanted', () => {
    expect(strokeSpeech(cue, cue.spoken, 'et')).toEqual({ text: 'Swing low to high', lang: 'en' });
    expect(strokeSpeech(cue, cue.spoken, 'en')).toEqual({ text: 'Swing low to high', lang: 'en' });
  });

  it('has system messages in both languages', () => {
    expect(systemSpeech('disconnected', 'en')).toEqual({ text: 'Sensor disconnected', lang: 'en' });
    expect(systemSpeech('connected', 'et')).toEqual({ text: 'Andur ühendatud', lang: 'et' });
    expect(systemSpeech('lost', 'et').text).toBe('Andur kadus');
  });
});
