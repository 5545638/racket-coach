import type { Settings } from '../domain/types';

export type { FeedbackMode, Settings } from '../domain/types';
export type { Language } from '../coaching/guidance';

/**
 * Schema version of stored settings. Version 2 changed the default lever from
 * 1.0 m to 0.72 m; settings stored without a version predate that change.
 * Version 3 added `baselineResetAt` (missing = never reset, no data change).
 */
export const SETTINGS_VERSION = 3;

/** First version whose default lever is 0.72 m. */
const LEVER_DEFAULT_CHANGED_IN = 2;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  mode: 'drill',
  language: 'et',
  speakGood: false,
  speechRate: 1.1,
  leverRadiusM: 0.72,
  baselineResetAt: 0,
};

/** Default lever of settings stored before version 2, m. */
export const LEGACY_DEFAULT_LEVER_RADIUS_M = 1.0;

/**
 * Migrates the lever of settings stored before version 2: exactly 1.0 m is
 * taken to be the untouched old default and replaced by the current default
 * (a user who deliberately chose 1.0 m has to set it again, once). Settings
 * that already carry the current version are never migrated, so choosing
 * 1.0 m today sticks.
 */
export function migrateLeverRadius(stored: Partial<Settings>): unknown {
  const legacy = typeof stored.version !== 'number' || stored.version < LEVER_DEFAULT_CHANGED_IN;
  return legacy && stored.leverRadiusM === LEGACY_DEFAULT_LEVER_RADIUS_M
    ? DEFAULT_SETTINGS.leverRadiusM
    : stored.leverRadiusM;
}

/**
 * Merges stored values over defaults, discarding anything malformed and
 * migrating the old default lever (see `migrateLeverRadius`).
 */
export function resolveSettings(stored: Partial<Settings> | null): Settings {
  if (!stored) return DEFAULT_SETTINGS;
  return {
    version: SETTINGS_VERSION,
    mode: stored.mode === 'rally' || stored.mode === 'drill' ? stored.mode : DEFAULT_SETTINGS.mode,
    language:
      stored.language === 'en' || stored.language === 'et'
        ? stored.language
        : DEFAULT_SETTINGS.language,
    speakGood:
      typeof stored.speakGood === 'boolean' ? stored.speakGood : DEFAULT_SETTINGS.speakGood,
    speechRate: inRange(stored.speechRate, 0.5, 2) ?? DEFAULT_SETTINGS.speechRate,
    leverRadiusM: inRange(migrateLeverRadius(stored), 0.5, 2) ?? DEFAULT_SETTINGS.leverRadiusM,
    baselineResetAt: inRange(stored.baselineResetAt, 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}

function inRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}
