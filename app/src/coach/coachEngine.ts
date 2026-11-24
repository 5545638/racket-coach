import { CORRECTIONS, type CorrectionId } from '../coaching/corrections';
import { NOT_RATED_CUE, NO_READING_CUE } from '../coaching/rules';
import type {
  CoachMode,
  Cue,
  PhraseLevel,
  StrokeCategories,
  StrokeType,
  SwingStyle,
  UtteranceKind,
} from '../domain/types';
import {
  type Band,
  type BandSource,
  type ElementAssessment,
  type StrokeAssessment,
  byCorrection,
} from '../elements/assess';
import { classifyStroke, sigmaTooLarge } from './classify';
import {
  cueVariant,
  feedbackPhrase,
  learningSentence,
  overcorrectedPhrase,
  reinforcePhrase,
  stuckPhrase,
} from './phrases';

/**
 * Live coaching: turns one stroke's assessment into at most one spoken
 * phrase, keeping one focus per stroke type and swing style, with an adaptive phrase ladder,
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
  /**
   * The focus is cleared after this many strokes inside its band with no
   * fault of it in between (uncertain strokes do not count, nor interrupt).
   */
  readonly okStrokesToClear: number;
  /** The reinforce phrase needs this many consecutive strokes with the focus inside its band. */
  readonly inBandToReinforce: number;
  /** A different fault takes over only with a score ≥ this × the focus fault's score. */
  readonly replaceRatio: number;
  /** The focus is cleared after this many consecutive strokes on which it was not assessable. */
  readonly notAssessableToClear: number;
  /** Ladder: spoken corrections of one focus before "Try the drill" / sparse mode (2 × v0, 2 × v1, 1 × v2). */
  readonly ladderLength: number;
  /** Spoken corrections of one focus (never reset while it is the focus) after which it stays sparse. */
  readonly lifetimeLimit: number;
  /** Sparse mode: the focus is spoken about only on every n-th faulty stroke. */
  readonly sparseEvery: number;
  /** "Better" compares with the median of up to this many previous focus distances. */
  readonly betterWindow: number;
  /** "Better" at most once per this many strokes of the lane. */
  readonly betterEvery: number;
  /**
   * The overcorrection phrase instead of a cue whose opposite was the focus
   * replaced at most this many strokes ago (once per episode).
   */
  readonly contradictionWindow: number;
  /** Consecutive opposite faults after which the focus switches when the phrase was not heard. */
  readonly oppositeStreakToSwitch: number;
  /** Oscillation: ≥ `oscillationSwitches` switches between opposites in the last `oscillationWindow` strokes. */
  readonly oscillationWindow: number;
  readonly oscillationSwitches: number;
  /** "Same swing every time" at most once per this many strokes of the lane. */
  readonly consistencyEvery: number;
  /** "Take a short break" not again within this time, ms. */
  readonly fatigueRepeatMs: number;
  /** A fatigue episode freezes coaching for at most this many strokes of the type. */
  readonly fatigueMaxHold: number;
  /** A gap this long between strokes is a break: "Better" references and sparse counters restart. */
  readonly breakMs: number;
  /** Learning mode: the explanation only when the previous gap between strokes was at least this, ms. */
  readonly learningMinGapMs: number;
  readonly match: MatchConfig;
}

/** Match mode: only a persistent major fault, between points. */
export interface MatchConfig {
  /** Rated strokes of the lane looked at. */
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
  inBandToReinforce: 2,
  replaceRatio: 2,
  notAssessableToClear: 5,
  ladderLength: 5,
  lifetimeLimit: 10,
  sparseEvery: 3,
  betterWindow: 5,
  betterEvery: 3,
  contradictionWindow: 5,
  oppositeStreakToSwitch: 3,
  oscillationWindow: 6,
  oscillationSwitches: 3,
  consistencyEvery: 10,
  fatigueRepeatMs: 10 * 60_000,
  fatigueMaxHold: 20,
  breakMs: 3 * 60_000,
  learningMinGapMs: 6_000,
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

/**
 * Soft conflicts: different metrics whose cues can pull against each other
 * ("loosen" vs "steady"; "turn more" / "finish" vs "lower take-back"; "drop
 * the racket" vs "no pause"). A cue of a pair is not started within
 * `contradictionWindow` strokes of the other's cue, unless it already is the focus.
 */
export const SOFT_CONFLICTS: readonly (readonly [CorrectionId, CorrectionId])[] = [
  ['stiff-arm', 'unstable-contact'],
  ['small-turn', 'high-takeback'],
  ['short-finish', 'high-takeback'],
  ['serve-no-drop', 'serve-hitch'],
];

export function softConflictsOf(id: CorrectionId): CorrectionId[] {
  return SOFT_CONFLICTS.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));
}

