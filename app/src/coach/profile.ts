import { CORRECTIONS, type CorrectionId } from '../coaching/corrections';
import type {
  DominantHand,
  ForehandStyle,
  PlayerInputs,
  PlayerLevel,
  SessionInfo,
  StrokeMetrics,
  StrokeRecord,
  StrokeType,
} from '../domain/types';
import { type AssessConfig, DEFAULT_ASSESS_CONFIG } from '../elements/assess';
import { ELEMENT_CATALOG, type ElementSpec, applicability } from '../elements/catalog';
import { median } from '../math/stats';
import { type PersonalBaseline, contribution } from './baseline';
import { weaknessLabel } from './phrases';

/**
 * Player profile (docs/metrics.md, "Adaptive coach"): what the player says
 * about themselves (inputs, kept in Settings) and what their stroke history
 * shows (typical swing, weaknesses, progress). Pure functions.
 */

export const DEFAULT_PLAYER_INPUTS: PlayerInputs = {
  dominantHand: 'right',
  backhand: 'two-handed',
  forehandStyle: 'mixed',
  level: 'intermediate',
};

/* ------------------------------------------------------------ inputs */

/**
 * Which elements are coached and how sure a fault must be, per level.
 * Beginners get only the fundamental cues (weight ≥ 0.8: face, path, contact
 * stability, acceleration timing, hitch) and only surer faults (pMin 0.85).
 * Intermediate and advanced players get every element at pMin 0.8 (the
 * behaviour before the profile existed). Engineering choices.
 */
export const LEVEL_POLICY: Readonly<
  Record<PlayerLevel, { readonly minWeight: number; readonly pMin: number }>
> = {
  beginner: { minWeight: 0.8, pMin: 0.85 },
  intermediate: { minWeight: 0, pMin: 0.8 },
  advanced: { minWeight: 0, pMin: 0.8 },
};

/**
 * Swing-path population limits per forehand style. Flat hitters
 * legitimately swing flatter, topspin hitters steeper: for the relaxed side
 * the limit moves (path-flat 12° → 5°, path-steep 55° → 65°; engineering
 * choices) and the personal band may not tighten it (`populationOnly`), so a
 * flatter-than-usual drive of a flat hitter is not a fault. `mixed` keeps
 * the literature limits and the personal band.
 */
export const STYLE_PATH_LIMITS = { flatMinDeg: 5, topspinMaxDeg: 65 } as const;

/**
 * Expected sign of the serve's roll about the racket long axis (+x, handle
 * → tip) after contact. Convention from the simulator (simulation/
 * swingModel.ts): the right-handed serve pronates with a positive roll rate
 * (GOOD serve: +20 rad/s, `rollAngleDeg` > 0). A left-handed serve is the
 * mirror image: mirroring flips the long-axis component of the angular
 * velocity (a pseudo-vector), while re-calibrating on the other face only
 * rotates the racket frame by 180° about x, which keeps it. Hence −1. To be
 * confirmed on the real sensor (docs/bring-up.md).
 */
export const SERVE_ROLL_SIGN: Readonly<Record<DominantHand, 1 | -1>> = { right: 1, left: -1 };

/** Pronation of a serve for the player's hand: a roll in the wrong direction counts as none. */
export function servePronationDeg(m: StrokeMetrics, hand: DominantHand): number | null {
  const angle = m.features?.serve?.rollAngleDeg;
  if (angle === null || angle === undefined) return null;
  return Math.max(0, SERVE_ROLL_SIGN[hand] * angle);
}

function adjustForStyle(spec: ElementSpec, style: ForehandStyle): ElementSpec {
  if (style === 'flat' && spec.key === 'path-flat') {
    return { ...spec, populationLimit: STYLE_PATH_LIMITS.flatMinDeg, populationOnly: true };
  }
  if (style === 'topspin' && spec.key === 'path-steep') {
    return { ...spec, populationLimit: STYLE_PATH_LIMITS.topspinMaxDeg, populationOnly: true };
  }
  return spec;
}

