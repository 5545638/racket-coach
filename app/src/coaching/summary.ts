import type { StrokeRecord, StrokeType } from '../domain/types';
import { wristHint } from './wrist';

export interface Statistic {
  readonly count: number;
  readonly mean: number;
  /** Sample standard deviation; a direct measure of consistency. */
  readonly sd: number;
}

export interface StrokeTypeSummary {
  readonly strokeType: StrokeType;
  readonly count: number;
  /** Share of rated strokes (excluding "no reading") that needed no correction. */
  readonly goodShare: number;
  readonly faceTiltDeg: Statistic | null;
  readonly swingPathDeg: Statistic | null;
  readonly headSpeedMps: Statistic | null;
  /** Share of strokes whose racket lag suggests a loose wrist; null when none qualify. */
  readonly looseWristShare: number | null;
  /** Most frequent correction, if any. */
  readonly topFault: { readonly text: string; readonly count: number } | null;
}

export function statistic(values: readonly number[]): Statistic | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.length > 1 ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1) : 0;
  return { count: values.length, mean, sd: Math.sqrt(variance) };
}

const present = (vs: readonly (number | null)[]): number[] =>
  vs.filter((v): v is number => v !== null);

export function summarize(records: readonly StrokeRecord[]): StrokeTypeSummary[] {
  const types: StrokeType[] = ['forehand', 'backhand', 'overhead'];
  return types
    .map((strokeType) => {
      const rs = records.filter((r) => r.metrics.strokeType === strokeType);
      const faults = new Map<string, number>();
      for (const r of rs) {
        if (r.cue.severity === 'fix') faults.set(r.cue.text, (faults.get(r.cue.text) ?? 0) + 1);
      }
      const top = [...faults.entries()].sort((a, b) => b[1] - a[1])[0];
      const hints = rs.map((r) => wristHint(r.metrics)).filter((h) => h !== null);
      // Slices have opposite face and path ideals; mixing them in would blur the averages.
      const drives = rs.filter((r) => r.metrics.swingStyle !== 'slice');
      const rated = rs.filter((r) => r.cue.severity !== 'none');
      return {
        strokeType,
        count: rs.length,
        goodShare: rated.length
          ? rated.filter((r) => r.cue.severity === 'good').length / rated.length
          : 0,
        faceTiltDeg: statistic(present(drives.map((r) => r.metrics.faceTiltDeg))),
        swingPathDeg: statistic(present(drives.map((r) => r.metrics.swingPathDeg))),
        headSpeedMps: statistic(
          drives
            .filter((r) => !r.metrics.quality.gyroSaturated && r.metrics.quality.signalGap !== true)
            .map((r) => r.metrics.headSpeedMps),
        ),
        looseWristShare: hints.length
          ? hints.filter((h) => h === 'loose').length / hints.length
          : null,
        topFault: top ? { text: top[0], count: top[1] } : null,
      };
    })
    .filter((s) => s.count > 0);
}
