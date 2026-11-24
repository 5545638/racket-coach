import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_LEVER_RADIUS_M,
  SETTINGS_VERSION,
  resolveSettings,
} from '../../src/app/settings';
import { DEFAULT_ANALYSIS_PARAMS } from '../../src/metrics/analyzeSwing';

describe('lever radius default and migration', () => {
  it('defaults to the 0.72 m effective radius, matching the analysis', () => {
    expect(DEFAULT_SETTINGS.leverRadiusM).toBe(0.72);
    expect(DEFAULT_ANALYSIS_PARAMS.leverRadiusM).toBe(DEFAULT_SETTINGS.leverRadiusM);
  });

  it('migrates the old 1.0 m default from settings stored before version 2', () => {
    const stored = { mode: 'rally' as const, leverRadiusM: LEGACY_DEFAULT_LEVER_RADIUS_M };
    expect(resolveSettings(stored)).toEqual({
      ...DEFAULT_SETTINGS,
      mode: 'rally',
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
    const migrated = resolveSettings({
      version: 2,
      mode: 'rally',
      language: 'en',
      speakGood: true,
      speechRate: 1.3,
      leverRadiusM: 1.0,
    });
    expect(migrated.version).toBe(3);
    expect(SETTINGS_VERSION).toBe(3);
    expect(migrated.baselineResetAt).toBe(0);
    expect(migrated.mode).toBe('rally');
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