/**
 * The catalogue adjusted to the player (all elements): serve roll read for
 * the dominant hand, swing-path limits for the forehand style.
 */
export function profileCatalog(
  inputs: PlayerInputs,
  base: readonly ElementSpec[] = ELEMENT_CATALOG,
): ElementSpec[] {
  return base.map((spec) => {
    if (spec.key === 'serve-no-pronation') {
      return { ...spec, value: (m: StrokeMetrics) => servePronationDeg(m, inputs.dominantHand) };
    }
    return adjustForStyle(spec, inputs.forehandStyle);
  });
}

/** How the player's strokes are assessed and coached. */
export interface CoachingPolicy {
  readonly inputs: PlayerInputs;
  readonly assess: AssessConfig;
  /** Every element, profile-adjusted: the personal baseline and the profile history use it. */
  readonly baselineCatalog: readonly ElementSpec[];
  /** The elements coached at the player's level (assessment). */
  readonly catalog: readonly ElementSpec[];
}

export function coachingPolicy(inputs: PlayerInputs = DEFAULT_PLAYER_INPUTS): CoachingPolicy {
  const level = LEVEL_POLICY[inputs.level];
  const baselineCatalog = profileCatalog(inputs);
  return {
    inputs,
    assess: { ...DEFAULT_ASSESS_CONFIG, pMin: level.pMin },
    baselineCatalog,
    catalog: baselineCatalog.filter((spec) => spec.weight >= level.minWeight),
  };
}

/* ------------------------------------------------------------ history */

export interface ProfileConfig {
  /** Rated strokes (all types) the weaknesses are computed over. */
  readonly window: number;
  /** A weakness: fault rate ≥ this… */
  readonly weaknessMinRate: number;
  /** …with faults in at least this many sessions… */
  readonly weaknessMinSessions: number;
  /** …and at least this many strokes on which the correction was judged. */
  readonly weaknessMinAssessed: number;
  /** Trend: latest session rate vs the mean of up to 3 earlier ones, ± this. */
  readonly trendDelta: number;
  /** Sessions count for the trend with at least this many judged strokes. */
  readonly trendMinStrokes: number;
  /** Values per stroke type and metric kept for the typical swing. */
  readonly typicalWindow: number;
}

export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  window: 200,
  weaknessMinRate: 0.2,
  weaknessMinSessions: 2,
  weaknessMinAssessed: 10,
  trendDelta: 0.1,
  trendMinStrokes: 5,
  typicalWindow: 200,
};

export const TYPICAL_METRICS = [
  'headSpeedMps',
  'swingPathDeg',
  'faceTiltDeg',
  'brushAngleDeg',
  'forwardSwingMs',
  'takebackTurnDeg',
  'followThroughArcDeg',
] as const;
export type TypicalMetric = (typeof TYPICAL_METRICS)[number];

const typicalValue = (m: StrokeMetrics, key: TypicalMetric): number | null => {
  switch (key) {
    case 'headSpeedMps':
      return m.headSpeedMps;
    case 'swingPathDeg':
      return m.swingPathDeg;
    case 'faceTiltDeg':
      return m.faceTiltDeg;
    case 'brushAngleDeg':
      return m.features?.brushAngleDeg ?? null;
    case 'forwardSwingMs':
      return m.features?.forwardSwingMs ?? null;
    case 'takebackTurnDeg':
      return m.features?.takebackTurnDeg ?? null;
    case 'followThroughArcDeg':
      return m.followThroughArcDeg;
  }
};

/** Medians of the player's usual swing, per stroke type (null = no value yet). */
export type TypicalSwing = { readonly n: number } & Readonly<Record<TypicalMetric, number | null>>;

/** What the profile keeps of one rated stroke. */
interface StrokeDigest {
  readonly sessionId: string;
  /** Corrections judged on the stroke (ok or fault). */
  readonly assessed: readonly CorrectionId[];
  /** Corrections at fault (technical errors; fatigue-related faults are left out). */
  readonly faults: readonly CorrectionId[];
}

