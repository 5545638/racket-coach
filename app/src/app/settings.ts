import type { Language } from '../coaching/guidance';

/**
 * `drill`: spoken cue after every stroke (feeding, ball machine).
 * `rally`: silent during play; review the session afterwards.
 */
export type FeedbackMode = 'drill' | 'rally';

export type { Language } from '../coaching/guidance';

export interface Settings {
  readonly mode: FeedbackMode;
  /** Language of the on-screen explanations. Spoken cues are always English. */
  readonly language: Language;
  /** Also say "Good" when no rule fires. */
  readonly speakGood: boolean;
  /** Speech rate multiplier, 0.5–2. */
  readonly speechRate: number;
  /** See AnalysisParams.leverRadiusM. */
  readonly leverRadiusM: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'drill',
  language: 'et',
  speakGood: false,
  speechRate: 1.1,
  leverRadiusM: 1.0,
};

/** Merges stored values over defaults, discarding anything malformed. */
export function resolveSettings(stored: Partial<Settings> | null): Settings {
  if (!stored) return DEFAULT_SETTINGS;
  return {
    mode: stored.mode === 'rally' || stored.mode === 'drill' ? stored.mode : DEFAULT_SETTINGS.mode,
    language:
      stored.language === 'en' || stored.language === 'et'
        ? stored.language
        : DEFAULT_SETTINGS.language,
    speakGood:
      typeof stored.speakGood === 'boolean' ? stored.speakGood : DEFAULT_SETTINGS.speakGood,
    speechRate: inRange(stored.speechRate, 0.5, 2) ?? DEFAULT_SETTINGS.speechRate,
    leverRadiusM: inRange(stored.leverRadiusM, 0.5, 2) ?? DEFAULT_SETTINGS.leverRadiusM,
  };
}

function inRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}
