import { CORRECTIONS, type CorrectionId, FEEDBACK_PHRASES } from '../coaching/corrections';
import { NOT_RATED_CUE, NO_READING_CUE } from '../coaching/rules';
import type { Cue, StrokeType, UtteranceKind } from '../domain/types';
import { type ElementAssessment, type StrokeAssessment, byCorrection } from '../elements/assess';

/**
 * Live coaching: turns one stroke's assessment into at most one spoken
 * phrase, keeping one focus per stroke type. Pure step function; the
 * controller owns the state. See docs/metrics.md, "Coaching engine".
 */
export interface CoachConfig {
  /** Say "Good" for a stroke without faults (otherwise the 'good' utterance is silent). */
  readonly speakGood: boolean;
  /** At most this many identical utterances in a row… */
  readonly maxRepeats: number;
  /** …then this many strokes of silence. */
  readonly pauseAfterRepeats: number;
  /** The focus is cleared after this many consecutive ok strokes. */
  readonly okStrokesToClear: number;
  /** A different fault takes over only with a score ≥ this × the focus fault's score. */
  readonly replaceRatio: number;
  /** The focus is cleared after this many consecutive strokes on which it was not assessable. */
  readonly notAssessableToClear: number;
}

export const DEFAULT_COACH_CONFIG: CoachConfig = {
  speakGood: false,
  maxRepeats: 3,
  pauseAfterRepeats: 2,
  okStrokesToClear: 3,
  replaceRatio: 2,
  notAssessableToClear: 5,
};

export type { UtteranceKind } from '../domain/types';

export interface Utterance {
  readonly kind: UtteranceKind;
  /** The correction spoken, or (for 'better' and a silenced repeat) the focus still at fault. */
  readonly correctionId?: CorrectionId;
  /** English phrase to say; empty when nothing is to be said. */
  readonly spoken: string;
  /** Machine-readable why, for the UI and for tests. */
  readonly reason: UtteranceReason;
}

export type UtteranceReason =
  | 'new-focus'
  | 'focus-replaced'
  | 'focus-persists'
  | 'improved'
  | 'focus-ok'
  | 'focus-holding'
  | 'no-faults'
  | 'repeat-pause'
  | 'no-contact'
  | 'focus-not-assessable'
  | 'not-assessable';

export interface FocusState {
  readonly correctionId: CorrectionId;
  /** d and σ of the focus on the previous stroke of this type, when it was a fault there. */
  readonly lastDistance: number | null;
  readonly lastSigma: number | null;
  /** Score of the focus when it last was a fault (the bar for a replacement). */
  readonly faultScore: number;
  readonly okStreak: number;
  readonly notAssessableStreak: number;
}

export interface StrokeTypeCoachState {
  readonly focus: FocusState | null;
  /** Last non-empty phrase considered for speaking, and how many strokes in a row it was. */
  readonly lastSpoken: string | null;
  readonly repeat: number;
}

export interface CoachState {
  readonly byStroke: Readonly<Record<StrokeType, StrokeTypeCoachState>>;
}

const IDLE: StrokeTypeCoachState = { focus: null, lastSpoken: null, repeat: 0 };

export const INITIAL_COACH_STATE: CoachState = {
  byStroke: { forehand: IDLE, backhand: IDLE, overhead: IDLE },
};

export interface CoachStep {
  readonly state: CoachState;
  readonly utterance: Utterance;
}

const spokenCue = (id: CorrectionId): string => CORRECTIONS.en[id].spoken;
const GOOD_PHRASE = 'Good';

const correction = (e: ElementAssessment, reason: UtteranceReason): Utterance => ({
  kind: 'correction',
  correctionId: e.correctionId,
  spoken: spokenCue(e.correctionId),
  reason,
});

const silent = (reason: UtteranceReason, correctionId?: CorrectionId): Utterance =>
  correctionId === undefined
    ? { kind: 'silent', spoken: '', reason }
    : { kind: 'silent', correctionId, spoken: '', reason };

const newFocus = (e: ElementAssessment): FocusState => ({
  correctionId: e.correctionId,
  lastDistance: e.distance,
  lastSigma: e.sigma,
  faultScore: e.score,
  okStreak: 0,
  notAssessableStreak: 0,
});