export type { UtteranceKind } from '../domain/types';

/** Coaching lane: one focus per stroke type and swing style (unknown style = drive). */
export type CoachLane = `${StrokeType}-${SwingStyle}`;

export const COACH_LANES: readonly CoachLane[] = [
  'forehand-drive',
  'forehand-slice',
  'backhand-drive',
  'backhand-slice',
  'overhead-drive',
  'overhead-slice',
];

export const laneOf = (type: StrokeType, style: SwingStyle | null): CoachLane =>
  `${type}-${style ?? 'drive'}`;

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
  | 'soft-conflict'
  | 'oscillation'
  | 'fatigue'
  | 'fatigue-hold'
  | 'persistent-major-fault';

/** One previous fault distance of the focus element. */
export interface DistanceSample {
  readonly distance: number;
  readonly sigma: number;
}

export interface FocusState {
  readonly correctionId: CorrectionId;
  /**
   * d and σ of the focus on its previous faulty strokes, newest last (at most
   * `betterWindow`); all of one element under one band.
   */
  readonly distances: readonly DistanceSample[];
  /**
   * Element (catalogue key) whose d and σ those are. One correction can have
   * several elements in different units, so "Better" compares like with like.
   */
  readonly lastKey: string | null;
  /** Where the band of those strokes came from, and its bounds: d is only comparable within one band. */
  readonly lastBandSource: BandSource | null;
  readonly lastBand: Band | null;
  /** Score of the focus when it last was a fault (the bar for a replacement). */
  readonly faultScore: number;
  /** Strokes inside the band since the focus was last at fault (uncertain ones skipped). */
  readonly okStreak: number;
  /** Consecutive strokes with the focus inside its band (d = 0, not uncertain). */
  readonly inBandStreak: number;
  readonly notAssessableStreak: number;
  /** The reinforce phrase has been said (heard) for the current ok run. */
  readonly thatsItSaid: boolean;
  /** Lane stroke number of the last heard "Better" (null = none yet). */
  readonly betterAt: number | null;
  /* Phrase ladder (heard corrections only). */
  /** Corrections spoken since the ladder was last reset (only the reinforce phrase resets it). */
  readonly spokenCount: number;
  /** Corrections spoken while this is the focus; never reset. */
  readonly lifetimeSpoken: number;
  /** Variant the ladder starts from: the one that last worked (or the profile's best). */
  readonly baseLevel: PhraseLevel;
  /** Variant of the last correction actually heard; null = the cue was never heard. */
  readonly lastHeardLevel: PhraseLevel | null;
  /** The reinforce phrase was heard for this focus. */
  readonly hadSuccess: boolean;
  readonly stuckSaid: boolean;
  /** Faulty strokes since the ladder ran out. */
  readonly sparseCount: number;
  /** Consecutive strokes with the opposite fault. */
  readonly oppositeStreak: number;
  /** The overcorrection phrase was heard for this focus (once per episode). */
  readonly overcorrectedSaid: boolean;
}

/** One previous stroke of a lane, for contradiction and oscillation checks. */
export interface RecentStroke {
  /** Correction whose cue was spoken (heard) on the stroke. */
  readonly cue: CorrectionId | null;
  /** Faults of correction pairs (see OPPOSITES) on the stroke. */
  readonly pairFaults: readonly CorrectionId[];
}

/** A focus that another correction replaced (not one that was fixed and cleared). */
export interface ReplacedFocus {
  readonly correctionId: CorrectionId;
  /** Lane stroke number of the replacement. */
  readonly at: number;
  /** The overcorrection phrase of this episode was heard. */
  readonly overcorrectedSaid: boolean;
}

/** Faults of one rated stroke, for match mode. */
export interface RatedFault {
  readonly correctionId: CorrectionId;
  readonly probability: number;
  readonly weight: number;
}

