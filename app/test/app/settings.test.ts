import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_LEVER_RADIUS_M,
  SETTINGS_VERSION,
  resolveSettings,
} from '../../src/app/settings';
import type { Settings } from '../../src/domain/types';
import { DEFAULT_ANALYSIS_PARAMS } from '../../src/metrics/analyzeSwing';

/** Settings as stored by an older app version (fields the current type no longer allows). */
const legacy = (stored: Record<string, unknown>): Partial<Settings> => stored;

describe('lever radius default and migration', () => {
  it('defaults to the 0.72 m effective radius, matching the analysis', () => {
    expect(DEFAULT_SETTINGS.leverRadiusM).toBe(0.72);
    expect(DEFAULT_ANALYSIS_PARAMS.leverRadiusM).toBe(DEFAULT_SETTINGS.leverRadiusM);
  });

  it('migrates the old 1.0 m default from settings stored before version 2', () => {
    const stored = legacy({ mode: 'rally', leverRadiusM: LEGACY_DEFAULT_LEVER_RADIUS_M });
    expect(resolveSettings(stored)).toEqual({
      ...DEFAULT_SETTINGS,
      mode: 'match',
      leverRadiusM: 0.72,
      version: SETTINGS_VERSION,
    });
  });

  it('keeps a lever the user chose before version 2', () => {
    expect(resolveSettings({ leverRadiusM: 0.9 }).leverRadiusM).toBe(0.9);
  });

  it('keeps 1.0 m when chosen with the current version, e.g. from the settings view', () => {
    const current = resolveSettings(null);
    expect(resolveSettings({ ...current, leverRadiusM: 1.0 }).leverRadiusM).toBe(1.0);
  });
});

describe('settings version 3: baseline reset timestamp', () => {
  it('migrates version 2 settings: no reset recorded, other values kept', () => {
    const migrated = resolveSettings(
      legacy({
        version: 2,
        mode: 'rally',
        language: 'en',
        speakGood: true,
        speechRate: 1.3,
        leverRadiusM: 1.0,
      }),
    );
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(migrated.baselineResetAt).toBe(0);
    expect(migrated.mode).toBe('match');
    // 1.0 m was chosen with version 2 (current default then): it must stick.
    expect(migrated.leverRadiusM).toBe(1.0);
  });

  it('keeps a valid timestamp and discards a malformed one', () => {
    expect(resolveSettings({ baselineResetAt: 1_700_000_000_000 }).baselineResetAt).toBe(
      1_700_000_000_000,
    );
    expect(resolveSettings({ baselineResetAt: -5 }).baselineResetAt).toBe(0);
    expect(resolveSettings({ baselineResetAt: 'x' as never }).baselineResetAt).toBe(0);
    expect(DEFAULT_SETTINGS.baselineResetAt).toBe(0);
  });
});

describe('settings version 4: coaching modes and player inputs', () => {
  it('maps the old modes: drill → training, rally → match', () => {
    expect(resolveSettings(legacy({ version: 3, mode: 'drill' })).mode).toBe('training');
    expect(resolveSettings(legacy({ version: 3, mode: 'rally' })).mode).toBe('match');
    expect(resolveSettings(legacy({ mode: 'drill' })).mode).toBe('training');
  });

  it('keeps the new modes and replaces unknown ones by the default', () => {
    for (const mode of ['learning', 'training', 'match'] as const) {
      expect(resolveSettings({ mode }).mode).toBe(mode);
    }
    expect(resolveSettings(legacy({ mode: 'party' })).mode).toBe('training');
    expect(DEFAULT_SETTINGS.mode).toBe('training');
  });

  it('defaults the player inputs for version 3 settings and keeps valid ones', () => {
    const migrated = resolveSettings(legacy({ version: 3, mode: 'drill', language: 'en' }));
    expect(migrated).toMatchObject({
      version: SETTINGS_VERSION,
      dominantHand: 'right',
      backhand: 'two-handed',
      forehandStyle: 'mixed',
      level: 'intermediate',
      language: 'en',
    });
    const chosen = resolveSettings({
      dominantHand: 'left',
      backhand: 'one-handed',
      forehandStyle: 'flat',
      level: 'beginner',
    });
    expect(chosen).toMatchObject({
      dominantHand: 'left',
      backhand: 'one-handed',
      forehandStyle: 'flat',
      level: 'beginner',
    });
    const broken = resolveSettings(
      legacy({ dominantHand: 'both', backhand: 3, forehandStyle: null, level: 'pro' }),
    );
    expect(broken).toMatchObject({
      dominantHand: 'right',
      backhand: 'two-handed',
      forehandStyle: 'mixed',
      level: 'intermediate',
    });
  });
});

