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
  it('is version 4', () => {
    expect(SETTINGS_VERSION).toBe(4);
    expect(DEFAULT_SETTINGS.version).toBe(4);
  });

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
      version: 4,
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