interface Rate {
  readonly assessed: number;
  readonly faults: number;
}

interface ElementAcc {
  /** Strokes with a value. */
  readonly n: number;
  /** Strokes on which the element was judged (category known), and its faults. */
  readonly judged: number;
  readonly faults: number;
  readonly values: readonly number[];
}

interface SessionAcc {
  readonly sessionId: string;
  readonly firstAt: number;
  readonly rated: number;
  readonly corrections: Readonly<Partial<Record<CorrectionId, Rate>>>;
  readonly elements: Readonly<Record<string, ElementAcc>>;
}

type TypicalValues = Readonly<Record<TypicalMetric, readonly number[]>>;

const emptyTypical = (): TypicalValues => ({
  headSpeedMps: [],
  swingPathDeg: [],
  faceTiltDeg: [],
  brushAngleDeg: [],
  forwardSwingMs: [],
  takebackTurnDeg: [],
  followThroughArcDeg: [],
});

export type LevelCounts = readonly [number, number, number];

/** Incremental history state; build with `buildProfileState`, grow with `addStrokeToProfile`. */
export interface ProfileState {
  /** Last `window` rated strokes, oldest first. */
  readonly window: readonly StrokeDigest[];
  readonly sessions: Readonly<Record<string, SessionAcc>>;
  readonly sessionInfo: Readonly<Record<string, SessionInfo>>;
  readonly typical: Readonly<Record<StrokeType, TypicalValues>>;
  readonly typicalCounts: Readonly<Record<StrokeType, number>>;
  /** "Better"s per correction and cue variant that earned them. */
  readonly betterByLevel: Readonly<Partial<Record<CorrectionId, LevelCounts>>>;
}

export const EMPTY_PROFILE_STATE: ProfileState = {
  window: [],
  sessions: {},
  sessionInfo: {},
  typical: { forehand: emptyTypical(), backhand: emptyTypical(), overhead: emptyTypical() },
  typicalCounts: { forehand: 0, backhand: 0, overhead: 0 },
  betterByLevel: {},
};

export const isCorrectionId = (id: string): id is CorrectionId =>
  Object.prototype.hasOwnProperty.call(CORRECTIONS.en, id);

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

function specsByKey(catalog: readonly ElementSpec[]): ReadonlyMap<string, ElementSpec> {
  return new Map(catalog.map((s) => [s.key, s]));
}

const usable = (r: StrokeRecord): boolean =>
  r.metrics.impactDetected && r.metrics.quality.signalGap !== true;

/** Element faults of a record: from its stored categories, else unknown. */
function digest(
  record: StrokeRecord,
  catalog: readonly ElementSpec[],
  specs: ReadonlyMap<string, ElementSpec>,
): { digest: StrokeDigest | null; elementFault: ReadonlyMap<string, boolean> } {
  const categories = record.coach?.categories;
  const elementFault = new Map<string, boolean>();
  if (categories) {
    const assessed: CorrectionId[] = [];
    const faults: CorrectionId[] = [];
    for (const [key, category] of Object.entries(categories.byElement)) {
      const spec = specs.get(key);
      if (!spec || category === 'not-assessable') continue;
      assessed.push(spec.correctionId);
      const fault = category === 'technical-error';
      if (fault) faults.push(spec.correctionId);
      // A fault while fatigued still was outside the band (an improvement may or may not be).
      elementFault.set(key, fault || category === 'fatigue-related');
    }
    if (assessed.length === 0) return { digest: null, elementFault };
    return {
      digest: { sessionId: record.sessionId, assessed: unique(assessed), faults: unique(faults) },
      elementFault,
    };
  }
  // Older records: the stored cue is the only verdict (one fault at most).
  if (record.cue.severity === 'none') return { digest: null, elementFault };
  const m = record.metrics;
  const assessed = unique(
    catalog.filter((s) => applicability(s, m) === null).map((s) => s.correctionId),
  );
  const fault = record.cue.severity === 'fix' && isCorrectionId(record.cue.ruleId);
  return {
    digest: {
      sessionId: record.sessionId,
      assessed,
      faults: fault ? [record.cue.ruleId] : [],
    },
    elementFault,
  };
}

