import { CORRECTIONS, type CorrectionId } from '../coaching/corrections';
import type { Language } from '../coaching/guidance';
import type { StrokeType } from '../domain/types';
import { weaknessLabel } from '../coach/phrases';
import type { SessionHistory } from './historyModel';
import { reportStrings } from './reportStrings';

/** Chart specs of the history section: labels, series, tap read-outs and aria text. */

export const SERIES_COLOR: Readonly<Record<StrokeType, string>> = {
  forehand: 'var(--c-forehand)',
  backhand: 'var(--c-backhand)',
  overhead: 'var(--c-serve)',
};

const TYPES: readonly StrokeType[] = ['forehand', 'backhand', 'overhead'];
const KMH = 3.6;

export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly values: readonly (number | null)[];
}

export interface ChartSpec {
  readonly id: string;
  readonly title: string;
  readonly labels: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly yMin: number;
  readonly yMax: number;
  /** Text for the tapped session (index into `labels`). */
  readonly readout: (index: number) => string;
  readonly aria: string;
  /** Short unit appended to axis numbers ("%"), or empty. */
  readonly unit: string;
  /** Axis intervals; every tick is a whole number. */
  readonly ticks: number;
}

export interface HistoryView {
  readonly empty: boolean;
  readonly strokes: ChartSpec;
  readonly speed: ChartSpec;
  readonly consistency: ChartSpec;
  readonly faults: readonly ChartSpec[];
}

const listAria = (labels: readonly string[], texts: readonly string[]): string =>
  labels.map((l, i) => `${l}: ${texts[i] ?? ''}`).join('; ');

/** A y range that frames the values with some air, in steps of 20. */
export function speedRange(valuesKmh: readonly number[]): { min: number; max: number } {
  if (valuesKmh.length === 0) return { min: 0, max: 100 };
  const lo = Math.floor((Math.min(...valuesKmh) - 5) / 20) * 20;
  const hi = Math.ceil((Math.max(...valuesKmh) + 5) / 20) * 20;
  const min = Math.max(0, lo);
  return { min, max: Math.max(hi, min + 20) };
}

export function historyView(history: SessionHistory, language: Language): HistoryView {
  const r = reportStrings(language);
  const sessions = history.sessions;
  const labels = sessions.map((s) => s.label);
  const typeName: Record<StrokeType, string> = r.totals;

  /* strokes per session */
  const strokeSeries: ChartSeries[] = TYPES.map((type) => ({
    id: type,
    label: typeName[type],
    color: SERIES_COLOR[type],
    values: sessions.map((s) => s.byType[type]),
  }));
  const strokesTexts = sessions.map(
    (s) =>
      `${s.total} ${r.strokesWord}` +
      TYPES.filter((ty) => s.byType[ty] > 0)
        .map((ty) => ` · ${typeName[ty]} ${s.byType[ty]}`)
        .join(''),
  );
  const strokes: ChartSpec = {
    id: 'strokes',
    title: r.strokesChart,
    labels,
    series: strokeSeries,
    yMin: 0,
    yMax: Math.max(20, Math.ceil(Math.max(0, ...sessions.map((s) => s.total)) / 20) * 20),
    readout: (i) => `${labels[i]} · ${strokesTexts[i]}`,
    aria: r.chartAria(r.strokesChart, listAria(labels, strokesTexts)),
    unit: '',
    ticks: 4,
  };

  /* speed */
  const speedKmh = (i: number, type: StrokeType): number | null => {
    const p = sessions[i]?.speed[type];
    return p ? p.meanMps * KMH : null;
  };
  const speedSeries: ChartSeries[] = TYPES.map((type) => ({
    id: type,
    label: typeName[type],
    color: SERIES_COLOR[type],
    values: sessions.map((_, i) => speedKmh(i, type)),
  })).filter((s) => s.values.some((v) => v !== null));
  const range = speedRange(
    speedSeries.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const speedText = (i: number): string => {
    const parts = TYPES.flatMap((type) => {
      const p = sessions[i]?.speed[type];
      return p
        ? [
            `${typeName[type]} ${p.lowerBound ? '≥' : ''}${Math.round(p.meanMps * KMH)} ${r.speedUnit}`,
          ]
        : [];
    });
    return parts.length ? parts.join(' · ') : r.noData;
  };
  const speed: ChartSpec = {
    id: 'speed',
    title: `${r.speedChart}, ${r.speedUnit}`,
    labels,
    series: speedSeries,
    yMin: range.min,
    yMax: range.max,
    readout: (i) => `${labels[i]} · ${speedText(i)}`,
    aria: r.chartAria(
      r.speedChart,
      listAria(
        labels,
        sessions.map((_, i) => speedText(i)),
      ),
    ),
    unit: '',
    ticks: Math.round((range.max - range.min) / 20),
  };

  /* consistency */
  const cText = (i: number): string => {
    const c = sessions[i]?.consistency;
    return c === null || c === undefined ? r.noData : `${Math.round(c)} / 100`;
  };
  const consistency: ChartSpec = {
    id: 'consistency',
    title: r.consistencyChart,
    labels,
    series: [
      {
        id: 'consistency',
        label: r.consistencyTitle,
        color: 'var(--accent)',
        values: sessions.map((s) => (s.consistency === null ? null : Math.round(s.consistency))),
      },
    ],
    yMin: 0,
    yMax: 100,
    readout: (i) => `${labels[i]} · ${cText(i)}`,
    aria: r.chartAria(
      r.consistencyChart,
      listAria(
        labels,
        sessions.map((_, i) => cText(i)),
      ),
    ),
    unit: '',
    ticks: 4,
  };

  /* fault rate of the top weaknesses (small multiples) */
  const faults = history.weaknesses.map((id: CorrectionId): ChartSpec => {
    const title = weaknessLabel(id, language);
    const rates = sessions.map((s) => {
      const v = s.faultRates[id];
      return v === null || v === undefined ? null : Math.round(v * 100);
    });
    const text = (i: number): string => (rates[i] === null ? r.noData : `${rates[i]}%`);
    const max = Math.min(
      100,
      Math.max(20, Math.ceil(Math.max(0, ...rates.map((v) => v ?? 0)) / 20) * 20),
    );
    return {
      id: `fault-${id}`,
      title: `${title} (${r.faultRate})`,
      labels,
      series: [{ id, label: CORRECTIONS[language][id].title, color: 'var(--fix)', values: rates }],
      yMin: 0,
      yMax: max,
      readout: (i) => `${labels[i]} · ${text(i)}`,
      aria: r.chartAria(
        title,
        listAria(
          labels,
          sessions.map((_, i) => text(i)),
        ),
      ),
      unit: '%',
      ticks: 2,
    };
  });

  return { empty: sessions.length === 0, strokes, speed, consistency, faults };
}
