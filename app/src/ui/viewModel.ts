import type { UtteranceReason, Utterance } from '../coach/coachEngine';
import { DEFAULT_BASELINE_CONFIG } from '../coach/baseline';
import { CORRECTIONS, type CorrectionId } from '../coaching/corrections';
import { type Language, guidanceFor } from '../coaching/guidance';
import type {
  Cue,
  FeatureSigmaKey,
  StrokeMetrics,
  StrokeRecord,
  StrokeType,
  UtteranceKind,
} from '../domain/types';
import {
  type Band,
  type ElementAssessment,
  type StrokeAssessment,
  byCorrection,
} from '../elements/assess';
import type { ElementUnit } from '../elements/catalog';
import { type Strings, strings } from './strings';

/**
 * View models of the live and session screens: everything the components
 * show, as plain data, so wording and number formatting can be tested without
 * rendering. All text is in the UI language; spoken cues stay English.
 */

const MINUS = '−';
const STROKE_TYPES: readonly StrokeType[] = ['forehand', 'backhand', 'overhead'];

const isCorrectionId = (id: string): id is CorrectionId => id in CORRECTIONS.en;

/** Localised short name of a correction (or legacy cue) id. */
export function titleFor(id: string, language: Language, fallback = id): string {
  return strings(language).cueTitle[id] ?? fallback;
}

/* ------------------------------------------------------------- numbers */

const plainNumber = (value: number, digits: number): string => {
  const text = Math.abs(value).toFixed(digits);
  const negative = value < 0 && Number(text) !== 0;
  return `${negative ? MINUS : ''}${text}`;
};

/** σ keeps one decimal below 1 so that "± 0.3" does not become "± 0". */
const sigmaDigits = (sigma: number): number => (sigma >= 1 || sigma === 0 ? 0 : 1);

function formatValue(unit: ElementUnit, value: number, signedMs = false): string {
  switch (unit) {
    case 'deg':
      return `${plainNumber(value, 0)}°`;
    case 'ms': {
      const text = plainNumber(value, 0);
      return `${signedMs && Number(text) > 0 ? '+' : ''}${text} ms`;
    }
    case 'dps':
      return `${plainNumber(value, 0)} °/s`;
    case 'fraction':
      return `${plainNumber(value * 100, 0)}%`;
    case 'count':
      return plainNumber(value, 0);
  }
}

function formatSigma(unit: ElementUnit, sigma: number): string {
  switch (unit) {
    case 'deg':
      return `${plainNumber(sigma, sigmaDigits(sigma))}°`;
    case 'ms':
      return `${plainNumber(sigma, sigmaDigits(sigma))} ms`;
    case 'dps':
      return `${plainNumber(sigma, sigmaDigits(sigma))} °/s`;
    case 'fraction':
      return `${plainNumber(sigma * 100, sigmaDigits(sigma * 100))}%`;
    case 'count':
      return plainNumber(sigma, 2);
  }
}

/** "−12° ± 2°"; the spread is left out for integer counts and when unknown. */
export function formatMeasure(
  unit: ElementUnit,
  value: number | null,
  sigma: number | null,
  signedMs = false,
): string {
  if (value === null) return '—';
  const text = formatValue(unit, value, signedMs);
  if (sigma === null || unit === 'count') return text;
  return `${text} ± ${formatSigma(unit, sigma)}`;
}

/** The limit of a band as "≥ 12°" / "≤ 55°". */
export function formatLimit(unit: ElementUnit, band: Band, signedMs = false): string | null {
  if (band.lo !== null) return `≥ ${formatValue(unit, band.lo, signedMs)}`;
  if (band.hi !== null) return `≤ ${formatValue(unit, band.hi, signedMs)}`;
  return null;
}

/* ----------------------------------------------------------- headline */

export type Tone = 'good' | 'fix' | 'none';

export interface Headline {
  readonly kind: UtteranceKind;
  readonly tone: Tone;
  /** Big text, in the UI language. */
  readonly title: string;
  /** The English phrase said through the earphones; null when nothing was said. */
  readonly spoken: string | null;
  /** Small line under the title (why nothing was said, …); null when none. */
  readonly detail: string | null;
  /** The correction shown (the one spoken, or the focus for "Better"). */
  readonly correctionId: CorrectionId | null;
}