/** Adds one stroke (the newest) to the profile history. Pure; O(window) per stroke. */
export function addStrokeToProfile(
  state: ProfileState,
  record: StrokeRecord,
  catalog: readonly ElementSpec[] = ELEMENT_CATALOG,
  config: ProfileConfig = DEFAULT_PROFILE_CONFIG,
  specs: ReadonlyMap<string, ElementSpec> = specsByKey(catalog),
): ProfileState {
  let betterByLevel = state.betterByLevel;
  const coach = record.coach;
  if (coach?.utterance === 'better' && coach.correctionId !== null) {
    const level = coach.phraseLevel ?? null;
    if (level !== null) {
      const counts = betterByLevel[coach.correctionId] ?? [0, 0, 0];
      const next: [number, number, number] = [counts[0], counts[1], counts[2]];
      next[level]++;
      betterByLevel = { ...betterByLevel, [coach.correctionId]: next };
    }
  }
  if (!usable(record))
    return betterByLevel === state.betterByLevel ? state : { ...state, betterByLevel };

  const { digest: d, elementFault } = digest(record, catalog, specs);
  const m = record.metrics;
  const type = m.strokeType;

  // Typical swing.
  const typical = { ...state.typical[type] } as Record<TypicalMetric, readonly number[]>;
  for (const key of TYPICAL_METRICS) {
    const v = typicalValue(m, key);
    if (v !== null && Number.isFinite(v)) {
      typical[key] = [...typical[key], v].slice(-config.typicalWindow);
    }
  }

  // Session progress.
  const previous = state.sessions[record.sessionId];
  const at = record.capture.receivedAt;
  const corrections: Partial<Record<CorrectionId, Rate>> = { ...previous?.corrections };
  if (d) {
    for (const id of d.assessed) {
      const r = corrections[id] ?? { assessed: 0, faults: 0 };
      corrections[id] = {
        assessed: r.assessed + 1,
        faults: r.faults + (d.faults.includes(id) ? 1 : 0),
      };
    }
  }
  const elements: Record<string, ElementAcc> = { ...previous?.elements };
  for (const spec of catalog) {
    const value = contribution(spec, record);
    const fault = elementFault.get(spec.key);
    if (value === null && fault === undefined) continue;
    const e = elements[spec.key] ?? { n: 0, judged: 0, faults: 0, values: [] };
    elements[spec.key] = {
      n: e.n + (value === null ? 0 : 1),
      judged: e.judged + (fault === undefined ? 0 : 1),
      faults: e.faults + (fault === true ? 1 : 0),
      values: value === null ? e.values : [...e.values, value],
    };
  }
  const session: SessionAcc = {
    sessionId: record.sessionId,
    firstAt: previous ? Math.min(previous.firstAt, at) : at,
    rated: (previous?.rated ?? 0) + (d ? 1 : 0),
    corrections,
    elements,
  };

  return {
    ...state,
    window: d ? [...state.window, d].slice(-config.window) : state.window,
    sessions: { ...state.sessions, [record.sessionId]: session },
    typical: { ...state.typical, [type]: typical },
    typicalCounts: { ...state.typicalCounts, [type]: state.typicalCounts[type] + 1 },
    betterByLevel,
  };
}

/** Builds the history from stored strokes (any order) and the session list. */
export function buildProfileState(
  records: readonly StrokeRecord[],
  sessions: readonly SessionInfo[] = [],
  catalog: readonly ElementSpec[] = ELEMENT_CATALOG,
  config: ProfileConfig = DEFAULT_PROFILE_CONFIG,
): ProfileState {
  const specs = specsByKey(catalog);
  const oldestFirst = [...records].sort((a, b) => a.capture.receivedAt - b.capture.receivedAt);
  const built = oldestFirst.reduce(
    (acc, r) => addStrokeToProfile(acc, r, catalog, config, specs),
    EMPTY_PROFILE_STATE,
  );
  return withSessions(built, sessions);
}

