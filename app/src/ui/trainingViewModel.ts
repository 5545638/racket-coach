import type { Language } from '../coaching/guidance';
import type { CoachMode, StrokeMetrics, StrokeRecord, StrokeType } from '../domain/types';
import type { StrokeAssessment } from '../elements/assess';
import { strings } from './strings';
import { trainingStrings } from './trainingStrings';
import type { Headline, MetricGroup } from './viewModel';

/**
 * View models of the training screen: status bar, stroke card, session strip,
 * details and banners, as plain data (tested without rendering).
 */

/* ---------------------------------------------------------- status bar */

export type BatteryLevel = 'ok' | 'low' | 'critical';

/** Below 20 % amber, below 10 % red. */
export const BATTERY_LOW_PERCENT = 20;
export const BATTERY_CRITICAL_PERCENT = 10;

export function batteryLevel(percent: number): BatteryLevel {
  if (percent < BATTERY_CRITICAL_PERCENT) return 'critical';
  if (percent < BATTERY_LOW_PERCENT) return 'low';
  return 'ok';
}

const NAME_MAX = 14;

/** Device names are long ("RacketCoach-A1B2C3"); keep the bar on one line. */
export function shortDeviceName(name: string | null, fallback: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return fallback;
  return trimmed.length > NAME_MAX ? `${trimmed.slice(0, NAME_MAX - 1)}…` : trimmed;
}

export interface StatusBarModel {
  readonly deviceName: string;
  readonly battery: {
    readonly percent: number;
    readonly text: string;
    readonly level: BatteryLevel;
    /** Fill of the icon, 0..1. */
    readonly fill: number;
    readonly aria: string;
  } | null;
  readonly modeLabel: string;
  readonly modes: readonly {
    readonly id: CoachMode;
    readonly label: string;
    readonly selected: boolean;
  }[];
  readonly modePickLabel: string;
  /** Null when this build has no mute control. */
  readonly mute: { readonly muted: boolean; readonly label: string } | null;
}

export function statusBarModel(input: {
  readonly deviceName: string | null;
  readonly fallbackName: string;
  readonly batteryPercent: number | null;
  readonly mode: CoachMode;
  /** Undefined: no mute control available. */
  readonly muted: boolean | undefined;
  readonly language: Language;
}): StatusBarModel {
  const t = trainingStrings(input.language);
  const percent =
    input.batteryPercent === null
      ? null
      : Math.max(0, Math.min(100, Math.round(input.batteryPercent)));
  const ids: readonly CoachMode[] = ['learning', 'training', 'match'];
  return {
    deviceName: shortDeviceName(input.deviceName, input.fallbackName),
    battery:
      percent === null
        ? null
        : {
            percent,
            text: `${percent}%`,
            level: batteryLevel(percent),
            fill: percent / 100,
            aria: t.battery(percent),
          },
    modeLabel: t.mode[input.mode],
    modes: ids.map((id) => ({ id, label: t.mode[id], selected: id === input.mode })),
    modePickLabel: t.mode.pick,
    mute:
      input.muted === undefined
        ? null
        : { muted: input.muted, label: input.muted ? t.unmute : t.mute },
  };
}

/* ---------------------------------------------------------- stroke card */

export type Verdict = 'good' | 'correction' | 'uncertain' | 'notRated';

/** How the latest stroke is rated, for the colour band. */
export function verdictOf(headline: Headline, assessment: StrokeAssessment | null): Verdict {
  switch (headline.kind) {
    case 'good':
    case 'better':
    case 'keep-it':
      return 'good';
    case 'correction':
    case 'overcorrected':
    case 'consistency':
    case 'stuck':
      return 'correction';
    case 'fatigue':
      return 'uncertain';
    case 'silent':
      if (!assessment || !assessment.contact) return 'notRated';
      return assessment.faults.length > 0 ? 'uncertain' : 'notRated';
  }
}

export type StrokeCardModel =
  | { readonly kind: 'empty'; readonly title: string; readonly hint: string }
  | {
      readonly kind: 'stroke';
      readonly strokeType: string;
      /** "slice" / "compact" qualifiers, or null. */
      readonly qualifier: string | null;
      readonly count: number;
      readonly verdict: Verdict;
      readonly verdictLabel: string;
      /** Headline title: the primary correction (Estonian) or Good / Better. */
      readonly title: string;
      /** Spoken English cue, only when it adds to the title. */
      readonly spoken: string | null;
      readonly detail: string | null;
      /** Positive feedback (Better / That's it / Good): drawn in green. */
      readonly positive: boolean;
    };