export interface LaneCoachState {
  readonly focus: FocusState | null;
  /** Last non-empty phrase considered for speaking, and how many strokes in a row it was. */
  readonly lastSpoken: string | null;
  readonly repeat: number;
  /** Previous strokes of this lane, newest last (at most 6). */
  readonly recent: readonly RecentStroke[];
  /** Strokes of this lane since "Same swing every time" (null = not said yet). */
  readonly sinceConsistency: number | null;
  /** Faults of the last rated strokes of this lane, newest last (match window). */
  readonly rated: readonly (readonly RatedFault[])[];
  /** Strokes with contact in this lane (numbers the strokes). */
  readonly strokes: number;
  readonly replaced: ReplacedFocus | null;
}

/** Former name of {@link LaneCoachState}. */
export type StrokeTypeCoachState = LaneCoachState;

export interface MatchState {
  /** A persistent major fault waiting for a break in play. */
  readonly pending: { readonly correctionId: CorrectionId; readonly strokeType: StrokeType } | null;
  readonly lastSpokenAt: number | null;
}

/** Fatigue hold of one stroke type. */
export interface FatigueHold {
  /** Strokes frozen in the current episode. */
  readonly held: number;
  /** The previous stroke of the type was frozen. */
  readonly frozen: boolean;
}

export interface CoachState {
  readonly byLane: Readonly<Record<CoachLane, LaneCoachState>>;
  /** `capture.receivedAt` of the previous stroke with contact, ms. */
  readonly lastStrokeAt: number | null;
  /** When "Take a short break" was last said, ms. */
  readonly fatigueSpokenAt: number | null;
  /** Said in the current fatigue episode (used when no time is known). */
  readonly fatigueSpokenInEpisode: boolean;
  readonly fatigueHold: Readonly<Record<StrokeType, FatigueHold>>;
  /** Corrections whose learning sentence was said in this session. */
  readonly learningSaid: readonly CorrectionId[];
  readonly match: MatchState;
}

const IDLE: LaneCoachState = {
  focus: null,
  lastSpoken: null,
  repeat: 0,
  recent: [],
  sinceConsistency: null,
  rated: [],
  strokes: 0,
  replaced: null,
};

const NO_HOLD: FatigueHold = { held: 0, frozen: false };

export const INITIAL_COACH_STATE: CoachState = {
  byLane: {
    'forehand-drive': IDLE,
    'forehand-slice': IDLE,
    'backhand-drive': IDLE,
    'backhand-slice': IDLE,
    'overhead-drive': IDLE,
    'overhead-slice': IDLE,
  },
  lastStrokeAt: null,
  fatigueSpokenAt: null,
  fatigueSpokenInEpisode: false,
  fatigueHold: { forehand: NO_HOLD, backhand: NO_HOLD, overhead: NO_HOLD },
  learningSaid: [],
  match: { pending: null, lastSpokenAt: null },
};