/** Adds session labels and start times. */
export function withSessions(state: ProfileState, sessions: readonly SessionInfo[]): ProfileState {
  if (sessions.length === 0) return state;
  const sessionInfo: Record<string, SessionInfo> = { ...state.sessionInfo };
  for (const s of sessions) sessionInfo[s.id] = s;
  return { ...state, sessionInfo };
}

/* ------------------------------------------------------------ derived */

export type Trend = 'improving' | 'stable' | 'worsening';

export interface Weakness {
  readonly correctionId: CorrectionId;
  readonly label: string;
  /** Largest catalogue weight of the correction's elements. */
  readonly weight: number;
  /** Faults / strokes on which the correction was judged, over the last `window` rated strokes. */
  readonly faultRate: number;
  readonly faults: number;
  readonly assessed: number;
  /** Sessions (in the window) with at least one such fault. */
  readonly sessions: number;
  readonly trend: Trend;
  /** Per-session fault rates, oldest first (sessions with enough judged strokes). */
  readonly sessionRates: readonly number[];
}

export interface ElementProgress {
  /** Strokes with a value. */
  readonly n: number;
  /** Fault rate among the strokes on which the element was judged; null when unknown (older records). */
  readonly faultRate: number | null;
  /** Median value; null without values. */
  readonly median: number | null;
}

export interface SessionProgress {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly label: string | null;
  readonly rated: number;
  /** Per catalogue element key. */
  readonly elements: Readonly<Record<string, ElementProgress>>;
  /** Per correction: fault rate among the strokes on which it was judged. */
  readonly corrections: Readonly<Partial<Record<CorrectionId, number>>>;
}

export interface PlayerProfile {
  readonly inputs: PlayerInputs;
  readonly baseline: PersonalBaseline;
  readonly typical: Readonly<Record<StrokeType, TypicalSwing>>;
  readonly weaknesses: readonly Weakness[];
  /** One entry per session, oldest first. */
  readonly progress: readonly SessionProgress[];
  readonly betterByLevel: Readonly<Partial<Record<CorrectionId, LevelCounts>>>;
  /** Rated strokes in the weakness window. */
  readonly ratedStrokes: number;
}

function weightsOf(catalog: readonly ElementSpec[]): ReadonlyMap<CorrectionId, number> {
  const out = new Map<CorrectionId, number>();
  for (const s of catalog)
    out.set(s.correctionId, Math.max(out.get(s.correctionId) ?? 0, s.weight));
  return out;
}

export function sessionsInOrder(state: ProfileState): SessionAcc[] {
  const start = (s: SessionAcc): number => state.sessionInfo[s.sessionId]?.startedAt ?? s.firstAt;
  return Object.values(state.sessions).sort((a, b) => start(a) - start(b));
}

export function trendOf(rates: readonly number[], delta: number): Trend {
  const latest = rates.at(-1);
  if (latest === undefined || rates.length < 2) return 'stable';
  const earlier = rates.slice(-4, -1);
  const mean = earlier.reduce((a, b) => a + b, 0) / earlier.length;
  if (latest - mean <= -delta) return 'improving';
  if (latest - mean >= delta) return 'worsening';
  return 'stable';
}

function typicalOf(values: TypicalValues, n: number): TypicalSwing {
  const med = (xs: readonly number[]): number | null => (xs.length === 0 ? null : median(xs));
  return {
    n,
    headSpeedMps: med(values.headSpeedMps),
    swingPathDeg: med(values.swingPathDeg),
    faceTiltDeg: med(values.faceTiltDeg),
    brushAngleDeg: med(values.brushAngleDeg),
    forwardSwingMs: med(values.forwardSwingMs),
    takebackTurnDeg: med(values.takebackTurnDeg),
    followThroughArcDeg: med(values.followThroughArcDeg),
  };
}

