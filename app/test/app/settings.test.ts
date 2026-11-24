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
