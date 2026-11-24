import type { CoachMode, PlayerInputs, Settings } from '../domain/types';

export type { CoachMode, FeedbackMode, PlayerInputs, Settings } from '../domain/types';
export type { Language } from '../coaching/guidance';

/**
 * Schema version of stored settings. Version 2 changed the default lever from
 * 1.0 m to 0.72 m; settings stored without a version predate that change.
 * Version 3 added `baselineResetAt` (missing = never reset, no data change).
 * `experimentalM416` was added later without a version change (missing = off).
 * Version 4 replaced the modes `drill` / `rally` by `learning` / `training` /
 * `match` (drill → training, rally → match) and added the player inputs
 * `dominantHand`, `backhand`, `forehandStyle` and `level` (missing = defaults).
 */
export const SETTINGS_VERSION = 4;

/** First version whose default lever is 0.72 m. */
const LEVER_DEFAULT_CHANGED_IN = 2;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  mode: 'training',
  language: 'et',
  speakGood: false,
  speechRate: 1.1,
  leverRadiusM: 0.72,
  baselineResetAt: 0,
  experimentalM416: false,
  dominantHand: 'right',
  backhand: 'two-handed',
  forehandStyle: 'mixed',
  level: 'intermediate',
};

/** The player inputs of the settings. */
export const playerInputs = (s: Settings): PlayerInputs => ({
  dominantHand: s.dominantHand,
  backhand: s.backhand,
  forehandStyle: s.forehandStyle,
  level: s.level,
});

/**
 * The coaching mode of stored settings: the version 4 names as they are, the
 * older ones mapped (drill → training, rally → match), anything else the default.
 */
export function migrateMode(mode: unknown): CoachMode {
  switch (mode) {
    case 'learning':
    case 'training':
    case 'match':
      return mode;
    case 'drill':
      return 'training';
    case 'rally':
      return 'match';
    default:
      return DEFAULT_SETTINGS.mode;
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

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
    mode: migrateMode(stored.mode),
    language:
      stored.language === 'en' || stored.language === 'et'
        ? stored.language
        : DEFAULT_SETTINGS.language,
    speakGood:
      typeof stored.speakGood === 'boolean' ? stored.speakGood : DEFAULT_SETTINGS.speakGood,
    speechRate: inRange(stored.speechRate, 0.5, 2) ?? DEFAULT_SETTINGS.speechRate,
    leverRadiusM: inRange(migrateLeverRadius(stored), 0.5, 2) ?? DEFAULT_SETTINGS.leverRadiusM,
    baselineResetAt: inRange(stored.baselineResetAt, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    experimentalM416: stored.experimentalM416 === true,
    dominantHand: oneOf(stored.dominantHand, ['right', 'left'], DEFAULT_SETTINGS.dominantHand),
    backhand: oneOf(stored.backhand, ['two-handed', 'one-handed'], DEFAULT_SETTINGS.backhand),
    forehandStyle: oneOf(
      stored.forehandStyle,
      ['topspin', 'flat', 'mixed'],
      DEFAULT_SETTINGS.forehandStyle,
    ),
    level: oneOf(stored.level, ['beginner', 'intermediate', 'advanced'], DEFAULT_SETTINGS.level),
  };
}

function inRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}