/** Per-session fault rates of a correction, oldest first. */
export function sessionRates(
  sessions: readonly SessionAcc[],
  id: CorrectionId,
  minStrokes: number,
): number[] {
  const out: number[] = [];
  for (const s of sessions) {
    const r = s.corrections[id];
    if (r && r.assessed >= minStrokes) out.push(r.faults / r.assessed);
  }
  return out;
}

/** The weaknesses: frequent faults (≥ 20 % over the last 200 rated strokes, in ≥ 2 sessions). */
export function weaknessesOf(
  state: ProfileState,
  catalog: readonly ElementSpec[] = ELEMENT_CATALOG,
  config: ProfileConfig = DEFAULT_PROFILE_CONFIG,
): Weakness[] {
  const weights = weightsOf(catalog);
  const ordered = sessionsInOrder(state);
  const stats = new Map<
    CorrectionId,
    { assessed: number; faults: number; sessions: Set<string> }
  >();
  for (const d of state.window) {
    for (const id of d.assessed) {
      const s = stats.get(id) ?? { assessed: 0, faults: 0, sessions: new Set<string>() };
      s.assessed++;
      if (d.faults.includes(id)) {
        s.faults++;
        s.sessions.add(d.sessionId);
      }
      stats.set(id, s);
    }
  }
  const out: Weakness[] = [];
  for (const [id, s] of stats) {
    const rate = s.faults / s.assessed;
    if (
      s.assessed < config.weaknessMinAssessed ||
      rate < config.weaknessMinRate ||
      s.sessions.size < config.weaknessMinSessions
    ) {
      continue;
    }
    const rates = sessionRates(ordered, id, config.trendMinStrokes);
    out.push({
      correctionId: id,
      label: weaknessLabel(id),
      weight: weights.get(id) ?? 0,
      faultRate: rate,
      faults: s.faults,
      assessed: s.assessed,
      sessions: s.sessions.size,
      trend: trendOf(rates, config.trendDelta),
      sessionRates: rates,
    });
  }
  return out.sort((a, b) => b.weight * b.faultRate - a.weight * a.faultRate);
}

/** Per-session progress for charts, oldest first. */
export function progressOf(state: ProfileState): SessionProgress[] {
  return sessionsInOrder(state).map((s) => {
    const elements: Record<string, ElementProgress> = {};
    for (const [key, e] of Object.entries(s.elements)) {
      elements[key] = {
        n: e.n,
        faultRate: e.judged === 0 ? null : e.faults / e.judged,
        median: e.values.length === 0 ? null : median(e.values),
      };
    }
    const corrections: Partial<Record<CorrectionId, number>> = {};
    for (const [id, r] of Object.entries(s.corrections) as [CorrectionId, Rate][]) {
      corrections[id] = r.assessed === 0 ? 0 : r.faults / r.assessed;
    }
    const info = state.sessionInfo[s.sessionId];
    return {
      sessionId: s.sessionId,
      startedAt: info?.startedAt ?? s.firstAt,
      label: info?.label ?? null,
      rated: s.rated,
      elements,
      corrections,
    };
  });
}

/** The full profile: inputs plus everything derived from the history. */
export function deriveProfile(
  state: ProfileState,
  inputs: PlayerInputs,
  baseline: PersonalBaseline,
  catalog: readonly ElementSpec[] = ELEMENT_CATALOG,
  config: ProfileConfig = DEFAULT_PROFILE_CONFIG,
): PlayerProfile {
  return {
    inputs,
    baseline,
    typical: {
      forehand: typicalOf(state.typical.forehand, state.typicalCounts.forehand),
      backhand: typicalOf(state.typical.backhand, state.typicalCounts.backhand),
      overhead: typicalOf(state.typical.overhead, state.typicalCounts.overhead),
    },
    weaknesses: weaknessesOf(state, catalog, config),
    progress: progressOf(state),
    betterByLevel: state.betterByLevel,
    ratedStrokes: state.window.length,
  };
}