/** What the controller knows besides the assessment. */
export interface CoachContext {
  readonly mode: CoachMode;
  /** `capture.receivedAt` of the stroke, ms; null when unknown. */
  readonly receivedAt: number | null;
  /** The fatigue detector is active for this stroke's type (coach/fatigue.ts). */
  readonly fatigueActive: boolean;
  /** Per correction, the cue variant that earned the most "Better"s (profile); a new focus starts there. */
  readonly preferredLevels?: Readonly<Partial<Record<CorrectionId, PhraseLevel>>>;
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

const betterUtterance = (id: CorrectionId, level: PhraseLevel): Utterance => ({
  kind: 'better',
  correctionId: id,
  spoken: feedbackPhrase('better'),
  reason: 'improved',
  level,
});

const sample = (e: ElementAssessment): DistanceSample[] =>
  e.sigma === null ? [] : [{ distance: e.distance, sigma: e.sigma }];

const newFocus = (e: ElementAssessment, baseLevel: PhraseLevel = 0): FocusState => ({
  correctionId: e.correctionId,
  distances: sample(e),
  lastKey: e.key,
  lastBandSource: e.bandSource,
  lastBand: e.band,
  faultScore: e.score,
  okStreak: 0,
  inBandStreak: 0,
  notAssessableStreak: 0,
  thatsItSaid: false,
  betterAt: null,
  spokenCount: 0,
  lifetimeSpoken: 0,
  baseLevel,
  lastHeardLevel: null,
  hadSuccess: false,
  stuckSaid: false,
  sparseCount: 0,
  oppositeStreak: 0,
  overcorrectedSaid: false,
});

const sameBand = (a: Band | null, b: Band | null): boolean =>
  a === null || b === null ? a === b : a.lo === b.lo && a.hi === b.hi;

const levelOf = (n: number): PhraseLevel => (((n % 3) + 3) % 3) as PhraseLevel;

const medianOf = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** Inside the band for sure: d = 0 and σ small enough to tell it from a fault (not 'uncertain'). */
export const inBand = (e: ElementAssessment): boolean =>
  e.status === 'ok' && e.distance === 0 && !sigmaTooLarge(e);

/** Variant of the n-th (1-based) spoken correction: n 1–2 → base, 3–4 → base + 1, 5 → base + 2. */
export function ladderLevel(n: number, base: PhraseLevel): PhraseLevel {
  if (n <= 2) return base;
  if (n <= 4) return levelOf(base + 1);
  return levelOf(base + 2);
}

/** Ladder reset after the reinforce phrase: start again from the variant that worked. */
const succeeded = (f: FocusState): FocusState => ({
  ...f,
  spokenCount: 0,
  baseLevel: f.lastHeardLevel ?? f.baseLevel,
  hadSuccess: true,
  stuckSaid: false,
  sparseCount: 0,
  distances: [],
});

/** After a break or a fatigue episode: fresh "Better" reference and sparse counter. */
const refreshed = (lane: LaneCoachState): LaneCoachState =>
  lane.focus === null ? lane : { ...lane, focus: { ...lane.focus, distances: [], sparseCount: 0 } };

/** A cue or a "Better" the ladder still has to turn into a phrase. */
interface CueDecision {
  readonly type: 'cue' | 'better';
  readonly correctionId: CorrectionId;
  readonly reason: 'new-focus' | 'focus-replaced' | 'focus-persists' | 'improved';
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
  /** The focus another correction replaced on this stroke. */
  readonly replaced?: Omit<ReplacedFocus, 'at'>;
  /** The focus was cleared (fixed, or not assessable for too long). */
  readonly cleared?: boolean;
}

interface DecideEnv {
  /** Lane stroke number of this stroke. */
  readonly n: number;
  /** Corrections that may not become the focus now (soft conflicts). */
  readonly blocked: ReadonlySet<CorrectionId>;
  readonly preferred: Readonly<Partial<Record<CorrectionId, PhraseLevel>>>;
}

const fixed = (utterance: Utterance): FixedDecision => ({ type: 'fixed', utterance });

/** Picks the focus and what to say, before ladder, contradiction and repeat limits. */
function decide(
  focus: FocusState | null,
  assessment: StrokeAssessment,
  config: CoachConfig,
  heard: boolean,
  env: DecideEnv,
): Decided {
  const verdicts = byCorrection(assessment);
  const faults = assessment.faults.filter(
    (f) => !env.blocked.has(f.correctionId) || f.correctionId === focus?.correctionId,
  );
  const anyOk = assessment.elements.some((e) => e.status === 'ok');
  const good = (): FixedDecision =>
    fixed({ kind: 'good', spoken: config.speakGood ? GOOD_PHRASE : '', reason: 'no-faults' });
  const start = (e: ElementAssessment): FocusState =>
    newFocus(e, env.preferred[e.correctionId] ?? 0);

  const noFocus = (): Decided => {
    const top = faults[0];
    if (top) {
      return {
        focus: start(top),
        decision: { type: 'cue', correctionId: top.correctionId, reason: 'new-focus' },
        improved: false,
      };
    }
    const held = assessment.faults[0];
    if (held) {
      // Only soft-conflicting faults: none of them is started now.
      return {
        focus: null,
        decision: fixed(silent('soft-conflict', held.correctionId)),
        improved: false,
      };
    }
    if (anyOk) return { focus: null, decision: good(), improved: false };
    return { focus: null, decision: fixed(silent('not-assessable')), improved: false };
  };

  if (focus === null) return noFocus();

  const current = verdicts.get(focus.correctionId) ?? null;

  // Overcorrection: the focus' opposite is at fault. The phrase once per
  // episode, then the opposite's own cue.
  const opposite = oppositeOf(focus.correctionId);
  const oppositeVerdict = opposite === null ? null : (verdicts.get(opposite) ?? null);
  if (oppositeVerdict?.status === 'fault') {
    const streak = focus.oppositeStreak + 1;
    if (focus.overcorrectedSaid || streak >= config.oppositeStreakToSwitch) {
      return {
        focus: start(oppositeVerdict),
        decision: {
          type: 'cue',
          correctionId: oppositeVerdict.correctionId,
          reason: 'focus-replaced',
        },
        improved: false,
        replaced: { correctionId: focus.correctionId, overcorrectedSaid: focus.overcorrectedSaid },
      };
    }
    return {
      focus: { ...focus, oppositeStreak: streak, notAssessableStreak: 0, inBandStreak: 0 },
      decision: fixed({
        kind: 'overcorrected',
        correctionId: focus.correctionId,
        spoken: overcorrectedPhrase(oppositeVerdict.correctionId),
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
      focus: start(challenger),
      decision: { type: 'cue', correctionId: challenger.correctionId, reason: 'focus-replaced' },
      improved: false,
      replaced: { correctionId: base.correctionId, overcorrectedSaid: false },
    };
  }

  if (current === null || current.status === 'not-assessable') {
    const streak = base.notAssessableStreak + 1;
    if (streak >= config.notAssessableToClear) return { ...noFocus(), cleared: true };
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
    const window = comparable ? base.distances : [];
    // "Better": clearly better than the median of the previous faulty strokes,
    // not just than the previous one (a noisy player would hear it constantly).
    const improved =
      window.length > 0 &&
      current.sigma !== null &&
      medianOf(window.map((x) => x.distance)) - current.distance >=
        Math.hypot(medianOf(window.map((x) => x.sigma)), current.sigma);
    // An unheard improvement (match) is not spent: the reference stays, so "Better" can still be said.
    const keepReference = improved && !heard;
    const next: FocusState = {
      ...base,
      distances: keepReference
        ? window
        : [...window, ...sample(current)].slice(-config.betterWindow),
      lastKey: keepReference ? base.lastKey : current.key,
      lastBandSource: keepReference ? base.lastBandSource : current.bandSource,
      lastBand: keepReference ? base.lastBand : current.band,
      faultScore: current.score,
      okStreak: 0,
      inBandStreak: 0,
      notAssessableStreak: 0,
      thatsItSaid: false,
    };
    const due = base.betterAt === null || env.n - base.betterAt >= config.betterEvery;
    // Only a cue that was heard can get better.
    if (improved && due && base.lastHeardLevel !== null) {
      return {
        focus: next,
        decision: { type: 'better', correctionId: base.correctionId, reason: 'improved' },
        improved: true,
      };
    }
    return {
      focus: next,
      decision: { type: 'cue', correctionId: base.correctionId, reason: 'focus-persists' },
      improved,
    };
  }

  // The focus fault is gone on this stroke: inside the band, or uncertain
  // (outside but not surely, or σ too large). An uncertain stroke is no
  // evidence of a fix: it neither counts towards clearing nor towards praise.
  const fixedNow = inBand(current);
  const okStreak = fixedNow ? base.okStreak + 1 : base.okStreak;
  if (okStreak >= config.okStrokesToClear) return { ...noFocus(), cleared: true };
  const inBandStreak = fixedNow ? base.inBandStreak + 1 : 0;
  const next: FocusState = { ...base, okStreak, inBandStreak, notAssessableStreak: 0 };
  // Praise only what is really fixed (inside the band twice in a row), once
  // per ok run, and only for a cue that was heard.
  if (
    heard &&
    inBandStreak >= config.inBandToReinforce &&
    !base.thatsItSaid &&
    base.lastHeardLevel !== null
  ) {
    return {
      focus: succeeded({ ...next, thatsItSaid: true }),
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

/**
 * Turns a cue or "Better" decision into a phrase on the ladder; advances
 * the ladder only when heard. Once the ladder has run out (or the focus has
 * used up its lifetime count) the focus is in sparse mode: "Try the drill"
 * once, then only every `sparseEvery`-th faulty stroke says anything.
 */
function applyLadder(
  focus: FocusState,
  decision: CueDecision,
  config: CoachConfig,
  heard: boolean,
  n: number,
): { readonly focus: FocusState; readonly utterance: Utterance } {
  const id = decision.correctionId;
  const better = decision.type === 'better';
  const worked = focus.lastHeardLevel ?? focus.baseLevel;
  if (!heard) {
    if (better) return { focus, utterance: betterUtterance(id, worked) };
    const level = ladderLevel(
      Math.min(focus.spokenCount + 1, config.ladderLength),
      focus.baseLevel,
    );
    return { focus, utterance: cueUtterance(id, level, decision.reason) };
  }
  const sparse =
    focus.spokenCount >= config.ladderLength || focus.lifetimeSpoken >= config.lifetimeLimit;
  if (!sparse) {
    if (better) return { focus: { ...focus, betterAt: n }, utterance: betterUtterance(id, worked) };
    const count = focus.spokenCount + 1;
    const level = ladderLevel(count, focus.baseLevel);
    return {
      focus: {
        ...focus,
        spokenCount: count,
        lifetimeSpoken: focus.lifetimeSpoken + 1,
        lastHeardLevel: level,
      },
      utterance: cueUtterance(id, level, decision.reason),
    };
  }
  if (!better && !focus.hadSuccess && !focus.stuckSaid) {
    return {
      focus: { ...focus, stuckSaid: true },
      utterance: { kind: 'stuck', correctionId: id, spoken: stuckPhrase(id), reason: 'stuck' },
    };
  }
  const sparseCount = focus.sparseCount + 1;
  if (sparseCount % config.sparseEvery !== 0) {
    return { focus: { ...focus, sparseCount }, utterance: silent('ladder-sparse', id) };
  }
  if (better) {
    return {
      focus: { ...focus, sparseCount, betterAt: n },
      utterance: betterUtterance(id, worked),
    };
  }
  // Every n-th faulty stroke: the variants in turn, starting from the one that worked.
  const level = levelOf(focus.baseLevel + sparseCount / config.sparseEvery - 1);
  return {
    focus: {
      ...focus,
      sparseCount,
      lifetimeSpoken: focus.lifetimeSpoken + 1,
      lastHeardLevel: level,
    },
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

const mapLanes = (
  byLane: Readonly<Record<CoachLane, LaneCoachState>>,
  f: (lane: LaneCoachState, key: CoachLane) => LaneCoachState,
): Record<CoachLane, LaneCoachState> => {
  const out = { ...byLane };
  for (const key of COACH_LANES) out[key] = f(byLane[key], key);
  return out;
};

/**
 * Forgets every focus, ladder and recent cue (all lanes), e.g. when the
 * coaching mode changes: a cue heard in one mode is not built on in another.
 * Stroke counters, the match window and the session's learning sentences stay.
 */
export function withoutFocus(state: CoachState): CoachState {
  return {
    ...state,
    byLane: mapLanes(state.byLane, (lane) => ({
      ...IDLE,
      rated: lane.rated,
      strokes: lane.strokes,
    })),
  };
}

/**
 * One coaching step for one stroke.
 *
 * - One focus per lane (stroke type × swing style). Without a focus the
 *   highest-scoring fault becomes the focus and is spoken.
 * - Focus still at fault: "Better" when it improved by at least the combined
 *   σ on the median of up to 5 previous focus distances
 *   (median(d) − d_now ≥ √(median(σ)² + σ_now²)), at most once per 3 strokes
 *   and only for a cue that was heard; else its cue, on the phrase ladder
 *   (v0, v0, v1, v1, v2, then "Try the … drill" once, then only every 3rd
 *   faulty stroke). "Better" does not reset the ladder.
 * - Focus inside its band on 2 strokes in a row (not uncertain): its
 *   reinforce phrase, once per ok run and only for a heard cue; this resets
 *   the ladder to the variant that worked. Cleared after `okStrokesToClear`
 *   strokes in a row without its fault. After 10 spoken cues of one focus it
 *   stays sparse even after a reset.
 * - The focus' opposite at fault: the specific overcorrection phrase ("Now
 *   too closed") once per episode, then the focus switches and the opposite's
 *   own cue is said. A cue whose opposite was the focus replaced ≤ 5 strokes
 *   ago gets the phrase instead, once per episode; a focus that was fixed and
 *   cleared does not block its opposite.
 * - Soft conflicts (SOFT_CONFLICTS): no new focus whose partner was spoken in
 *   the last 5 strokes of the lane.
 * - Opposite faults alternating ≥ 3 times in 6 strokes: "Same swing every
 *   time" (once per 10 strokes) instead of either cue.
 * - Fatigue active: focus frozen for at most `fatigueMaxHold` strokes of the
 *   type, "Take a short break" once (not again for 10 min); then normal
 *   coaching even while still flagged.
 * - After a break (≥ 3 min) or a fatigue hold: "Better" references and
 *   sparse counters restart.
 * - A different fault replaces the focus only with ≥ `replaceRatio` × its score.
 * - Focus not assessable: silent; cleared after `notAssessableToClear` strokes.
 * - No faults: 'good' (spoken only with `speakGood`).
 * - No contact (shadow swing, miss): silent, state unchanged.
 * - The same phrase (and variant) at most `maxRepeats` times in a row, then
 *   `pauseAfterRepeats` silent strokes (silent strokes do not break the run).
 * - Mode: learning adds a sentence to the first cue of a focus (once per
 *   correction per session, only after a gap of ≥ 6 s); match says nothing
 *   per stroke (see `matchIdle`).
 */
export function coachStep(
  state: CoachState,
  assessment: StrokeAssessment,
  config: CoachConfig = DEFAULT_COACH_CONFIG,
  /**
   * Whether the utterance can be heard. When false the focus is still
   * tracked for the record, but the ladder, the repeat/pause counters and
   * the once-only "Better" / reinforce phrase are not spent. Match mode implies false.
   */
  speaking = true,
  context: CoachContext = DEFAULT_COACH_CONTEXT,
): CoachStep {
  const type = assessment.strokeType;
  const laneKey = laneOf(type, assessment.swingStyle);
  if (!assessment.contact) {
    return {
      state,
      utterance: silent('no-contact'),
      speech: null,
      categories: classifyStroke(assessment, {
        fatigueActive: false,
        focusBefore: state.byLane[laneKey].focus?.correctionId ?? null,
        improved: false,
      }),
    };
  }
  const mode = context.mode;
  const heard = speaking && mode !== 'match';
  const now = context.receivedAt;
  const gap = now !== null && state.lastStrokeAt !== null ? now - state.lastStrokeAt : null;

  // Fatigue hold: at most `fatigueMaxHold` frozen strokes per episode.
  const hold = state.fatigueHold[type];
  const frozen = context.fatigueActive && hold.held < config.fatigueMaxHold;
  const nextHold: FatigueHold = {
    held: context.fatigueActive ? hold.held + (frozen ? 1 : 0) : 0,
    frozen,
  };

  // A break, or the end of a fatigue hold: the old references do not apply.
  let byLane: Readonly<Record<CoachLane, LaneCoachState>> = state.byLane;
  if (gap !== null && gap >= config.breakMs) byLane = mapLanes(byLane, refreshed);
  else if (hold.frozen && !frozen) {
    byLane = mapLanes(byLane, (lane, key) => (key.startsWith(`${type}-`) ? refreshed(lane) : lane));
  }
  const own = byLane[laneKey];
  const n = own.strokes + 1;
  const pairFaults = assessment.faults
    .map((f) => f.correctionId)
    .filter((id, i, all) => PAIRED.has(id) && all.indexOf(id) === i);

  let focus: FocusState | null;
  let utterance: Utterance;
  let improved = false;
  let replaced = own.replaced;
  let fatigueSpokenAt = state.fatigueSpokenAt;
  let fatigueSpokenInEpisode = context.fatigueActive ? state.fatigueSpokenInEpisode : false;

  if (frozen) {
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
    const recentCues = own.recent.slice(-config.contradictionWindow).map((r) => r.cue);
    const blocked = new Set(
      recentCues
        .filter((c): c is CorrectionId => c !== null)
        .flatMap(softConflictsOf)
        .filter((id) => id !== own.focus?.correctionId),
    );
    const decided = decide(own.focus, assessment, config, heard, {
      n,
      blocked,
      preferred: context.preferredLevels ?? {},
    });
    improved = decided.improved;
    if (decided.replaced) replaced = { ...decided.replaced, at: n };
    else if (decided.cleared) replaced = null;
    const pre = decided.focus;
    const decision = decided.decision;
    const subject =
      decision.type !== 'fixed'
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
      // decide()'s bookkeeping (opposite streak, distances, switch) still applies.
      focus = pre;
      utterance =
        heard && due
          ? { kind: 'consistency', spoken: feedbackPhrase('consistency'), reason: 'oscillation' }
          : silent('oscillation', subject);
    } else if (decision.type === 'fixed') {
      focus = pre;
      utterance = decision.utterance;
    } else if (
      heard &&
      decision.type === 'cue' &&
      against !== null &&
      replaced !== null &&
      replaced.correctionId === against &&
      n - replaced.at <= config.contradictionWindow &&
      !replaced.overcorrectedSaid
    ) {
      // The opposite was the focus a moment ago: say so once, the cue next time.
      focus = pre;
      utterance = {
        kind: 'overcorrected',
        correctionId: decision.correctionId,
        spoken: overcorrectedPhrase(decision.correctionId),
        reason: 'contradiction',
      };
    } else if (pre) {
      const laddered = applyLadder(pre, decision, config, heard, n);
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

  // The overcorrection phrase is said once per episode.
  if (heard && utterance.kind === 'overcorrected') {
    if (utterance.reason === 'overcorrected' && focus !== null) {
      focus = { ...focus, overcorrectedSaid: true };
    } else if (utterance.reason === 'contradiction' && replaced !== null) {
      replaced = { ...replaced, overcorrectedSaid: true };
    }
  }

  // Learning mode: the explanation with the first cue of a focus, once per
  // correction per session, and only when the player leaves time for it.
  let speech = heard && utterance.spoken !== '' ? utterance.spoken : null;
  let learningSaid = state.learningSaid;
  const cueId = utterance.kind === 'correction' ? (utterance.correctionId ?? null) : null;
  if (
    speech !== null &&
    mode === 'learning' &&
    cueId !== null &&
    focus?.correctionId === cueId &&
    focus.lifetimeSpoken === 1 &&
    !learningSaid.includes(cueId) &&
    (gap === null || gap >= config.learningMinGapMs)
  ) {
    speech = `${speech}. ${learningSentence(cueId)}`;
    learningSaid = [...learningSaid, cueId];
  }

  const spokenNow = heard && cueId !== null ? cueId : null;
  const sinceConsistency =
    utterance.kind === 'consistency'
      ? 0
      : own.sinceConsistency === null
        ? null
        : own.sinceConsistency + 1;
  const rated = isRated(assessment)
    ? [...own.rated, ratedFaults(assessment)].slice(-config.match.window)
    : own.rated;
  const nextOwn: LaneCoachState = {
    focus,
    lastSpoken,
    repeat,
    recent: [...own.recent, { cue: spokenNow, pairFaults }].slice(
      -Math.max(config.contradictionWindow, config.oscillationWindow),
    ),
    sinceConsistency,
    rated,
    strokes: n,
    replaced,
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
      byLane: { ...byLane, [laneKey]: nextOwn },
      lastStrokeAt: now ?? state.lastStrokeAt,
      fatigueSpokenAt,
      fatigueSpokenInEpisode,
      fatigueHold: { ...state.fatigueHold, [type]: nextHold },
      learningSaid,
      match,
    },
    utterance,
    speech,
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

/** The current focus of the lane of a stroke type and swing style (unknown style = drive). */
export const focusOf = (
  state: CoachState,
  type: StrokeType,
  style: SwingStyle | null,
): CorrectionId | null => state.byLane[laneOf(type, style)].focus?.correctionId ?? null;

/** The current focus per stroke type, for display: the drive lane's, else the slice lane's. */
export function focusByStroke(
  state: CoachState,
): Readonly<Record<StrokeType, CorrectionId | null>> {
  const of = (type: StrokeType) => focusOf(state, type, 'drive') ?? focusOf(state, type, 'slice');
  return { forehand: of('forehand'), backhand: of('backhand'), overhead: of('overhead') };
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