/** Picks the focus and the phrase, before the repeat limit is applied. */
function decide(
  focus: FocusState | null,
  assessment: StrokeAssessment,
  config: CoachConfig,
): { readonly focus: FocusState | null; readonly utterance: Utterance } {
  const verdicts = byCorrection(assessment);
  const faults = assessment.faults;
  const anyOk = assessment.elements.some((e) => e.status === 'ok');

  const noFocus = (): { focus: FocusState | null; utterance: Utterance } => {
    const top = faults[0];
    if (top) return { focus: newFocus(top), utterance: correction(top, 'new-focus') };
    if (anyOk) {
      return {
        focus: null,
        utterance: {
          kind: 'good',
          spoken: config.speakGood ? GOOD_PHRASE : '',
          reason: 'no-faults',
        },
      };
    }
    return { focus: null, utterance: silent('not-assessable') };
  };

  if (focus === null) return noFocus();

  const current = verdicts.get(focus.correctionId) ?? null;
  // A much bigger different fault takes over. The bar is the focus fault's
  // score now, or its last fault score while it is ok or not assessable.
  const bar = current?.status === 'fault' ? current.score : focus.faultScore;
  const challenger = faults.find((f) => f.correctionId !== focus.correctionId);
  if (challenger && challenger.score >= config.replaceRatio * bar) {
    return { focus: newFocus(challenger), utterance: correction(challenger, 'focus-replaced') };
  }

  if (current === null || current.status === 'not-assessable') {
    const streak = focus.notAssessableStreak + 1;
    if (streak >= config.notAssessableToClear) return noFocus();
    return {
      focus: { ...focus, notAssessableStreak: streak },
      utterance: silent('focus-not-assessable', focus.correctionId),
    };
  }

  if (current.status === 'fault') {
    const next: FocusState = {
      ...focus,
      lastDistance: current.distance,
      lastSigma: current.sigma,
      faultScore: current.score,
      okStreak: 0,
      notAssessableStreak: 0,
    };
    const improved =
      focus.lastDistance !== null &&
      focus.lastSigma !== null &&
      current.sigma !== null &&
      focus.lastDistance - current.distance >= Math.hypot(focus.lastSigma, current.sigma);
    return {
      focus: next,
      utterance: improved
        ? {
            kind: 'better',
            correctionId: focus.correctionId,
            spoken: FEEDBACK_PHRASES.better,
            reason: 'improved',
          }
        : correction(current, 'focus-persists'),
    };
  }

  // The focus element is ok on this stroke.
  const okStreak = focus.okStreak + 1;
  if (okStreak >= config.okStrokesToClear) return noFocus();
  const next: FocusState = {
    ...focus,
    lastDistance: null,
    lastSigma: null,
    okStreak,
    notAssessableStreak: 0,
  };
  if (okStreak === 1) {
    return {
      focus: next,
      utterance: { kind: 'keep-it', spoken: FEEDBACK_PHRASES.keepIt, reason: 'focus-ok' },
    };
  }
  return {
    focus: next,
    utterance:
      faults.length === 0
        ? { kind: 'good', spoken: config.speakGood ? GOOD_PHRASE : '', reason: 'no-faults' }
        : silent('focus-holding'),
  };
}

/**
 * One coaching step for one stroke.
 *
 * - One focus per stroke type. Without a focus the highest-scoring fault
 *   becomes the focus and is spoken.
 * - Focus still at fault: "Better" when it improved by at least the combined
 *   measurement σ (d_prev − d_now ≥ √(σ_prev² + σ_now²)), else its cue again.
 * - Focus ok: "That's it" on the first ok stroke; cleared after
 *   `okStrokesToClear` ok strokes in a row.
 * - A different fault replaces the focus only with ≥ `replaceRatio` × its score.
 * - Focus not assessable: silent; cleared after `notAssessableToClear` strokes.
 * - No faults: 'good' (spoken only with `speakGood`).
 * - No contact (shadow swing, miss): silent, state unchanged.
 * - The same phrase at most `maxRepeats` times in a row, then
 *   `pauseAfterRepeats` silent strokes (silent strokes do not break the run).
 */
export function coachStep(
  state: CoachState,
  assessment: StrokeAssessment,
  config: CoachConfig = DEFAULT_COACH_CONFIG,
): CoachStep {
  if (!assessment.contact) return { state, utterance: silent('no-contact') };
  const type = assessment.strokeType;
  const own = state.byStroke[type];
  const decided = decide(own.focus, assessment, config);
  let utterance = decided.utterance;
  let { lastSpoken, repeat } = own;

  if (utterance.spoken !== '') {
    repeat = utterance.spoken === lastSpoken ? repeat + 1 : 1;
    lastSpoken = utterance.spoken;
    const position = (repeat - 1) % (config.maxRepeats + config.pauseAfterRepeats);
    if (position >= config.maxRepeats) {
      utterance = silent('repeat-pause', utterance.correctionId);
    }
  }

  return {
    state: {
      byStroke: { ...state.byStroke, [type]: { focus: decided.focus, lastSpoken, repeat } },
    },
    utterance,
  };
}

/** The current focus per stroke type, for display. */
export function focusByStroke(
  state: CoachState,
): Readonly<Record<StrokeType, CorrectionId | null>> {
  return {
    forehand: state.byStroke.forehand.focus?.correctionId ?? null,
    backhand: state.byStroke.backhand.focus?.correctionId ?? null,
    overhead: state.byStroke.overhead.focus?.correctionId ?? null,
  };
}

const fix = (id: CorrectionId): Cue => ({ ruleId: id, severity: 'fix', text: spokenCue(id) });

/**
 * The legacy per-stroke `Cue` (session report, statistics, export) for a
 * coached stroke. It records the stroke's verdict, not only what was said:
 * a "Better" or a silenced repeat is still a fix of the focus.
 */
export function cueForStroke(utterance: Utterance, assessment: StrokeAssessment): Cue {
  if (!assessment.contact) return NOT_RATED_CUE;
  if (utterance.correctionId !== undefined) return fix(utterance.correctionId);
  if (utterance.kind === 'keep-it') {
    return { ruleId: 'good', severity: 'good', text: FEEDBACK_PHRASES.keepIt };
  }
  const top = assessment.faults[0];
  if (top) return fix(top.correctionId);
  if (assessment.elements.some((e) => e.status === 'ok')) {
    return { ruleId: 'good', severity: 'good', text: GOOD_PHRASE };
  }
  // Nothing could be judged. Unjudged because nothing applies yet (no
  // population limit, no baseline) = counted; because data was missing = no reading.
  const counted = assessment.elements.every(
    (e) => e.reason === 'wrong-stroke' || e.reason === 'no-baseline',
  );
  return counted ? NOT_RATED_CUE : NO_READING_CUE;
}