/** Three short blocks for a correction. */
export interface GuidanceBlocks {
  readonly why: string;
  readonly change: string;
  readonly drill: string;
}

/**
 * Why / change / drill for a correction id, from the correction catalogue;
 * legacy rule ids (e.g. "not-rated") fall back to the old guidance texts.
 */
export function guidanceBlocks(id: string, language: Language): GuidanceBlocks | null {
  if (isCorrectionId(id)) {
    const c = CORRECTIONS[language][id];
    return { why: c.explanation, change: c.adjustment, drill: c.drill };
  }
  const legacy = guidanceFor(id, language);
  return legacy ? { why: legacy.meaning, change: legacy.fix, drill: legacy.drill } : null;
}

function headlineFrom(
  utterance: Utterance,
  t: Strings,
  language: Language,
  assessment: StrokeAssessment | null,
): Headline {
  const spoken = utterance.spoken === '' ? null : utterance.spoken;
  const detailFor = (reason: UtteranceReason): string | null => t.live.detail[reason] ?? null;
  const id = utterance.correctionId ?? null;
  switch (utterance.kind) {
    case 'correction':
      return {
        kind: 'correction',
        tone: 'fix',
        title: id ? titleFor(id, language, spoken ?? id) : t.live.counted,
        spoken,
        detail: null,
        correctionId: id,
      };
    case 'better':
      return {
        kind: 'better',
        tone: 'good',
        title: t.live.better,
        spoken,
        detail: id ? titleFor(id, language) : null,
        correctionId: id,
      };
    case 'keep-it':
      return {
        kind: 'keep-it',
        tone: 'good',
        title: t.live.thatsIt,
        spoken,
        detail: id ? titleFor(id, language) : null,
        correctionId: id,
      };
    case 'good':
      return {
        kind: 'good',
        tone: 'good',
        title: t.live.good,
        spoken,
        detail: detailFor(utterance.reason),
        correctionId: null,
      };
    case 'overcorrected':
    case 'consistency':
    case 'fatigue':
    case 'stuck': {
      const titles = {
        overcorrected: t.live.overcorrected,
        consistency: t.live.consistency,
        fatigue: t.live.fatigue,
        stuck: t.live.stuck,
      } as const;
      return {
        kind: utterance.kind,
        tone: utterance.kind === 'fatigue' ? 'none' : 'fix',
        title: titles[utterance.kind],
        spoken,
        detail: id ? titleFor(id, language) : detailFor(utterance.reason),
        correctionId: id,
      };
    }
    case 'silent': {
      // A stroke without contact is not a rated stroke at all.
      const reason: UtteranceReason =
        assessment && !assessment.contact ? 'no-contact' : utterance.reason;
      return {
        kind: 'silent',
        tone: 'none',
        title: t.live.counted,
        spoken: null,
        detail: detailFor(reason),
        correctionId: null,
      };
    }
  }
}

/** Headline of a stroke that has no coach utterance (legacy records): its stored cue. */
function headlineFromCue(cue: Cue, language: Language): Headline {
  const fix = cue.severity === 'fix';
  return {
    kind: fix ? 'correction' : cue.severity === 'good' ? 'good' : 'silent',
    tone: fix ? 'fix' : cue.severity === 'good' ? 'good' : 'none',
    title: titleFor(cue.ruleId, language, cue.text),
    spoken: fix ? cue.text : null,
    detail: null,
    correctionId: isCorrectionId(cue.ruleId) ? cue.ruleId : null,
  };
}

/* -------------------------------------------------------------- focus */

export type FocusStatus = 'fault' | 'ok' | 'not-assessable' | 'none';

export interface FocusModel {
  readonly correctionId: CorrectionId | null;
  readonly title: string | null;
  readonly status: FocusStatus;
  /** P(true value outside the band) in whole percent; only while the focus is a fault. */
  readonly confidencePercent: number | null;
  /** "Compared with: your usual stroke (n strokes)" / "…reference limits"; null without a fault. */
  readonly comparedWith: string | null;
  /** Where the focus stands on the latest stroke, in words ("fine on this stroke"). */
  readonly statusText: string | null;
}

