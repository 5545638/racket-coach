import type { FeedbackFrequency, UtteranceKind } from '../domain/types';
import type { SpeechCategory } from './speech';

/**
 * What of the coach's decisions is spoken (docs/architecture.md, "Speech").
 * Applied after the coach decided; the controller re-runs the coach step as
 * unheard for a suppressed cue, so the coach never builds on it.
 */

/** Queue category of a stroke utterance. */
export function categoryOf(kind: UtteranceKind): SpeechCategory {
  switch (kind) {
    case 'better':
    case 'keep-it':
    case 'good':
      return 'feedback';
    case 'fatigue':
      return 'info';
    case 'correction':
    case 'overcorrected':
    case 'consistency':
    case 'stuck':
    case 'silent':
      return 'correction';
  }
}

/** Why a stroke utterance was not spoken (before the queue). */
export type SuppressReason = 'muted' | 'off' | 'rally' | 'unchanged' | 'frequency';

const EVERY_N: Partial<Record<FeedbackFrequency, number>> = { every2: 2, every3: 3 };

/**
 * Feedback frequency of one session:
 * - 'every': whatever the coach decided;
 * - 'changes': a correction only when its text differs from the last one heard
 *   in its lane; feedback ("Better", reinforce, "Good") always;
 * - 'every2' / 'every3': at most one heard correction per 2 / 3 strokes;
 *   feedback always;
 * - 'off': nothing per stroke.
 * Only heard utterances (see `heard`) count.
 */
export class FeedbackGate {
  private strokeIndex = 0;
  private lastCorrectionAt: number | null = null;
  private readonly lastTextByLane = new Map<string, string>();

  /** Counts a stroke; returns its number (1, 2, …) for `heard`. */
  nextStroke(): number {
    return ++this.strokeIndex;
  }

  allows(
    frequency: FeedbackFrequency,
    kind: UtteranceKind,
    lane: string,
    text: string,
  ): SuppressReason | null {
    if (frequency === 'off') return 'off';
    if (frequency === 'every' || categoryOf(kind) !== 'correction') return null;
    if (frequency === 'changes') {
      return this.lastTextByLane.get(lane) === text ? 'unchanged' : null;
    }
    const n = EVERY_N[frequency] ?? 1;
    return this.lastCorrectionAt !== null && this.strokeIndex - this.lastCorrectionAt < n
      ? 'frequency'
      : null;
  }

  /** The utterance of stroke `stroke` started (was heard). */
  heard(kind: UtteranceKind, lane: string, text: string, stroke: number): void {
    if (categoryOf(kind) !== 'correction') return;
    this.lastTextByLane.set(lane, text);
    this.lastCorrectionAt = Math.max(this.lastCorrectionAt ?? 0, stroke);
  }
}

export interface RallyConfig {
  /** Consecutive strokes closer than this are rally play, ms. */
  readonly maxGapMs: number;
  /** Strokes in a row (all gaps < maxGapMs) that start a rally. */
  readonly minStrokes: number;
  /** A pause at least this long ends the rally, ms. */
  readonly endGapMs: number;
}

export const DEFAULT_RALLY_CONFIG: RallyConfig = { maxGapMs: 3500, minStrokes: 3, endGapMs: 6000 };

/**
 * Detects rally play from stroke times: ≥ 3 strokes with < 3.5 s between
 * consecutive strokes start a rally; it lasts until a gap of ≥ 6 s. Gaps in
 * between keep a running rally but restart the count otherwise.
 */
export class RallyDetector {
  private last: number | null = null;
  private run = 0;
  private active = false;

  constructor(private readonly config: RallyConfig = DEFAULT_RALLY_CONFIG) {}

  /** Records a stroke at `at` ms; returns whether play is now a rally. */
  observe(at: number): boolean {
    const gap = this.last === null ? null : at - this.last;
    this.last = at;
    if (gap !== null && gap < this.config.maxGapMs) {
      this.run++;
    } else {
      if (gap === null || gap >= this.config.endGapMs) this.active = false;
      this.run = 1;
    }
    if (this.run >= this.config.minStrokes) this.active = true;
    return this.active;
  }

  /** A rally is running and no ≥ endGapMs pause has happened by `now`. */
  isActive(now: number): boolean {
    return this.active && this.last !== null && now - this.last < this.config.endGapMs;
  }

  reset(): void {
    this.last = null;
    this.run = 0;
    this.active = false;
  }
}

/** p-quantile (0–1) of `values` by linear interpolation; null when empty. */
export function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}
