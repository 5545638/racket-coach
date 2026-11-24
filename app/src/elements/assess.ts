import type { CorrectionId } from '../coaching/corrections';
import { type PersonalBaseline, lookupBaseline } from '../coach/baseline';
import type { StrokeMetrics, StrokeType, SwingSize, SwingStyle } from '../domain/types';
import { normalCdf } from '../math/stats';
import {
  ELEMENT_CATALOG,
  type ElementDirection,
  type ElementSpec,
  type NotAssessableReason,
  applicability,
} from './catalog';

export interface AssessConfig {
  /** A deviation is a fault only when P(outside the band) ≥ pMin. */
  readonly pMin: number;
  /** Personal band half-width in units of the spread s. */
  readonly k: number;
}

export const DEFAULT_ASSESS_CONFIG: AssessConfig = { pMin: 0.8, k: 2 };

export type ElementStatus = 'ok' | 'fault' | 'not-assessable';
export type BandSource = 'population' | 'personal' | 'combined';

/** Allowed values; null = unbounded on that side (every element is one-sided). */
export interface Band {
  readonly lo: number | null;
  readonly hi: number | null;
}

export interface ElementAssessment {
  readonly key: string;
  readonly correctionId: CorrectionId;
  readonly metric: string;
  readonly direction: ElementDirection;
  readonly weight: number;
  readonly status: ElementStatus;
  /** Set exactly when `status === 'not-assessable'`. */
  readonly reason: NotAssessableReason | null;
  readonly value: number | null;
  readonly sigma: number | null;
  /** The band actually used; null when not assessable. */
  readonly band: Band | null;
  readonly bandSource: BandSource | null;
  /** Personal median and spread when an active baseline exists. */
  readonly personal: {
    readonly median: number;
    readonly spread: number;
    readonly n: number;
  } | null;
  /** Spread s the score is scaled by: the personal spread, else s_min (0 when not assessable). */
  readonly spread: number;
  /** Distance d ≥ 0 outside the band (0 inside or when not assessable). */
  readonly distance: number;
  /** p = Φ(d/σ): probability that the true value lies outside the band (0 when not assessable). */
  readonly probability: number;
  /** w · min(d/s, 3) · p; 0 unless the element is a fault. */
  readonly score: number;
}

export interface StrokeAssessment {
  readonly strokeType: StrokeType;
  readonly swingStyle: SwingStyle | null;
  readonly swingSize: SwingSize;
  /** Ball contact detected; without it every element is not assessable. */
  readonly contact: boolean;
  /** One entry per catalogue element, in catalogue order. */
  readonly elements: readonly ElementAssessment[];
  /** The faults, highest score first. */
  readonly faults: readonly ElementAssessment[];
}

/** Largest d/s that still raises the score: beyond 3 s a fault is simply "big". */
const MAX_SPREADS = 3;

/** Φ(d/σ) with the degenerate σ = 0 handled. */
function probabilityOutside(distance: number, sigma: number): number {
  if (sigma > 0) return normalCdf(distance / sigma);
  return distance > 0 ? 1 : 0.5;
}

function notAssessable(
  spec: ElementSpec,
  reason: NotAssessableReason,
  value: number | null = null,
  sigma: number | null = null,
): ElementAssessment {
  return {
    key: spec.key,
    correctionId: spec.correctionId,
    metric: spec.metric,
    direction: spec.direction,
    weight: spec.weight,
    status: 'not-assessable',
    reason,
    value,
    sigma,
    band: null,
    bandSource: null,
    personal: null,
    spread: 0,
    distance: 0,
    probability: 0,
    score: 0,
  };
}

/**
 * The bound on the fault side and where it came from.
 *
 * - No active baseline: the population limit P (none → not assessable).
 * - Baseline, no P: m ∓ k·s.
 * - Baseline and P: the tighter of the two, unless the personal median itself
 *   is beyond P (a habitual clear fault), in which case P alone is used.
 * - `populationOnly` elements (player-profile style relaxations): P alone.
 */
