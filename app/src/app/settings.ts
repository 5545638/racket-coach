import type { Settings } from '../domain/types';

export type { FeedbackMode, Settings } from '../domain/types';
export type { Language } from '../coaching/guidance';

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
