import { CORRECTIONS, type CorrectionId } from '../coaching/corrections';
import { NOT_RATED_CUE, NO_READING_CUE } from '../coaching/rules';
import type {
  CoachMode,
  Cue,
  PhraseLevel,
  StrokeCategories,
  StrokeType,
  UtteranceKind,
} from '../domain/types';
import {
  type Band,
  type BandSource,
  type ElementAssessment,
  type StrokeAssessment,
  byCorrection,
} from '../elements/assess';
import { classifyStroke } from './classify';
import { cueVariant, feedbackPhrase, learningSentence, reinforcePhrase } from './phrases';

/**
 * Live coaching: turns one stroke's assessment into at most one spoken
 * phrase, keeping one focus per stroke type, with an adaptive phrase ladder,
 * overcorrection / oscillation handling, fatigue and coaching modes. Pure
 * step function; the controller owns the state. See docs/metrics.md,
 * "Coaching engine" and "Adaptive coach".
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
  /** Ladder: spoken corrections of one focus before "Try the drill" / sparse mode (2 × v0, 2 × v1, 1 × v2). */
  readonly ladderLength: number;
  /** Sparse mode: the cue only on every n-th faulty stroke. */
  readonly sparseEvery: number;
  /** No cue that contradicts one spoken in this many previous strokes of the type. */
  readonly contradictionWindow: number;
  /** Consecutive opposite faults after which the focus switches to the opposite. */
  readonly oppositeStreakToSwitch: number;
  /** Oscillation: ≥ `oscillationSwitches` switches between opposites in the last `oscillationWindow` strokes. */
  readonly oscillationWindow: number;
  readonly oscillationSwitches: number;
  /** "Same swing every time" at most once per this many strokes of the type. */
  readonly consistencyEvery: number;
  /** "Take a short break" not again within this time, ms. */
  readonly fatigueRepeatMs: number;
  readonly match: MatchConfig;
}

/** Match mode: only a persistent major fault, between points. */
export interface MatchConfig {
  /** Rated strokes of the type looked at. */
  readonly window: number;
  /** Strokes in the window with the same fault. */
  readonly minFaults: number;
  /** Mean p of those faults. */
  readonly minMeanP: number;
  /** Catalogue weight of the fault. */
  readonly minWeight: number;
  /** Quiet time since the previous stroke before speaking (between points), ms. */
  readonly quietMs: number;
  /** At most one cue per this time, ms. */
  readonly cooldownMs: number;
}

export const DEFAULT_COACH_CONFIG: CoachConfig = {
  speakGood: false,
  maxRepeats: 3,
  pauseAfterRepeats: 2,
  okStrokesToClear: 3,
  replaceRatio: 2,
  notAssessableToClear: 5,
  ladderLength: 5,
  sparseEvery: 3,
  contradictionWindow: 5,
  oppositeStreakToSwitch: 3,
  oscillationWindow: 6,
  oscillationSwitches: 3,
  consistencyEvery: 10,
  fatigueRepeatMs: 10 * 60_000,
  match: {
    window: 8,
    minFaults: 5,
    minMeanP: 0.9,
    minWeight: 0.8,
    quietMs: 8_000,
    cooldownMs: 10 * 60_000,
  },
};

/**
 * Opposite corrections: the same metric, faulted on the other side, so one
 * cue pushes towards the other. slice-chop (path, slices) and
 * slice-face-closed (face, slices) read different metrics and are not
 * opposite; high-takeback, no-racket-drop and the timing cues have no
 * opposite element.
 */
export const OPPOSITES: Readonly<Partial<Record<CorrectionId, CorrectionId>>> = {
  'face-open': 'face-closed',
  'face-closed': 'face-open',
  'path-flat': 'path-steep',
  'path-steep': 'path-flat',
};

export const oppositeOf = (id: CorrectionId): CorrectionId | null => OPPOSITES[id] ?? null;

export type { UtteranceKind } from '../domain/types';