function focusModel(
  focus: CorrectionId | null,
  assessment: StrokeAssessment | null,
  t: Strings,
  language: Language,
): FocusModel {
  if (focus === null) {
    return {
      correctionId: null,
      title: null,
      status: 'none',
      confidencePercent: null,
      comparedWith: null,
      statusText: null,
    };
  }
  const verdict = assessment ? (byCorrection(assessment).get(focus) ?? null) : null;
  const title = titleFor(focus, language);
  if (verdict?.status === 'fault') {
    return {
      correctionId: focus,
      title,
      status: 'fault',
      // Capped at 99 %: a model estimate is never certain.
      confidencePercent: Math.min(99, Math.round(verdict.probability * 100)),
      comparedWith: comparedWith(verdict, t),
      statusText: null,
    };
  }
  const ok = verdict?.status === 'ok';
  return {
    correctionId: focus,
    title,
    status: ok ? 'ok' : 'not-assessable',
    confidencePercent: null,
    comparedWith: ok ? comparedWith(verdict, t) : null,
    statusText: ok ? t.live.focusOk : t.live.focusNotAssessed,
  };
}

function comparedWith(e: ElementAssessment, t: Strings): string | null {
  const n = e.personal?.n ?? 0;
  switch (e.bandSource) {
    case 'personal':
      return t.live.comparedPersonal(n);
    case 'combined':
      return t.live.comparedCombined(n);
    case 'population':
      return t.live.comparedPopulation;
    case null:
      return null;
  }
}

/** "Personal baseline: 9/15 strokes" while below the activation size; null otherwise. */
export function baselineProgressText(
  count: number,
  loading: boolean,
  language: Language,
): string | null {
  const t = strings(language);
  if (loading) return t.live.baselineLoading;
  const needed = DEFAULT_BASELINE_CONFIG.minStrokes;
  return count < needed ? t.live.baselineProgress(count, needed) : null;
}

/* ------------------------------------------------------------ metrics */

export type RowStatus = 'ok' | 'fault' | 'not-assessable' | 'info';

export interface MetricRow {
  readonly id: string;
  readonly label: string;
  /** Value with ± σ, or "—". */
  readonly value: string;
  readonly status: RowStatus;
  /** Small line: the limit of a fault, or why the value is not assessable. */
  readonly note: string | null;
}

export type GroupId = 'preparation' | 'contact' | 'finish';

export interface MetricGroup {
  readonly id: GroupId;
  readonly title: string;
  readonly rows: readonly MetricRow[];
}

interface PlainValue {
  readonly value: number | null;
  readonly sigma?: number | null;
  /** Shown as a lower bound ("≥") because the gyro clipped. */
  readonly lowerBound?: boolean;
}

interface RowSpec {
  readonly id: string;
  readonly group: GroupId;
  readonly label: (t: Strings) => string;
  readonly unit: ElementUnit;
  /** Catalogue metric whose assessment this row shows; none = plain value only. */
  readonly metric?: string;
  /** Value from the stroke itself: the whole row without an assessment, the fallback with one. */
  readonly plain?: (m: StrokeMetrics) => PlainValue;
  /** Offsets relative to contact are shown with an explicit plus. */
  readonly signedMs?: boolean;
  readonly only?: StrokeType;
}

const sigmaOf = (m: StrokeMetrics, key: FeatureSigmaKey): number | null =>
  m.features?.sigma[key] ?? null;

