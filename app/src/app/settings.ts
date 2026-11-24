import type { Language } from '../coaching/guidance';

/**
 * `drill`: spoken cue after every stroke (feeding, ball machine).
 * `rally`: silent during play; review the session afterwards.
 */
export type FeedbackMode = 'drill' | 'rally';

export type { Language } from '../coaching/guidance';

/**
 * Schema version of stored settings. Version 2 changed the default lever from
 * 1.0 m to 0.72 m; settings stored without a version predate that change.
 */
export const SETTINGS_VERSION = 2;

export interface Settings {
  readonly version: typeof SETTINGS_VERSION;
  readonly mode: FeedbackMode;
  /** Language of the on-screen explanations. Spoken cues are always English. */
  readonly language: Language;
  /** Also say "Good" when no rule fires. */
  readonly speakGood: boolean;
  /** Speech rate multiplier, 0.5–2. */
  readonly speechRate: number;
  /**
   * See AnalysisParams.leverRadiusM. Head speed is a model estimate that
   * scales with this lever; best used as a personal trend.
   */
  readonly leverRadiusM: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  mode: 'drill',
  language: 'et',
  speakGood: false,
  speechRate: 1.1,
  leverRadiusM: 0.72,
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
  const legacy = stored.version !== SETTINGS_VERSION;
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
  };
}

function inRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}