export interface Utterance {
  readonly kind: UtteranceKind;
  /** The correction spoken, or (for 'better' and a silenced repeat) the focus still at fault. */
  readonly correctionId?: CorrectionId;
  /** English phrase decided for this stroke; empty when nothing is to be said. */
  readonly spoken: string;
  /** Machine-readable why, for the UI and for tests. */
  readonly reason: UtteranceReason;
  /** Cue variant of a correction; for 'better' the variant that worked. */
  readonly level?: PhraseLevel;
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
  | 'not-assessable'
  /* Adaptive coach. */
  | 'stuck'
  | 'ladder-sparse'
  | 'overcorrected'
  | 'contradiction'
  | 'oscillation'
  | 'fatigue'
  | 'fatigue-hold'
  | 'persistent-major-fault';

export interface FocusState {
  readonly correctionId: CorrectionId;
  /** d and σ of the focus on the previous stroke of this type, when it was a fault there. */
  readonly lastDistance: number | null;
  readonly lastSigma: number | null;
  /**
   * Element (catalogue key) whose d and σ those are. One correction can have
   * several elements in different units, so "Better" compares like with like.
   */
  readonly lastKey: string | null;
  /** Where the band of that stroke came from, and its bounds: d is only comparable within one band. */
  readonly lastBandSource: BandSource | null;
  readonly lastBand: Band | null;
  /** Score of the focus when it last was a fault (the bar for a replacement). */
  readonly faultScore: number;
  readonly okStreak: number;
  readonly notAssessableStreak: number;
  /** "That's it" has been said (heard) for the current ok run. */
  readonly thatsItSaid: boolean;
  /* Phrase ladder (heard corrections only). */
  /** Corrections spoken since the ladder was last reset. */
  readonly spokenCount: number;
  /** Variant the ladder starts from: the one that last worked. */
  readonly baseLevel: PhraseLevel;
  /** Variant of the last spoken correction. */
  readonly lastLevel: PhraseLevel | null;
  /** "Better" or "That's it" was heard for this focus. */
  readonly hadSuccess: boolean;
  readonly stuckSaid: boolean;
  /** Faulty strokes since the ladder ran out. */
  readonly sparseCount: number;
  /** Consecutive strokes with the opposite fault. */
  readonly oppositeStreak: number;
}

/** One previous stroke of a type, for contradiction and oscillation checks. */
export interface RecentStroke {
  /** Correction whose cue was spoken (heard) on the stroke. */
  readonly cue: CorrectionId | null;
  /** Faults of correction pairs (see OPPOSITES) on the stroke. */
  readonly pairFaults: readonly CorrectionId[];
}

/** Faults of one rated stroke, for match mode. */
export interface RatedFault {
  readonly correctionId: CorrectionId;
  readonly probability: number;
  readonly weight: number;
}

export interface StrokeTypeCoachState {
  readonly focus: FocusState | null;
  /** Last non-empty phrase considered for speaking, and how many strokes in a row it was. */
  readonly lastSpoken: string | null;
  readonly repeat: number;
  /** Previous strokes of this type, newest last (at most 6). */
  readonly recent: readonly RecentStroke[];
  /** Strokes of this type since "Same swing every time" (null = not said yet). */
  readonly sinceConsistency: number | null;
  /** Faults of the last rated strokes of this type, newest last (match window). */
  readonly rated: readonly (readonly RatedFault[])[];
}

export interface MatchState {
  /** A persistent major fault waiting for a break in play. */
  readonly pending: { readonly correctionId: CorrectionId; readonly strokeType: StrokeType } | null;
  readonly lastSpokenAt: number | null;
}

export interface CoachState {
  readonly byStroke: Readonly<Record<StrokeType, StrokeTypeCoachState>>;
  /** `capture.receivedAt` of the previous stroke with contact, ms. */
  readonly lastStrokeAt: number | null;
  /** When "Take a short break" was last said, ms. */
  readonly fatigueSpokenAt: number | null;
  /** Said in the current fatigue episode (used when no time is known). */
  readonly fatigueSpokenInEpisode: boolean;
  readonly match: MatchState;
}

const IDLE: StrokeTypeCoachState = {
  focus: null,
  lastSpoken: null,
  repeat: 0,
  recent: [],
  sinceConsistency: null,
  rated: [],
};

export const INITIAL_COACH_STATE: CoachState = {
  byStroke: { forehand: IDLE, backhand: IDLE, overhead: IDLE },
  lastStrokeAt: null,
  fatigueSpokenAt: null,
  fatigueSpokenInEpisode: false,
  match: { pending: null, lastSpokenAt: null },
};

/** What the controller knows besides the assessment. */
export interface CoachContext {
  readonly mode: CoachMode;
  /** `capture.receivedAt` of the stroke, ms; null when unknown. */
  readonly receivedAt: number | null;
  /** The fatigue detector is active for this stroke's type (coach/fatigue.ts). */
  readonly fatigueActive: boolean;
}

export const DEFAULT_COACH_CONTEXT: CoachContext = {
  mode: 'training',
  receivedAt: null,
  fatigueActive: false,
};

export interface CoachStep {
  readonly state: CoachState;
  /** The decision for this stroke (kept in every mode, for the record). */
  readonly utterance: Utterance;
  /** What to say now: null when nothing (always null per stroke in match mode). */
  readonly speech: string | null;
  /** Category of every applicable element. */
  readonly categories: StrokeCategories;
}

const GOOD_PHRASE = 'Good';

const spokenCue = (id: CorrectionId): string => CORRECTIONS.en[id].spoken;

const silent = (reason: UtteranceReason, correctionId?: CorrectionId): Utterance =>
  correctionId === undefined
    ? { kind: 'silent', spoken: '', reason }
    : { kind: 'silent', correctionId, spoken: '', reason };

const cueUtterance = (
  id: CorrectionId,
  level: PhraseLevel,
  reason: UtteranceReason,
): Utterance => ({
  kind: 'correction',
  correctionId: id,
  spoken: cueVariant(id, level),
  reason,
  level,
});

const newFocus = (e: ElementAssessment): FocusState => ({
  correctionId: e.correctionId,
  lastDistance: e.distance,
  lastSigma: e.sigma,
  lastKey: e.key,
  lastBandSource: e.bandSource,
  lastBand: e.band,
  faultScore: e.score,
  okStreak: 0,
  notAssessableStreak: 0,
  thatsItSaid: false,
  spokenCount: 0,
  baseLevel: 0,
  lastLevel: null,
  hadSuccess: false,
  stuckSaid: false,
  sparseCount: 0,
  oppositeStreak: 0,
});

const sameBand = (a: Band | null, b: Band | null): boolean =>
  a === null || b === null ? a === b : a.lo === b.lo && a.hi === b.hi;

const levelOf = (n: number): PhraseLevel => (((n % 3) + 3) % 3) as PhraseLevel;

/** Variant of the n-th (1-based) spoken correction: n 1–2 → base, 3–4 → base + 1, 5 → base + 2. */
export function ladderLevel(n: number, base: PhraseLevel): PhraseLevel {
  if (n <= 2) return base;
  if (n <= 4) return levelOf(base + 1);
  return levelOf(base + 2);
}

/** Ladder reset after a success ("Better", "That's it"): start again from the variant that worked. */
const succeeded = (f: FocusState): FocusState => ({
  ...f,
  spokenCount: 0,
  baseLevel: f.lastLevel ?? f.baseLevel,
  hadSuccess: true,
  stuckSaid: false,
  sparseCount: 0,
});

/** A cue the ladder still has to turn into a phrase. */
interface CueDecision {
  readonly type: 'cue';
  readonly correctionId: CorrectionId;
  readonly reason: 'new-focus' | 'focus-replaced' | 'focus-persists';
}

interface FixedDecision {
  readonly type: 'fixed';
  readonly utterance: Utterance;
}

type Decision = CueDecision | FixedDecision;

interface Decided {
  readonly focus: FocusState | null;
  readonly decision: Decision;
  /** Significant improvement of the focus on this stroke. */
  readonly improved: boolean;
}

const fixed = (utterance: Utterance): FixedDecision => ({ type: 'fixed', utterance });

/** Picks the focus and what to say, before ladder, contradiction and repeat limits. */
function decide(
  focus: FocusState | null,
  assessment: StrokeAssessment,
  config: CoachConfig,
  speaking: boolean,
): Decided {
  const verdicts = byCorrection(assessment);
  const faults = assessment.faults;
  const anyOk = assessment.elements.some((e) => e.status === 'ok');
  const good = (): FixedDecision =>
    fixed({ kind: 'good', spoken: config.speakGood ? GOOD_PHRASE : '', reason: 'no-faults' });

  const noFocus = (): Decided => {
    const top = faults[0];
    if (top) {
      return {
        focus: newFocus(top),
        decision: { type: 'cue', correctionId: top.correctionId, reason: 'new-focus' },
        improved: false,
      };
    }
    if (anyOk) return { focus: null, decision: good(), improved: false };
    return { focus: null, decision: fixed(silent('not-assessable')), improved: false };
  };

  if (focus === null) return noFocus();

  const current = verdicts.get(focus.correctionId) ?? null;

  // Overcorrection: the focus' opposite is at fault.
  const opposite = oppositeOf(focus.correctionId);
  const oppositeVerdict = opposite === null ? null : (verdicts.get(opposite) ?? null);
  if (oppositeVerdict?.status === 'fault') {
    const streak = focus.oppositeStreak + 1;
    if (streak >= config.oppositeStreakToSwitch) {
      return {
        focus: newFocus(oppositeVerdict),
        decision: {
          type: 'cue',
          correctionId: oppositeVerdict.correctionId,
          reason: 'focus-replaced',
        },
        improved: false,
      };
    }
    return {
      focus: { ...focus, oppositeStreak: streak, notAssessableStreak: 0 },
      decision: fixed({
        kind: 'overcorrected',
        correctionId: focus.correctionId,
        spoken: feedbackPhrase('overcorrected'),
        reason: 'overcorrected',
      }),
      improved: false,
    };
  }
  const base: FocusState = focus.oppositeStreak === 0 ? focus : { ...focus, oppositeStreak: 0 };

  // A much bigger different fault takes over. The bar is the focus fault's
  // score now, or its last fault score while it is ok or not assessable.
  const bar = current?.status === 'fault' ? current.score : base.faultScore;
  const challenger = faults.find((f) => f.correctionId !== base.correctionId);
  if (challenger && challenger.score >= config.replaceRatio * bar) {
    return {
      focus: newFocus(challenger),
      decision: { type: 'cue', correctionId: challenger.correctionId, reason: 'focus-replaced' },
      improved: false,
    };
  }

  if (current === null || current.status === 'not-assessable') {
    const streak = base.notAssessableStreak + 1;
    if (streak >= config.notAssessableToClear) return noFocus();
    return {
      focus: { ...base, notAssessableStreak: streak },
      decision: fixed(silent('focus-not-assessable', base.correctionId)),
      improved: false,
    };
  }

  if (current.status === 'fault') {
    // Comparable only for the same element (same unit) under the same band.
    const comparable =
      base.lastKey === current.key &&
      base.lastBandSource === current.bandSource &&
      sameBand(base.lastBand, current.band);
    const improved =
      comparable &&
      base.lastDistance !== null &&
      base.lastSigma !== null &&
      current.sigma !== null &&
      base.lastDistance - current.distance >= Math.hypot(base.lastSigma, current.sigma);
    // An unheard "Better" (match) is not spent: the reference stays, so it can still be said.
    const keepReference = improved && !speaking;
    const next: FocusState = {
      ...base,
      lastDistance: keepReference ? base.lastDistance : current.distance,
      lastSigma: keepReference ? base.lastSigma : current.sigma,
      lastKey: keepReference ? base.lastKey : current.key,
      lastBandSource: keepReference ? base.lastBandSource : current.bandSource,
      lastBand: keepReference ? base.lastBand : current.band,
      faultScore: current.score,
      okStreak: 0,
      notAssessableStreak: 0,
      thatsItSaid: false,
    };
    if (improved) {
      const worked = base.lastLevel ?? base.baseLevel;
      return {
        // A heard "Better" resets the ladder and keeps the variant that worked.
        focus: speaking ? succeeded(next) : next,
        decision: fixed({
          kind: 'better',
          correctionId: base.correctionId,
          spoken: feedbackPhrase('better'),
          reason: 'improved',
          level: worked,
        }),
        improved: true,
      };
    }
    return {
      focus: next,
      decision: { type: 'cue', correctionId: base.correctionId, reason: 'focus-persists' },
      improved: false,
    };
  }

  // The focus element is ok on this stroke.
  const okStreak = base.okStreak + 1;
  if (okStreak >= config.okStrokesToClear) return noFocus();
  const next: FocusState = {
    ...base,
    lastDistance: null,
    lastSigma: null,
    lastKey: null,
    lastBandSource: null,
    lastBand: null,
    okStreak,
    notAssessableStreak: 0,
    // "That's it" is said once, and only when heard.
    thatsItSaid: base.thatsItSaid || speaking,
  };
  if (!base.thatsItSaid && speaking) {
    return {
      focus: succeeded(next),
      decision: fixed({
        kind: 'keep-it',
        correctionId: base.correctionId,
        spoken: reinforcePhrase(base.correctionId),
        reason: 'focus-ok',
      }),
      improved: false,
    };
  }
  return {
    focus: next,
    decision: faults.length === 0 ? good() : fixed(silent('focus-holding')),
    improved: false,
  };
}

/** Turns a cue decision into a phrase on the ladder; advances the ladder only when heard. */
function applyLadder(
  focus: FocusState,
  decision: CueDecision,
  config: CoachConfig,
  speaking: boolean,
): { readonly focus: FocusState; readonly utterance: Utterance } {
  const id = decision.correctionId;
  const n = focus.spokenCount + 1;
  if (!speaking) {
    const level = ladderLevel(Math.min(n, config.ladderLength), focus.baseLevel);
    return { focus, utterance: cueUtterance(id, level, decision.reason) };
  }
  if (n <= config.ladderLength) {
    const level = ladderLevel(n, focus.baseLevel);
    return {
      focus: { ...focus, spokenCount: n, lastLevel: level },
      utterance: cueUtterance(id, level, decision.reason),
    };
  }
  if (!focus.hadSuccess && !focus.stuckSaid) {
    return {
      focus: { ...focus, stuckSaid: true },
      utterance: {
        kind: 'stuck',
        correctionId: id,
        spoken: feedbackPhrase('stuck'),
        reason: 'stuck',
      },
    };
  }
  const sparseCount = focus.sparseCount + 1;
  if (sparseCount % config.sparseEvery !== 0) {
    return { focus: { ...focus, sparseCount }, utterance: silent('ladder-sparse', id) };
  }
  // Every n-th faulty stroke: the variants in turn, starting from the one that worked.
  const level = levelOf(focus.baseLevel + sparseCount / config.sparseEvery - 1);
  return {
    focus: { ...focus, sparseCount, lastLevel: level },
    utterance: cueUtterance(id, level, decision.reason),
  };
}

const PAIRED = new Set<CorrectionId>(Object.keys(OPPOSITES) as CorrectionId[]);

/** Switches between a correction and its opposite in a sequence of paired faults. */
function switches(sequence: readonly (readonly CorrectionId[])[], id: CorrectionId): number {
  const other = oppositeOf(id);
  const side = sequence
    .map((faults) =>
      faults.includes(id) ? id : other !== null && faults.includes(other) ? other : null,
    )
    .filter((x): x is CorrectionId => x !== null);
  let n = 0;
  for (let i = 1; i < side.length; i++) if (side[i] !== side[i - 1]) n++;
  return n;
}

function speechFor(utterance: Utterance, mode: CoachMode): string | null {
  if (mode === 'match' || utterance.spoken === '') return null;
  if (mode === 'learning' && utterance.kind === 'correction' && utterance.correctionId) {
    const sentence = learningSentence(utterance.correctionId);
    return `${utterance.spoken}. ${sentence}`;
  }
  return utterance.spoken;
}

/** Persistent major fault in the match window, or null. */
function persistentMajor(
  rated: readonly (readonly RatedFault[])[],
  match: MatchConfig,
): CorrectionId | null {
  if (rated.length < match.minFaults) return null;
  const stats = new Map<CorrectionId, { n: number; p: number; weight: number }>();
  for (const faults of rated) {
    for (const f of faults) {
      const s = stats.get(f.correctionId) ?? { n: 0, p: 0, weight: f.weight };
      stats.set(f.correctionId, {
        n: s.n + 1,
        p: s.p + f.probability,
        weight: Math.max(s.weight, f.weight),
      });
    }
  }
  let best: { id: CorrectionId; n: number; meanP: number } | null = null;
  for (const [id, s] of stats) {
    const meanP = s.p / s.n;
    if (s.n < match.minFaults || meanP < match.minMeanP || s.weight < match.minWeight) continue;
    if (!best || s.n > best.n || (s.n === best.n && meanP > best.meanP))
      best = { id, n: s.n, meanP };
  }
  return best?.id ?? null;
}

/** Faults of a stroke for the match window (one per correction, the highest score). */
function ratedFaults(assessment: StrokeAssessment): RatedFault[] {
  const out: RatedFault[] = [];
  for (const e of byCorrection(assessment).values()) {
    if (e.status === 'fault') {
      out.push({ correctionId: e.correctionId, probability: e.probability, weight: e.weight });
    }
  }
  return out;
}

const isRated = (assessment: StrokeAssessment): boolean =>
  assessment.elements.some((e) => e.status === 'ok' || e.status === 'fault');

/**
 * One coaching step for one stroke.
 *
 * - One focus per stroke type. Without a focus the highest-scoring fault
 *   becomes the focus and is spoken.
 * - Focus still at fault: "Better" when it improved by at least the combined
 *   measurement σ (d_prev − d_now ≥ √(σ_prev² + σ_now²)), else its cue again,
 *   on the phrase ladder (variant 0, 0, 1, 1, 2, then "Try the drill" once,
 *   then the cue on every 3rd faulty stroke). A heard "Better" or "That's
 *   it" resets the ladder to the variant that worked.
 * - Focus ok: its reinforce phrase ("That's it") on the first ok stroke;
 *   cleared after `okStrokesToClear` ok strokes in a row.
 * - The focus' opposite at fault: "A little less" (focus kept); after
 *   `oppositeStreakToSwitch` such strokes in a row the focus switches.
 * - No cue contradicting one spoken in the previous `contradictionWindow`
 *   strokes of the type ("A little less" instead); opposite faults
 *   alternating ≥ 3 times in 6 strokes: "Same swing every time" (once per 10
 *   strokes) instead of either cue.
 * - Fatigue active: focus frozen, "Take a short break" once (not again for
 *   10 min), faults marked fatigue-related.
 * - A different fault replaces the focus only with ≥ `replaceRatio` × its score.
 * - Focus not assessable: silent; cleared after `notAssessableToClear` strokes.
 * - No faults: 'good' (spoken only with `speakGood`).
 * - No contact (shadow swing, miss): silent, state unchanged.
 * - The same phrase (and variant) at most `maxRepeats` times in a row, then
 *   `pauseAfterRepeats` silent strokes (silent strokes do not break the run).
 * - Mode: learning adds a sentence to a correction, match says nothing per
 *   stroke (see `matchIdle`).
 */
export function coachStep(
  state: CoachState,
  assessment: StrokeAssessment,
  config: CoachConfig = DEFAULT_COACH_CONFIG,
  /**
   * Whether the utterance can be heard. When false the focus is still
   * tracked for the record, but the ladder, the repeat/pause counters and
   * the once-only "Better" / "That's it" are not spent. Match mode implies false.
   */
  speaking = true,
  context: CoachContext = DEFAULT_COACH_CONTEXT,
): CoachStep {
  const type = assessment.strokeType;
  const own = state.byStroke[type];
  if (!assessment.contact) {
    return {
      state,
      utterance: silent('no-contact'),
      speech: null,
      categories: classifyStroke(assessment, {
        fatigueActive: false,
        focusBefore: own.focus?.correctionId ?? null,
        improved: false,
      }),
    };
  }
  const mode = context.mode;
  const heard = speaking && mode !== 'match';
  const now = context.receivedAt;
  const pairFaults = assessment.faults
    .map((f) => f.correctionId)
    .filter((id, i, all) => PAIRED.has(id) && all.indexOf(id) === i);

  let focus: FocusState | null;
  let utterance: Utterance;
  let improved = false;
  let fatigueSpokenAt = state.fatigueSpokenAt;
  let fatigueSpokenInEpisode = context.fatigueActive ? state.fatigueSpokenInEpisode : false;

  if (context.fatigueActive) {
    // Focus frozen: no new focus, no ladder; the faults are fatigue-related.
    focus = own.focus;
    const due =
      now === null
        ? !fatigueSpokenInEpisode
        : fatigueSpokenAt === null || now - fatigueSpokenAt >= config.fatigueRepeatMs;
    if (heard && due) {
      utterance = { kind: 'fatigue', spoken: feedbackPhrase('fatigue'), reason: 'fatigue' };
      fatigueSpokenAt = now ?? fatigueSpokenAt;
      fatigueSpokenInEpisode = true;
    } else {
      utterance = silent('fatigue-hold', own.focus?.correctionId);
    }
  } else {
    const decided = decide(own.focus, assessment, config, heard);
    improved = decided.improved;
    const pre = decided.focus;
    const decision = decided.decision;
    const subject =
      decision.type === 'cue'
        ? decision.correctionId
        : decision.utterance.kind === 'overcorrected'
          ? (decision.utterance.correctionId ?? null)
          : null;
    // Oscillation between opposites: neither cue, "Same swing every time" now and then.
    const sequence = [
      ...own.recent.slice(-(config.oscillationWindow - 1)).map((r) => r.pairFaults),
      pairFaults,
    ];
    const against = decision.type === 'cue' ? oppositeOf(decision.correctionId) : null;
    if (
      subject !== null &&
      PAIRED.has(subject) &&
      switches(sequence, subject) >= config.oscillationSwitches
    ) {
      const due =
        own.sinceConsistency === null || own.sinceConsistency + 1 >= config.consistencyEvery;
      focus = own.focus ?? pre;
      utterance =
        heard && due
          ? { kind: 'consistency', spoken: feedbackPhrase('consistency'), reason: 'oscillation' }
          : silent('oscillation', subject);
    } else if (decision.type === 'fixed') {
      focus = pre;
      utterance = decision.utterance;
    } else if (
      heard &&
      against !== null &&
      own.recent.slice(-config.contradictionWindow).some((r) => r.cue === against)
    ) {
      // Never contradict a cue spoken in the last strokes of this type.
      focus = pre;
      utterance = {
        kind: 'overcorrected',
        correctionId: decision.correctionId,
        spoken: feedbackPhrase('overcorrected'),
        reason: 'contradiction',
      };
    } else if (pre) {
      const laddered = applyLadder(pre, decision, config, heard);
      focus = laddered.focus;
      utterance = laddered.utterance;
    } else {
      focus = pre;
      utterance = silent('not-assessable');
    }
  }

  let { lastSpoken, repeat } = own;
  if (own.focus !== null && focus === null) {
    // Focus cleared: a returning cue starts fresh, not mid-pause.
    lastSpoken = null;
    repeat = 0;
  }
  if (heard && utterance.spoken !== '') {
    // Ladder variants count as different phrases even when their wording is equal.
    const variant = utterance.kind === 'correction' ? String(utterance.level ?? 0) : '';
    const key = `${utterance.spoken}#${variant}`;
    repeat = key === lastSpoken ? repeat + 1 : 1;
    lastSpoken = key;
    const position = (repeat - 1) % (config.maxRepeats + config.pauseAfterRepeats);
    if (position >= config.maxRepeats) {
      utterance = silent('repeat-pause', utterance.correctionId);
    }
  }

  const spokenNow =
    heard && utterance.kind === 'correction' ? (utterance.correctionId ?? null) : null;
  const sinceConsistency =
    utterance.kind === 'consistency'
      ? 0
      : own.sinceConsistency === null
        ? null
        : own.sinceConsistency + 1;
  const rated = isRated(assessment)
    ? [...own.rated, ratedFaults(assessment)].slice(-config.match.window)
    : own.rated;
  const nextOwn: StrokeTypeCoachState = {
    focus,
    lastSpoken,
    repeat,
    recent: [...own.recent, { cue: spokenNow, pairFaults }].slice(
      -Math.max(config.contradictionWindow, config.oscillationWindow),
    ),
    sinceConsistency,
    rated,
  };

  let match = state.match;
  if (mode === 'match') {
    const major = persistentMajor(rated, config.match);
    if (major !== null) match = { ...match, pending: { correctionId: major, strokeType: type } };
    else if (match.pending?.strokeType === type) match = { ...match, pending: null };
  } else if (match.pending !== null) {
    match = { ...match, pending: null };
  }

  return {
    state: {
      byStroke: { ...state.byStroke, [type]: nextOwn },
      lastStrokeAt: now ?? state.lastStrokeAt,
      fatigueSpokenAt,
      fatigueSpokenInEpisode,
      match,
    },
    utterance,
    speech: heard ? speechFor(utterance, mode) : null,
    categories: classifyStroke(assessment, {
      fatigueActive: context.fatigueActive,
      focusBefore: own.focus?.correctionId ?? null,
      improved,
    }),
  };
}

/**
 * Match mode, called when play may have paused: speaks a pending persistent
 * major fault once at least `quietMs` have passed since the previous stroke
 * and `cooldownMs` since the last such cue. Null when there is nothing to say.
 */
export function matchIdle(
  state: CoachState,
  now: number,
  config: CoachConfig = DEFAULT_COACH_CONFIG,
): { readonly state: CoachState; readonly utterance: Utterance; readonly speech: string } | null {
  const { pending, lastSpokenAt } = state.match;
  if (pending === null || state.lastStrokeAt === null) return null;
  if (now - state.lastStrokeAt < config.match.quietMs) return null;
  if (lastSpokenAt !== null && now - lastSpokenAt < config.match.cooldownMs) return null;
  const utterance = cueUtterance(pending.correctionId, 0, 'persistent-major-fault');
  return {
    state: { ...state, match: { pending: null, lastSpokenAt: now } },
    utterance,
    speech: utterance.spoken,
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

/** Cue variant to store with a stroke: of a correction, or the one that worked for 'better'. */
export function phraseLevelOf(utterance: Utterance): PhraseLevel | null {
  return utterance.kind === 'correction' || utterance.kind === 'better'
    ? (utterance.level ?? null)
    : null;
}

const fix = (id: CorrectionId): Cue => ({ ruleId: id, severity: 'fix', text: spokenCue(id) });

/**
 * The legacy per-stroke `Cue` (session report, statistics, export) for a
 * coached stroke. It records the stroke's verdict, not only what was said:
 * a "Better", a silenced repeat or a frozen focus is still a fix of the focus
 * when the focus is at fault on the stroke.
 */
export function cueForStroke(utterance: Utterance, assessment: StrokeAssessment): Cue {
  if (!assessment.contact) return NOT_RATED_CUE;
  const id = utterance.correctionId;
  if (
    id !== undefined &&
    utterance.kind !== 'keep-it' &&
    assessment.faults.some((f) => f.correctionId === id)
  ) {
    return fix(id);
  }
  if (utterance.kind === 'keep-it') {
    return { ruleId: 'good', severity: 'good', text: feedbackPhrase('keepIt') };
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