const ROWS: readonly RowSpec[] = [
  {
    id: 'takebackTurn',
    group: 'preparation',
    label: (t) => t.metric.takebackTurn,
    unit: 'deg',
    metric: 'takebackTurnDeg',
    plain: (m) => ({
      value: m.features?.takebackTurnDeg ?? null,
      sigma: sigmaOf(m, 'takebackTurnDeg'),
    }),
  },
  {
    id: 'takebackTip',
    group: 'preparation',
    label: (t) => t.metric.takebackTip,
    unit: 'deg',
    metric: 'takebackTipDeg',
    plain: (m) => ({
      value: m.features?.takebackTipDeg ?? null,
      sigma: sigmaOf(m, 'takebackTipDeg'),
    }),
  },
  {
    id: 'takebackFace',
    group: 'preparation',
    label: (t) => t.metric.takebackFace,
    unit: 'deg',
    plain: (m) => ({
      value: m.features?.takebackFaceDeg ?? null,
      sigma: sigmaOf(m, 'takebackFaceDeg'),
    }),
  },
  {
    id: 'takebackTime',
    group: 'preparation',
    label: (t) => t.metric.takebackTime,
    unit: 'ms',
    metric: 'takebackTimeMs',
    plain: (m) => ({
      // Same quantity as the legacy preparationTimeMs; strokes analysed
      // before the features existed fall back to it (without σ).
      value: m.features?.takebackTimeMs ?? m.preparationTimeMs,
      sigma: sigmaOf(m, 'takebackTimeMs'),
    }),
  },
  {
    id: 'racketDrop',
    group: 'preparation',
    label: (t) => t.metric.racketDrop,
    unit: 'deg',
    metric: 'racketDropDeg',
    plain: (m) => ({ value: m.racketDropDeg, sigma: sigmaOf(m, 'racketDropDeg') }),
  },
  {
    id: 'faceAtDrop',
    group: 'preparation',
    label: (t) => t.metric.faceAtDrop,
    unit: 'deg',
    metric: 'faceAtDropDeg',
    plain: (m) => ({ value: m.faceAtDropDeg }),
  },
  {
    id: 'serveDrop',
    group: 'preparation',
    label: (t) => t.metric.serveDrop,
    unit: 'deg',
    metric: 'serve.dropTipDeg',
    only: 'overhead',
  },
  {
    id: 'pause',
    group: 'preparation',
    label: (t) => t.metric.pause,
    unit: 'ms',
    metric: 'backswingPauseMs',
    plain: (m) => ({ value: m.backswingPauseMs }),
  },
  {
    id: 'hitchCount',
    group: 'preparation',
    label: (t) => t.metric.hitchCount,
    unit: 'count',
    metric: 'hitchCount',
    plain: (m) => ({ value: m.features?.hitchCount ?? null }),
  },
  {
    id: 'speed',
    group: 'contact',
    label: (t) => t.metric.speed,
    unit: 'count',
    // Formatted separately (km/h).
    plain: (m) => ({ value: m.headSpeedMps, lowerBound: m.quality.gyroSaturated }),
  },
  {
    id: 'face',
    group: 'contact',
    label: (t) => t.metric.face,
    unit: 'deg',
    metric: 'faceTiltDeg',
    plain: (m) => ({ value: m.faceTiltDeg, sigma: sigmaOf(m, 'faceTiltDeg') }),
  },
  {
    id: 'path',
    group: 'contact',
    label: (t) => t.metric.path,
    unit: 'deg',
    metric: 'swingPathDeg',
    plain: (m) => ({ value: m.swingPathDeg, sigma: sigmaOf(m, 'swingPathDeg') }),
  },
  {
    id: 'brush',
    group: 'contact',
    label: (t) => t.metric.brushAngle,
    unit: 'deg',
    plain: (m) => ({
      value: m.features?.brushAngleDeg ?? null,
      sigma: sigmaOf(m, 'brushAngleDeg'),
    }),
  },
  {
    id: 'peakSpeed',
    group: 'contact',
    label: (t) => t.metric.peakSpeed,
    unit: 'ms',
    metric: 'peakSpeedOffsetMs',
    signedMs: true,
    plain: (m) => ({ value: m.peakSpeedOffsetMs, sigma: sigmaOf(m, 'peakSpeedOffsetMs') }),
  },
  {
    id: 'stability',
    group: 'contact',
    label: (t) => t.metric.contactStability,
    unit: 'dps',
    metric: 'contactStabilityDps',
  },
  {
    // G50 is a proxy for how much racket speed was gained late; not a wrist measurement.
    id: 'lateAcceleration',
    group: 'contact',
    label: (t) => t.metric.lateAcceleration,
    unit: 'fraction',
    metric: 'lateGainFraction',
    plain: (m) => ({ value: m.features?.lateGainFraction ?? null }),
  },
  {
    id: 'serveContactTip',
    group: 'contact',
    label: (t) => t.metric.serveContactTip,
    unit: 'deg',
    metric: 'serve.contactTipDeg',
    only: 'overhead',
  },
  {
    id: 'serveRoll',
    group: 'contact',
    label: (t) => t.metric.serveRoll,
    unit: 'deg',
    metric: 'serve.rollAngleDeg',
    only: 'overhead',
  },
  {
    id: 'faceClosing',
    group: 'contact',
    label: (t) => t.metric.faceClosing,
    unit: 'dps',
    plain: (m) => ({ value: m.faceClosingRateDps }),
  },
  {
    id: 'followThrough',
    group: 'finish',
    label: (t) => t.metric.followThrough,
    unit: 'deg',
    metric: 'followThroughArcDeg',
    plain: (m) => ({ value: m.followThroughArcDeg }),
  },
  {
    id: 'braking',
    group: 'finish',
    label: (t) => t.metric.brakingTime,
    unit: 'ms',
    metric: 'brakingTimeMs',
    plain: (m) => ({
      value: m.features?.brakingTimeMs ?? null,
      sigma: sigmaOf(m, 'brakingTimeMs'),
    }),
  },
  {
    id: 'recovery',
    group: 'finish',
    label: (t) => t.metric.recovery,
    unit: 'ms',
    metric: 'recoveryMs',
    plain: (m) => ({ value: m.features?.recoveryMs ?? null, sigma: sigmaOf(m, 'recoveryMs') }),
  },
];

