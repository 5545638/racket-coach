import type { Utterance } from '../coach/coachEngine';
import type { TrainingPlan } from '../coach/plan';
import type { PlayerProfile, Trend, TypicalSwing, Weakness } from '../coach/profile';
import { cueVariants, learningSentence, weaknessLabel } from '../coach/phrases';
import { CORRECTIONS, FEEDBACK_LABELS, type CorrectionId } from '../coaching/corrections';
import type { Language } from '../coaching/guidance';
import type {
  CategoryCounts,
  CoachMode,
  DeviationCategory,
  StrokeRecord,
  StrokeType,
  UtteranceKind,
} from '../domain/types';
import { deg, kmh, ms } from './format';
import { type Strings, strings } from './strings';

/**
 * View models of the profile tab and of the adaptive parts of the live and
 * session screens. Pure: plain data in, display text out (no rendering).
 */

const STROKE_TYPES: readonly StrokeType[] = ['forehand', 'backhand', 'overhead'];
const DASH = '—';

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/* ------------------------------------------------------------ inputs */

export interface LabelValue {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export function inputsSummary(inputs: PlayerProfile['inputs'], language: Language): LabelValue[] {
  const s = strings(language).setup;
  return [
    {
      id: 'hand',
      label: s.dominantHand,
      value: inputs.dominantHand === 'right' ? s.handRight : s.handLeft,
    },
    {
      id: 'backhand',
      label: s.backhand,
      value: inputs.backhand === 'two-handed' ? s.twoHanded : s.oneHanded,
    },
    {
      id: 'style',
      label: s.forehandStyle,
      value: { topspin: s.styleTopspin, flat: s.styleFlat, mixed: s.styleMixed }[
        inputs.forehandStyle
      ],
    },
    {
      id: 'level',
      label: s.level,
      value: {
        beginner: s.levelBeginner,
        intermediate: s.levelIntermediate,
        advanced: s.levelAdvanced,
      }[inputs.level],
    },
  ];
}

/* ----------------------------------------------------------- typical */

export interface TypicalView {
  readonly strokeType: StrokeType;
  readonly title: string;
  readonly n: number;
  readonly rows: readonly LabelValue[];
}

function typicalRows(typical: TypicalSwing, t: Strings): LabelValue[] {
  const speed = typical.headSpeedMps;
  return [
    { id: 'speed', label: t.metric.speed, value: speed === null ? DASH : kmh(speed) },
    { id: 'path', label: t.metric.path, value: deg(typical.swingPathDeg) },
    { id: 'face', label: t.metric.face, value: deg(typical.faceTiltDeg) },
    { id: 'brush', label: t.metric.brushAngle, value: deg(typical.brushAngleDeg) },
    { id: 'forward', label: t.metric.forwardSwing, value: ms(typical.forwardSwingMs, false) },
    { id: 'takeback', label: t.metric.takebackTurn, value: deg(typical.takebackTurnDeg) },
    { id: 'follow', label: t.metric.followThrough, value: deg(typical.followThroughArcDeg) },
  ];
}

/** Typical swing per stroke type that has any strokes. */
export function typicalViews(typical: PlayerProfile['typical'], language: Language): TypicalView[] {
  const t = strings(language);
  return STROKE_TYPES.filter((type) => typical[type].n > 0).map((strokeType) => ({
    strokeType,
    title: t.stroke[strokeType],
    n: typical[strokeType].n,
    rows: typicalRows(typical[strokeType], t),
  }));
}

/* -------------------------------------------------------- weaknesses */

const TREND_ARROW: Record<Trend, string> = { improving: '↑', stable: '→', worsening: '↓' };

export interface WeaknessView {
  readonly correctionId: CorrectionId;
  readonly label: string;
  /** "32%" */
  readonly rate: string;
  readonly sessionsText: string;
  readonly trend: Trend;
  readonly trendLabel: string;
  readonly arrow: string;
  /** "new" for a weakness seen in one session only; else null. */
  readonly newBadge: string | null;
}

export function weaknessViews(weaknesses: readonly Weakness[], language: Language): WeaknessView[] {
  const t = strings(language).profile;
  return weaknesses.map((w) => ({
    correctionId: w.correctionId,
    label: weaknessLabel(w.correctionId, language),
    rate: percent(w.faultRate),
    sessionsText: t.sessionsN(w.sessions),
    trend: w.trend,
    trendLabel: t.trend[w.trend],
    arrow: TREND_ARROW[w.trend],
    newBadge: w.isNew ? t.newWeakness : null,
  }));
}

/* --------------------------------------------------------- sparkline */

export const SPARK_WIDTH = 160;
export const SPARK_HEIGHT = 44;
const SPARK_PAD = 5;
export const SPARK_MAX_SESSIONS = 12;

export interface SparkPoint {
  readonly x: number;
  readonly y: number;
}

export interface Sparkline {
  readonly width: number;
  readonly height: number;
  readonly points: readonly SparkPoint[];
  /** SVG path data of the line; empty with fewer than two sessions. */
  readonly path: string;
  /** Top of the scale as a share (0–1); the bottom is always 0. */
  readonly yMax: number;
  /** Fault rates in whole percent, oldest first, as drawn. */
  readonly percents: readonly number[];
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Line of per-session fault rates (0–1), last `SPARK_MAX_SESSIONS` only.
 * y: 0 at the bottom, `yMax` (the largest rate rounded up to 10 %, at least
 * 20 %) at the top. x: evenly spaced; one session is a single centred point,
 * none draws nothing.
 */
export function sparkline(rates: readonly number[]): Sparkline {
  const shown = rates.slice(-SPARK_MAX_SESSIONS);
  const yMax = Math.min(1, Math.max(0.2, Math.ceil(Math.max(0, ...shown) * 10 - 1e-9) / 10));
  const innerW = SPARK_WIDTH - 2 * SPARK_PAD;
  const innerH = SPARK_HEIGHT - 2 * SPARK_PAD;
  const points = shown.map((rate, i) => ({
    x: round1(shown.length === 1 ? SPARK_WIDTH / 2 : SPARK_PAD + (innerW * i) / (shown.length - 1)),
    y: round1(SPARK_PAD + innerH * (1 - Math.min(1, Math.max(0, rate)) / yMax)),
  }));
  return {
    width: SPARK_WIDTH,
    height: SPARK_HEIGHT,
    points,
    path:
      points.length < 2
        ? ''
        : points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' '),
    yMax,
    percents: shown.map((r) => Math.round(r * 100)),
  };
}

export interface ProgressView {
  readonly correctionId: CorrectionId;
  readonly label: string;
  readonly spark: Sparkline;
  /** Accessible description with the numbers. */
  readonly aria: string;
}

/** Sparklines of the top `limit` weaknesses; those without any session rate are skipped. */
export function progressViews(
  weaknesses: readonly Weakness[],
  language: Language,
  limit = 3,
): ProgressView[] {
  const t = strings(language).profile;
  return weaknesses
    .filter((w) => w.sessionRates.length > 0)
    .slice(0, limit)
    .map((w) => {
      const spark = sparkline(w.sessionRates);
      const label = weaknessLabel(w.correctionId, language);
      return {
        correctionId: w.correctionId,
        label,
        spark,
        aria: t.sparkAria(label, spark.percents.map((p) => `${p}%`).join(', ')),
      };
    });
}

/* -------------------------------------------------------------- plan */

export interface PlanItemView {
  readonly kind: 'weakness' | 'maintenance';
  readonly correctionId: CorrectionId;
  readonly title: string;
  readonly drill: string;
  /** "3 × 15 palli" */
  readonly volume: string;
  /** The cue that worked best, in quotes ("Swing low to high"). */
  readonly cue: string;
  /** "Eesmärk: alla 15% vigu" */
  readonly target: string;
  readonly kindLabel: string;
}

export function planViews(plan: TrainingPlan, language: Language): PlanItemView[] {
  const t = strings(language).profile;
  return plan.items.map((item) => ({
    kind: item.kind,
    correctionId: item.correctionId,
    title: item.label,
    drill: item.drill,
    volume: t.volume(item.sets, item.ballsPerSet),
    cue: item.cue,
    target: (item.kind === 'maintenance' ? t.targetKeep : t.target)(
      Math.round(item.targetFaultRate * 100),
    ),
    kindLabel: item.kind === 'maintenance' ? t.maintenance : t.focusItem,
  }));
}

/* ------------------------------------------------------ whole profile */

export interface ProfileView {
  readonly inputs: readonly LabelValue[];
  readonly typical: readonly TypicalView[];
  readonly weaknesses: readonly WeaknessView[];
  readonly progress: readonly ProgressView[];
  readonly plan: readonly PlanItemView[];
  /** Rated strokes behind the profile. */
  readonly ratedStrokes: number;
  /** Nothing to show beyond the inputs yet. */
  readonly empty: boolean;
}

export function profileViewModel(
  profile: PlayerProfile,
  plan: TrainingPlan,
  language: Language,
): ProfileView {
  const typical = typicalViews(profile.typical, language);
  const weaknesses = weaknessViews(profile.weaknesses, language);
  return {
    inputs: inputsSummary(profile.inputs, language),
    typical,
    weaknesses,
    progress: progressViews(profile.weaknesses, language),
    plan: planViews(plan, language),
    ratedStrokes: profile.ratedStrokes,
    empty: typical.length === 0 && weaknesses.length === 0 && plan.items.length === 0,
  };
}

/* ---------------------------------------------------------- live view */

const CATEGORY_ORDER: readonly DeviationCategory[] = [
  'technical-error',
  'variation',
  'uncertain',
  'not-assessable',
  'fatigue-related',
  'improvement',
];

/**
 * "Viga 1 · Sinu stiil 6 · Ebakindel 2 · Hindamata 3": categories with a
 * count above zero, in a fixed order; null when nothing was assessed.
 */
export function categorySummary(
  counts: Readonly<Partial<Record<DeviationCategory, number>>> | null,
  language: Language,
): string | null {
  if (!counts) return null;
  const labels = strings(language).category;
  const parts = CATEGORY_ORDER.filter((c) => (counts[c] ?? 0) > 0).map(
    (c) => `${labels[c]} ${counts[c] ?? 0}`,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

export interface LiveExtras {
  /** The sentence explaining the cue (spoken English), learning mode only. */
  readonly learningLine: string | null;
  /** Small badge text while the fatigue detector is active. */
  readonly fatigueBadge: string | null;
  readonly categoryLine: string | null;
}

export function liveExtras(input: {
  readonly mode: CoachMode;
  readonly utterance: Utterance | null;
  readonly fatigueActive: boolean;
  readonly categories: CategoryCounts | null;
  readonly language: Language;
}): LiveExtras {
  const t = strings(input.language);
  const u = input.utterance;
  const id = input.mode === 'learning' && u?.kind === 'correction' ? u.correctionId : undefined;
  return {
    learningLine: id === undefined ? null : learningSentence(id),
    fatigueBadge: input.fatigueActive ? t.live.fatigueBadge : null,
    categoryLine: input.mode === 'match' ? null : categorySummary(input.categories, input.language),
  };
}

export interface MatchLiveView {
  readonly count: number;
  /** Localised stroke type of the latest stroke; null before the first. */
  readonly strokeType: string | null;
  /** Title of the persistent fault spoken in a break in play; null when none. */
  readonly pendingFault: string | null;
}

/** The correction whose spoken variants include `phrase`. */
function correctionOfSpeech(phrase: string): CorrectionId | null {
  const spoken = phrase.split('. ')[0] ?? phrase;
  for (const id of Object.keys(CORRECTIONS.en) as CorrectionId[]) {
    if (cueVariants(id).includes(spoken)) return id;
  }
  return null;
}

/**
 * Match mode keeps the screen minimal: stroke counter and last stroke type;
 * the only cue shown is a persistent fault after it was spoken.
 */
export function matchLiveView(input: {
  readonly count: number;
  readonly strokeType: StrokeType | null;
  readonly lastSpeech: string | null;
  readonly language: Language;
}): MatchLiveView {
  const t = strings(input.language);
  const id = input.lastSpeech === null ? null : correctionOfSpeech(input.lastSpeech);
  return {
    count: input.count,
    strokeType: input.strokeType === null ? null : t.stroke[input.strokeType],
    pendingFault: id === null ? null : (t.cueTitle[id] ?? id),
  };
}

/* ------------------------------------------------------- session view */

const FEEDBACK_KINDS = [
  'better',
  'keep-it',
  'overcorrected',
  'consistency',
  'fatigue',
  'stuck',
] as const;
type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
const FEEDBACK_KEY = {
  better: 'better',
  'keep-it': 'keepIt',
  overcorrected: 'overcorrected',
  consistency: 'consistency',
  fatigue: 'fatigue',
  stuck: 'stuck',
} as const satisfies Record<FeedbackKind, keyof typeof FEEDBACK_LABELS.en>;

export interface SessionAdaptive {
  /** Category line summed over the session's strokes; null when none were categorised. */
  readonly categories: readonly {
    readonly id: DeviationCategory;
    readonly label: string;
    readonly count: number;
  }[];
  readonly feedback: readonly {
    readonly kind: UtteranceKind;
    readonly label: string;
    readonly count: number;
  }[];
}

/** Category counts and feedback-kind counts of a session's strokes. */
export function sessionAdaptive(
  records: readonly StrokeRecord[],
  language: Language,
): SessionAdaptive {
  const labels = strings(language).category;
  const totals = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) as Record<
    DeviationCategory,
    number
  >;
  const kinds = Object.fromEntries(FEEDBACK_KINDS.map((k) => [k, 0])) as Record<
    FeedbackKind,
    number
  >;
  for (const r of records) {
    const coach = r.coach;
    if (!coach) continue;
    if (coach.categories) for (const c of CATEGORY_ORDER) totals[c] += coach.categories.counts[c];
    if ((FEEDBACK_KINDS as readonly string[]).includes(coach.utterance)) {
      kinds[coach.utterance as FeedbackKind]++;
    }
  }
  return {
    categories: CATEGORY_ORDER.map((id) => ({ id, label: labels[id], count: totals[id] })),
    feedback: FEEDBACK_KINDS.map((kind) => ({
      kind,
      label: FEEDBACK_LABELS[language][FEEDBACK_KEY[kind]],
      count: kinds[kind],
    })),
  };
}
