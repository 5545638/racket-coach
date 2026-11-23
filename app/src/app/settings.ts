/**
 * `drill`: spoken cue after every stroke (feeding, ball machine).
 * `rally`: silent during play; review the session afterwards.
 */
export type FeedbackMode = 'drill' | 'rally';

export interface Settings {
  readonly mode: FeedbackMode;
  /** Also say "Good" when no rule fires. */
  readonly speakGood: boolean;
  /** Speech rate multiplier, 0.5–2. */
  readonly speechRate: number;
  /** See AnalysisParams.leverRadiusM. */
  readonly leverRadiusM: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'drill',
  speakGood: false,
  speechRate: 1.1,
  leverRadiusM: 1.0,
};

/** Merges stored values over defaults, discarding anything malformed. */
export function resolveSettings(stored: Partial<Settings> | null): Settings {
  if (!stored) return DEFAULT_SETTINGS;
  return {
    mode: stored.mode === 'rally' || stored.mode === 'drill' ? stored.mode : DEFAULT_SETTINGS.mode,
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