/** The assessed element behind a row: a fault first, then an ok one, then a not-assessable one. */
function elementFor(assessment: StrokeAssessment, metric: string): ElementAssessment | null {
  const own = assessment.elements.filter((e) => e.metric === metric && e.reason !== 'wrong-stroke');
  return (
    own.find((e) => e.status === 'fault') ?? own.find((e) => e.status === 'ok') ?? own[0] ?? null
  );
}

function rowFor(
  spec: RowSpec,
  m: StrokeMetrics,
  assessment: StrokeAssessment | null,
  t: Strings,
): MetricRow | null {
  if (spec.only !== undefined && m.strokeType !== spec.only) return null;
  const label = spec.label(t);
  const element = assessment && spec.metric ? elementFor(assessment, spec.metric) : null;
  if (element) {
    const value = formatMeasure(spec.unit, element.value, element.sigma, spec.signedMs);
    if (element.status === 'not-assessable') {
      return {
        id: spec.id,
        label,
        value,
        status: 'not-assessable',
        note: element.reason ? t.reason[element.reason] : null,
      };
    }
    const limit =
      element.status === 'fault' && element.band
        ? formatLimit(spec.unit, element.band, spec.signedMs)
        : null;
    return {
      id: spec.id,
      label,
      value,
      status: element.status,
      note: limit ? `${t.live.limit} ${limit}` : null,
    };
  }
  if (!spec.plain) return null;
  const plain = spec.plain(m);
  if (spec.id === 'speed') {
    return {
      id: spec.id,
      label,
      value: `${plain.lowerBound ? '≥' : ''}${((plain.value ?? 0) * 3.6).toFixed(0)} km/h`,
      status: 'info',
      note: null,
    };
  }
  return {
    id: spec.id,
    label,
    value: formatMeasure(spec.unit, plain.value, plain.sigma ?? null, spec.signedMs),
    status: 'info',
    note: null,
  };
}

/** Metric rows grouped as preparation / contact / finish; empty groups are left out. */
export function metricGroups(
  m: StrokeMetrics,
  assessment: StrokeAssessment | null,
  language: Language,
): MetricGroup[] {
  const t = strings(language);
  const groups: GroupId[] = ['preparation', 'contact', 'finish'];
  return groups
    .map((id) => ({
      id,
      title: t.group[id],
      rows: ROWS.filter((s) => s.group === id)
        .map((s) => rowFor(s, m, assessment, t))
        .filter((r): r is MetricRow => r !== null),
    }))
    .filter((g) => g.rows.length > 0);
}