export function strokeCardModel(input: {
  readonly metrics: StrokeMetrics | null;
  readonly count: number;
  readonly headline: Headline | null;
  readonly assessment: StrokeAssessment | null;
  readonly language: Language;
}): StrokeCardModel {
  const tt = trainingStrings(input.language);
  const t = strings(input.language);
  const { metrics, headline } = input;
  if (!metrics || !headline) return { kind: 'empty', title: tt.empty.title, hint: tt.empty.hint };
  const verdict = verdictOf(headline, input.assessment);
  const qualifiers = [
    metrics.swingStyle === 'slice' ? t.slice : null,
    metrics.swingSize === 'compact' ? t.compact : null,
  ].filter((q): q is string => q !== null);
  return {
    kind: 'stroke',
    strokeType: tt.strokeType[metrics.strokeType],
    qualifier: qualifiers.length > 0 ? qualifiers.join(' · ') : null,
    count: input.count,
    verdict,
    verdictLabel: tt.verdict[verdict],
    title: headline.title,
    spoken: headline.spoken && headline.spoken !== headline.title ? headline.spoken : null,
    detail: headline.detail,
    positive: headline.tone === 'good',
  };
}

/** Why / change / drill: open in learning mode, behind a toggle in training, absent in match. */
export type GuidanceDisplay = 'open' | 'collapsible' | 'none';

export function guidanceDisplay(mode: CoachMode): GuidanceDisplay {
  return mode === 'learning' ? 'open' : mode === 'training' ? 'collapsible' : 'none';
}

/* ---------------------------------------------------------- session strip */

export interface SessionStripModel {
  readonly counts: Readonly<Record<StrokeType, number>>;
  /** "≈ 92 km/h" of the latest stroke, "—" when it had no contact. */
  readonly last: string;
  /** Mean over strokes with contact. */
  readonly average: string;
  /** Share of rated strokes that were good, "—" before any. */
  readonly goodShare: string;
  /** Whole percent, or null. */
  readonly goodPercent: number | null;
}

const DASH = '—';
const speedText = (mps: number, lowerBound = false): string =>
  `≈ ${lowerBound ? '≥' : ''}${Math.round(mps * 3.6)} km/h`;

const isGood = (r: StrokeRecord): boolean =>
  r.coach
    ? r.coach.utterance === 'good' ||
      r.coach.utterance === 'better' ||
      r.coach.utterance === 'keep-it'
    : r.cue.severity === 'good';

export function sessionStripModel(strokes: readonly StrokeRecord[]): SessionStripModel {
  const counts: Record<StrokeType, number> = { forehand: 0, backhand: 0, overhead: 0 };
  for (const s of strokes) counts[s.metrics.strokeType]++;
  const rated = strokes.filter((s) => s.metrics.impactDetected);
  const last = strokes.at(-1);
  const speeds = rated.map((s) => s.metrics.headSpeedMps).filter((v) => v > 0);
  const mean = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
  const goodPercent =
    rated.length > 0 ? Math.round((rated.filter(isGood).length / rated.length) * 100) : null;
  return {
    counts,
    last:
      last && last.metrics.impactDetected && last.metrics.headSpeedMps > 0
        ? speedText(last.metrics.headSpeedMps, last.metrics.quality.gyroSaturated)
        : DASH,
    average: mean === null ? DASH : speedText(mean),
    goodShare: goodPercent === null ? DASH : `${goodPercent}%`,
    goodPercent,
  };
}

/* ---------------------------------------------------------------- details */

export interface DetailsModel {
  readonly groups: readonly MetricGroup[];
  /** The "no reference yet" caption, shown once; null when no row needs it. */
  readonly baselineNote: string | null;
}

/** Removes the repeated "no reference yet" caption of the rows and returns it once. */
export function detailsModel(groups: readonly MetricGroup[], language: Language): DetailsModel {
  const caption = strings(language).reason['no-baseline'];
  const cleaned = groups.map((g) => ({
    ...g,
    rows: g.rows.map((r) => {
      if (r.note !== caption) return r;
      return { ...r, note: null };
    }),
  }));
  return {
    groups: cleaned,
    baselineNote: groups.some((g) => g.rows.some((r) => r.note === caption)) ? caption : null,
  };
}

/* ----------------------------------------------------------------- banners */

export type BannerKind = 'calibrate' | 'temperature';

export function bannerModels(input: {
  readonly connected: boolean;
  readonly calibrated: boolean;
  readonly temperatureWarning: boolean;
  readonly language: Language;
}): readonly { readonly kind: BannerKind; readonly text: string }[] {
  const t = strings(input.language);
  const out: { kind: BannerKind; text: string }[] = [];
  if (input.connected && !input.calibrated) out.push({ kind: 'calibrate', text: t.calibrateFirst });
  if (input.temperatureWarning) out.push({ kind: 'temperature', text: t.setup.temperatureChanged });
  return out;
}