function faultBound(
  spec: ElementSpec,
  population: number | null,
  personal: { readonly median: number; readonly spread: number } | null,
  k: number,
): { readonly bound: number; readonly source: BandSource } | null {
  if (spec.populationOnly === true && population !== null) {
    return { bound: population, source: 'population' };
  }
  if (personal === null) {
    return population === null ? null : { bound: population, source: 'population' };
  }
  const below = spec.direction === 'below';
  const own = below ? personal.median - k * personal.spread : personal.median + k * personal.spread;
  if (population === null) return { bound: own, source: 'personal' };
  const medianBeyondP = below ? personal.median < population : personal.median > population;
  if (medianBeyondP) return { bound: population, source: 'population' };
  return {
    bound: below ? Math.max(population, own) : Math.min(population, own),
    source: 'combined',
  };
}

function assessElement(
  spec: ElementSpec,
  m: StrokeMetrics,
  baseline: PersonalBaseline,
  config: AssessConfig,
): ElementAssessment {
  // Missing data first: it can also hide the contact itself.
  if (m.quality.signalGap === true) return notAssessable(spec, 'signal-gap');
  if (!m.impactDetected) return notAssessable(spec, 'no-contact');
  const applies = applicability(spec, m);
  if (applies !== null) return notAssessable(spec, applies);
  const value = spec.value(m);
  if (value === null || !Number.isFinite(value)) return notAssessable(spec, 'no-value');
  const sigma = spec.sigma(m);
  const blocked = spec.unavailable?.(m) ?? null;
  if (blocked !== null) return notAssessable(spec, blocked, value, sigma);
  if (sigma === null || !Number.isFinite(sigma)) return notAssessable(spec, 'no-sigma', value);

  const entry = lookupBaseline(baseline, spec, m);
  const personal = entry?.active
    ? { median: entry.median, spread: entry.spread, n: entry.n }
    : null;
  const population =
    m.strokeType === 'backhand' && !spec.backhandPopulation ? null : spec.populationLimit;
  const limit = faultBound(spec, population, personal, config.k);
  if (limit === null) return notAssessable(spec, 'no-baseline', value, sigma);

  const below = spec.direction === 'below';
  const band: Band = below ? { lo: limit.bound, hi: null } : { lo: null, hi: limit.bound };
  const distance = Math.max(0, below ? limit.bound - value : value - limit.bound);
  const probability = probabilityOutside(distance, sigma);
  const spread = personal?.spread ?? spec.sMin;
  const fault = distance > 0 && probability >= config.pMin;
  return {
    key: spec.key,
    correctionId: spec.correctionId,
    metric: spec.metric,
    direction: spec.direction,
    weight: spec.weight,
    status: fault ? 'fault' : 'ok',
    reason: null,
    value,
    sigma,
    band,
    bandSource: limit.source,
    personal,
    spread,
    distance,
    probability,
    score: fault ? spec.weight * Math.min(distance / spread, MAX_SPREADS) * probability : 0,
  };
}

/**
 * Judges every catalogue element on one stroke against the population limit
 * and the player's own baseline. Pure.
 */
export function assessStroke(
  metrics: StrokeMetrics,
  baseline: PersonalBaseline,
  config: AssessConfig = DEFAULT_ASSESS_CONFIG,
  catalog: readonly ElementSpec[] = ELEMENT_CATALOG,
): StrokeAssessment {
  const elements = catalog.map((spec) => assessElement(spec, metrics, baseline, config));
  return {
    strokeType: metrics.strokeType,
    swingStyle: metrics.swingStyle,
    swingSize: metrics.swingSize,
    contact: metrics.impactDetected,
    elements,
    faults: elements.filter((e) => e.status === 'fault').sort((a, b) => b.score - a.score),
  };
}

/** Per correction: the fault with the highest score, else an ok entry, else a not-assessable one. */
export type CorrectionAssessment = ElementAssessment;

/**
 * Collapses elements that share a correction (e.g. the two hitch measures)
 * into one verdict per correction. Elements that do not apply to the stroke
 * ('wrong-stroke') are left out.
 */
export function byCorrection(
  assessment: StrokeAssessment,
): ReadonlyMap<CorrectionId, CorrectionAssessment> {
  const rank = (e: ElementAssessment): number =>
    e.status === 'fault' ? 2 + e.score : e.status === 'ok' ? 1 : 0;
  const out = new Map<CorrectionId, CorrectionAssessment>();
  for (const e of assessment.elements) {
    if (e.reason === 'wrong-stroke') continue;
    const current = out.get(e.correctionId);
    if (!current || rank(e) > rank(current)) out.set(e.correctionId, e);
  }
  return out;
}
