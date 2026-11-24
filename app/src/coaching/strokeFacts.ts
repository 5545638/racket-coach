import type { DeviationCategory, StrokeRecord } from '../domain/types';
import { ELEMENT_CATALOG } from '../elements/catalog';
import { type CorrectionId, CORRECTIONS } from './corrections';

/**
 * What one stroke contributes to a session report (docs/metrics.md, "Session
 * report"). Pure; everything is derived from the stored record, so reports can
 * be rebuilt for any past session.
 */

/**
 * The single overall reading of a stroke. Every stroke gets exactly one, so
 * the counts add up to the number of strokes (not of elements):
 *
 * 1. `correction`: the coach spoke a correction on this stroke;
 * 2. `fatigue`: no correction was spoken, there are faults and all of them
 *    came while the fatigue detector was active;
 * 3. `fault-silent`: at least one fault that was not spoken (a silenced
 *    repeat, match mode, a lower-priority fault);
 * 4. `uncertain`: no fault, but at least one element outside its band that
 *    the measurement cannot confirm, or whose σ is too large;
 * 5. `style`: everything judged lies inside the band (the player's own style);
 * 6. `not-assessable`: nothing could be judged on the stroke.
 *
 * Strokes recorded before the adaptive coach have no categories: their stored
 * cue decides (fix → `correction`, good → `style`, none → `not-assessable`).
 */
export type StrokeVerdict =
  'correction' | 'fault-silent' | 'style' | 'uncertain' | 'not-assessable' | 'fatigue';

export const VERDICT_ORDER: readonly StrokeVerdict[] = [
  'correction',
  'fault-silent',
  'style',
  'uncertain',
  'not-assessable',
  'fatigue',
];

const categoriesOf = (r: StrokeRecord): readonly DeviationCategory[] | null => {
  const byElement = r.coach?.categories?.byElement;
  return byElement ? Object.values(byElement) : null;
};

export function strokeVerdict(r: StrokeRecord): StrokeVerdict {
  const cats = categoriesOf(r);
  const spoken = r.coach ? r.coach.utterance === 'correction' : r.cue.severity === 'fix';
  if (spoken) return 'correction';
  if (cats === null) return r.cue.severity === 'good' ? 'style' : 'not-assessable';
  const has = (c: DeviationCategory): boolean => cats.includes(c);
  if (has('technical-error')) return 'fault-silent';
  if (has('fatigue-related')) return 'fatigue';
  if (has('uncertain')) return 'uncertain';
  if (has('variation') || has('improvement')) return 'style';
  return 'not-assessable';
}

export function verdictCounts(records: readonly StrokeRecord[]): Record<StrokeVerdict, number> {
  const out: Record<StrokeVerdict, number> = {
    correction: 0,
    'fault-silent': 0,
    style: 0,
    uncertain: 0,
    'not-assessable': 0,
    fatigue: 0,
  };
  for (const r of records) out[strokeVerdict(r)]++;
  return out;
}

/* ------------------------------------------------------------- per correction */

let correctionByKey: ReadonlyMap<string, CorrectionId> | null = null;
const correctionOfKey = (key: string): CorrectionId | undefined => {
  correctionByKey ??= new Map(ELEMENT_CATALOG.map((s) => [s.key, s.correctionId]));
  return correctionByKey.get(key);
};

const isCorrectionId = (id: string): id is CorrectionId =>
  Object.prototype.hasOwnProperty.call(CORRECTIONS.en, id);

/** Per-correction reading of one stroke. */
export interface StrokeFacts {
  /** Corrections judged on the stroke (inside the band or at fault). */
  readonly assessed: ReadonlySet<CorrectionId>;
  /** Corrections at fault (technical or fatigue-related). */
  readonly faults: ReadonlySet<CorrectionId>;
  /** Corrections judged and clearly inside the band. */
  readonly inBand: ReadonlySet<CorrectionId>;
  /**
   * An older record whose only verdict is its cue: it counts as judged on
   * every correction (denominator) and at fault on the cue's one.
   */
  readonly legacyRated: boolean;
}

const NONE: ReadonlySet<CorrectionId> = new Set();

export function strokeFacts(r: StrokeRecord): StrokeFacts {
  const byElement = r.coach?.categories?.byElement;
  if (!byElement) {
    if (r.cue.severity === 'none') {
      return { assessed: NONE, faults: NONE, inBand: NONE, legacyRated: false };
    }
    const fault = r.cue.severity === 'fix' && isCorrectionId(r.cue.ruleId);
    return {
      assessed: NONE,
      faults: fault ? new Set([r.cue.ruleId]) : NONE,
      inBand: NONE,
      legacyRated: true,
    };
  }
  const assessed = new Set<CorrectionId>();
  const faults = new Set<CorrectionId>();
  const outside = new Set<CorrectionId>();
  for (const [key, category] of Object.entries(byElement)) {
    const id = correctionOfKey(key);
    if (id === undefined || category === 'not-assessable') continue;
    assessed.add(id);
    if (category === 'technical-error' || category === 'fatigue-related') faults.add(id);
    else if (category === 'uncertain') outside.add(id);
  }
  const inBand = new Set([...assessed].filter((id) => !faults.has(id) && !outside.has(id)));
  return { assessed, faults, inBand, legacyRated: false };
}

export interface CorrectionTally {
  readonly correctionId: CorrectionId;
  /** Strokes on which the correction was judged. */
  readonly assessed: number;
  readonly faults: number;
  readonly inBand: number;
}

/** Judged / fault / in-band stroke counts per correction. */
export function tallyCorrections(records: readonly StrokeRecord[]): CorrectionTally[] {
  const acc = new Map<CorrectionId, { assessed: number; faults: number; inBand: number }>();
  let legacy = 0;
  const entry = (id: CorrectionId) => {
    let e = acc.get(id);
    if (!e) {
      e = { assessed: 0, faults: 0, inBand: 0 };
      acc.set(id, e);
    }
    return e;
  };
  for (const r of records) {
    const f = strokeFacts(r);
    if (f.legacyRated) legacy++;
    for (const id of f.assessed) entry(id).assessed++;
    for (const id of f.faults) entry(id).faults++;
    for (const id of f.inBand) entry(id).inBand++;
  }
  return [...acc.entries()].map(([correctionId, e]) => ({
    correctionId,
    assessed: e.assessed + legacy,
    faults: e.faults,
    inBand: e.inBand,
  }));
}

/** Fault rate (0–1) of a tally; null when judged on fewer than `minStrokes`. */
export const faultRate = (t: CorrectionTally | undefined, minStrokes: number): number | null =>
  t && t.assessed >= minStrokes ? t.faults / t.assessed : null;
