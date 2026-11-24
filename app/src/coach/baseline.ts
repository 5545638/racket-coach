import type { StrokeMetrics, StrokeRecord, StrokeType } from '../domain/types';
import { ELEMENT_CATALOG, type ElementSpec, applicability } from '../elements/catalog';
import { MAD_TO_SIGMA, median, medianAbsoluteDeviation } from '../math/stats';

/**
 * Personal baseline: the player's own usual value of every element metric,
 * per stroke type × swing style × swing size. See docs/metrics.md,
 * "Coaching engine".
 */
export interface BaselineConfig {
  /** Values kept per key (newest first). */
  readonly windowSize: number;
  /** A key's baseline is used from this many values on. */
  readonly minStrokes: number;
}

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = { windowSize: 60, minStrokes: 15 };

/** How many recent strokes the controller loads to build the baseline at session start. */
export const BASELINE_LOAD_LIMIT = 600;

export interface BaselineEntry {
  /** Up to `windowSize` values, newest first. */
  readonly values: readonly number[];
  readonly n: number;
  /** Median m of the values. */
  readonly median: number;
  /** s = max(1.4826 · MAD, s_min), in the value's unit. */
  readonly spread: number;
  /** n ≥ `minStrokes`. */
  readonly active: boolean;
}

export interface PersonalBaseline {
  /** Keyed by `baselineKey(...)`. */
  readonly entries: Readonly<Record<string, BaselineEntry>>;
  /** Strokes with ball contact that went into the baseline, per stroke type. */
  readonly strokeCounts: Readonly<Record<StrokeType, number>>;
}

export const EMPTY_BASELINE: PersonalBaseline = {
  entries: {},
  strokeCounts: { forehand: 0, backhand: 0, overhead: 0 },
};

/**
 * Selects the strokes that may enter the baseline. Hook for future outcome
 * tags (e.g. only strokes that landed in); by default every stroke counts.
 */
export type BaselineFilter = (record: StrokeRecord) => boolean;

/** Style part of a key: elements without a style restriction share one baseline. */
const styleKey = (spec: ElementSpec, m: StrokeMetrics): string =>
  spec.styles === null ? 'any' : (m.swingStyle ?? 'unknown');

export const baselineKey = (
  strokeType: StrokeType,
  style: string,
  swingSize: string,
  metric: string,
): string => `${strokeType}|${style}|${swingSize}|${metric}`;

/** The baseline key of `spec` for a stroke, or null when the element does not apply. */
export function baselineKeyFor(spec: ElementSpec, m: StrokeMetrics): string | null {
  if (applicability(spec, m) !== null) return null;
  return baselineKey(m.strokeType, styleKey(spec, m), m.swingSize, spec.metric);
}

/** The baseline entry for `spec` on a stroke like `m`, active or not; null when none. */
export function lookupBaseline(
  baseline: PersonalBaseline,
  spec: ElementSpec,
  m: StrokeMetrics,
): BaselineEntry | null {
  const key = baselineKeyFor(spec, m);
  return key === null ? null : (baseline.entries[key] ?? null);
}

/**
 * The value `spec` contributes from a stored stroke, or null. Only strokes
 * with ball contact count, and only values that could be assessed: present,
 * not a bound, and computed by an analysis version whose definition of the
 * value is current. Records older than version 3 have no features and so
 * contribute only the metrics they have. Faulty strokes are not excluded: the
 * median is robust to a minority of faults, and excluding them would pull the
 * baseline towards whatever the current band happens to be.
 */
export function contribution(spec: ElementSpec, record: StrokeRecord): number | null {
  const m = record.metrics;
  if (!m.impactDetected || m.quality.signalGap === true) return null;
  if (applicability(spec, m) !== null) return null;
  if (spec.minAnalysisVersion !== undefined) {
    if ((record.analysisVersion ?? 1) < spec.minAnalysisVersion) return null;
  }
  if (spec.unavailable?.(m)) return null;
  const value = spec.value(m);
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // A value without a finite σ cannot be assessed, so it must not shape the baseline.
  const sigma = spec.sigma(m);
  return typeof sigma === 'number' && Number.isFinite(sigma) ? value : null;
}

function entryFrom(values: readonly number[], sMin: number, config: BaselineConfig): BaselineEntry {
  const m = median(values);
  return {
    values,
    n: values.length,
    median: m,
    spread: Math.max(MAD_TO_SIGMA * medianAbsoluteDeviation(values, m), sMin),
    active: values.length >= config.minStrokes,
  };
}

/** Adds one stroke (the newest) to the baseline. Pure. */
export function addStrokeToBaseline(
  baseline: PersonalBaseline,
  record: StrokeRecord,
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
  catalog: readonly ElementSpec[] = ELEMENT_CATALOG,
): PersonalBaseline {
  const m = record.metrics;
  if (!m.impactDetected || m.quality.signalGap === true) return baseline;
  const entries: Record<string, BaselineEntry> = { ...baseline.entries };
  const done = new Set<string>();
  for (const spec of catalog) {
    const key = baselineKeyFor(spec, m);
    if (key === null || done.has(key)) continue;
    const value = contribution(spec, record);
    if (value === null) continue;
    done.add(key);
    const previous = entries[key]?.values ?? [];
    entries[key] = entryFrom([value, ...previous].slice(0, config.windowSize), spec.sMin, config);
  }
  return {
    entries,
    strokeCounts: {
      ...baseline.strokeCounts,
      [m.strokeType]: baseline.strokeCounts[m.strokeType] + 1,
    },
  };
}

const receivedAt = (r: StrokeRecord): number => {
  const t: unknown = r.capture.receivedAt;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
};

/**
 * Builds the baseline from stored strokes (any order; current and previous
 * sessions). The newest `windowSize` values per key are kept.
 */
export function buildBaseline(
  records: readonly StrokeRecord[],
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
  filter: BaselineFilter = () => true,
  catalog: readonly ElementSpec[] = ELEMENT_CATALOG,
): PersonalBaseline {
  const oldestFirst = records.filter(filter).sort((a, b) => receivedAt(a) - receivedAt(b));
  return oldestFirst.reduce(
    (acc, record) => addStrokeToBaseline(acc, record, config, catalog),
    EMPTY_BASELINE,
  );
}