describe('settings version 5: speech', () => {
  it('is version 5 with the speech defaults', () => {
    expect(SETTINGS_VERSION).toBe(5);
    expect(DEFAULT_SETTINGS).toMatchObject({
      version: 5,
      feedbackFrequency: 'every',
      voice: { lang: 'en', rate: 1.1, pitch: 1, volume: 1 },
      speechMuted: false,
      autoRallyMute: false,
    });
    expect(DEFAULT_SETTINGS.voice.voiceURI).toBeUndefined();
  });

  /** Settings as stored by each earlier version (with the then-current fields). */
  const stored: Record<string, Record<string, unknown>> = {
    unversioned: {
      mode: 'drill',
      language: 'et',
      speakGood: true,
      speechRate: 1.4,
      leverRadiusM: 1.0,
    },
    v2: {
      version: 2,
      mode: 'rally',
      language: 'en',
      speakGood: false,
      speechRate: 0.8,
      leverRadiusM: 0.9,
    },
    v3: {
      version: 3,
      mode: 'drill',
      language: 'et',
      speakGood: false,
      speechRate: 1.6,
      leverRadiusM: 0.72,
      baselineResetAt: 5,
    },
    v4: {
      version: 4,
      mode: 'learning',
      language: 'en',
      speakGood: true,
      speechRate: 1.2,
      leverRadiusM: 0.72,
      baselineResetAt: 0,
      experimentalM416: true,
      dominantHand: 'left',
      backhand: 'one-handed',
      forehandStyle: 'flat',
      level: 'advanced',
    },
  };

  it.each(Object.entries(stored))(
    'migrates %s settings: rate from speechRate, other speech fields default',
    (_name, old) => {
      const migrated = resolveSettings(legacy(old));
      expect(migrated.version).toBe(5);
      expect(migrated.voice).toEqual({
        lang: 'en',
        rate: old['speechRate'],
        pitch: 1,
        volume: 1,
      });
      expect(migrated.feedbackFrequency).toBe('every');
      expect(migrated.speechMuted).toBe(false);
      expect(migrated.autoRallyMute).toBe(false);
      expect('speechRate' in migrated).toBe(false);
      expect(migrated.speakGood).toBe(old['speakGood']);
      expect(migrated.language).toBe(old['language']);
    },
  );

  it('keeps the other fields of version 4 settings', () => {
    expect(resolveSettings(legacy(stored['v4'] ?? {}))).toMatchObject({
      mode: 'learning',
      experimentalM416: true,
      dominantHand: 'left',
      backhand: 'one-handed',
      forehandStyle: 'flat',
      level: 'advanced',
    });
  });

  it('falls back to the default rate for a missing or invalid old speechRate', () => {
    expect(resolveSettings(legacy({ version: 4 })).voice.rate).toBe(1.1);
    expect(resolveSettings(legacy({ version: 4, speechRate: 7 })).voice.rate).toBe(1.1);
  });

  it('keeps valid version 5 speech settings and repairs malformed ones', () => {
    const current = resolveSettings({
      feedbackFrequency: 'every3',
      voice: { lang: 'et', voiceURI: 'com.apple.voice.Karl', rate: 0.9, pitch: 1.3, volume: 0.5 },
      speechMuted: true,
      autoRallyMute: true,
    });
    expect(current).toMatchObject({
      feedbackFrequency: 'every3',
      voice: { lang: 'et', voiceURI: 'com.apple.voice.Karl', rate: 0.9, pitch: 1.3, volume: 0.5 },
      speechMuted: true,
      autoRallyMute: true,
    });
    // A round trip keeps it (the version 5 rate wins over any leftover speechRate).
    expect(resolveSettings(legacy({ ...current, speechRate: 2 }))).toEqual(current);
    const broken = resolveSettings(
      legacy({
        feedbackFrequency: 'sometimes',
        voice: { lang: 'fi', voiceURI: '', rate: 5, pitch: -1, volume: 3 },
        speechMuted: 'yes',
        autoRallyMute: 1,
      }),
    );
    expect(broken).toMatchObject({
      feedbackFrequency: 'every',
      voice: { lang: 'en', rate: 1.1, pitch: 1, volume: 1 },
      speechMuted: false,
      autoRallyMute: false,
    });
    expect(broken.voice.voiceURI).toBeUndefined();
    expect(resolveSettings(legacy({ voice: 'loud' })).voice).toEqual(DEFAULT_SETTINGS.voice);
  });
});