/* --------------------------------------------------------- live model */

export interface LiveViewModel {
  readonly headline: Headline;
  /** Why / change / drill of the correction on screen; null for everything else. */
  readonly blocks: GuidanceBlocks | null;
  readonly focus: FocusModel;
  /** "Personal baseline: 9/15 strokes"; null once the baseline is in use. */
  readonly baselineProgress: string | null;
  readonly groups: readonly MetricGroup[];
}

export interface LiveViewInput {
  readonly metrics: StrokeMetrics;
  readonly assessment: StrokeAssessment | null;
  readonly utterance: Utterance | null;
  /** The stroke's stored cue; used only when there is no utterance (legacy records). */
  readonly cue: Cue;
  /** Current focus of this stroke's type. */
  readonly focus: CorrectionId | null;
  /** Strokes with contact in the baseline, this stroke type. */
  readonly baselineCount: number;
  readonly baselineLoading: boolean;
  readonly language: Language;
}

/** Everything the live screen shows for the latest stroke. Pure. */
export function liveViewModel(input: LiveViewInput): LiveViewModel {
  const { language } = input;
  const t = strings(language);
  const headline = input.utterance
    ? headlineFrom(input.utterance, t, language, input.assessment)
    : headlineFromCue(input.cue, language);
  const showsCorrection = headline.kind === 'correction' && headline.correctionId !== null;
  const legacyId =
    input.utterance === null && input.cue.severity === 'none' ? input.cue.ruleId : null;
  const blockId = showsCorrection ? headline.correctionId : legacyId;
  return {
    headline,
    blocks: blockId ? guidanceBlocks(blockId, language) : null,
    focus: focusModel(input.focus, input.assessment, t, language),
    baselineProgress: baselineProgressText(input.baselineCount, input.baselineLoading, language),
    groups: metricGroups(input.metrics, input.assessment, language),
  };
}

/* ------------------------------------------------------------ session */

export interface CorrectionCount {
  readonly correctionId: CorrectionId;
  readonly count: number;
}

export interface StrokeCoachSummary {
  readonly strokeType: StrokeType;
  /** Strokes of this type recorded in the session. */
  readonly counted: number;
  /** Corrections spoken, most frequent first. */
  readonly corrections: readonly CorrectionCount[];
  /** Times the coach said "Better". */
  readonly better: number;
  /** Times the coach said "That's it". */
  readonly keepIt: number;
  /** The engine's focus after the latest stroke of this type; null when none. */
  readonly focus: CorrectionId | null;
}

/**
 * Per stroke type: strokes counted, the corrections given, how often "Better"
 * and "That's it" were said, and the engine's current focus. Strokes from
 * before the coaching engine (no `coach`) count their stored fix cue as a
 * correction and have no focus. Records in recording order.
 */
export function sessionCoachSummary(records: readonly StrokeRecord[]): StrokeCoachSummary[] {
  return STROKE_TYPES.flatMap((strokeType): StrokeCoachSummary[] => {
    const own = records.filter((r) => r.metrics.strokeType === strokeType);
    if (own.length === 0) return [];
    const counts = new Map<CorrectionId, number>();
    let better = 0;
    let keepIt = 0;
    let focus: CorrectionId | null = null;
    for (const r of own) {
      if (r.coach) {
        focus = r.coach.focus;
        if (r.coach.utterance === 'better') better++;
        else if (r.coach.utterance === 'keep-it') keepIt++;
        else if (r.coach.utterance === 'correction' && r.coach.correctionId !== null) {
          counts.set(r.coach.correctionId, (counts.get(r.coach.correctionId) ?? 0) + 1);
        }
      } else if (r.cue.severity === 'fix' && isCorrectionId(r.cue.ruleId)) {
        counts.set(r.cue.ruleId, (counts.get(r.cue.ruleId) ?? 0) + 1);
      }
    }
    const corrections = [...counts.entries()]
      .map(([correctionId, count]) => ({ correctionId, count }))
      .sort((a, b) => b.count - a.count);
    return [{ strokeType, counted: own.length, corrections, better, keepIt, focus }];
  });
}
