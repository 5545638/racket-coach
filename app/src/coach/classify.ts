import type { CorrectionId } from '../coaching/corrections';
import type { DeviationCategory, StrokeCategories } from '../domain/types';
import type { ElementAssessment, StrokeAssessment } from '../elements/assess';

/**
 * Per-stroke reading of every assessed element (docs/metrics.md, "Adaptive
 * coach"). Pure. Elements that do not apply to the stroke ('wrong-stroke')
 * are left out.
 */
export interface ClassifyContext {
  /** The fatigue detector was active for this stroke type. */
  readonly fatigueActive: boolean;
  /** Focus of the stroke type before this stroke. */
  readonly focusBefore: CorrectionId | null;
  /** The coach found a significant improvement of the focus on this stroke ("Better"). */
  readonly improved: boolean;
}

export const EMPTY_COUNTS: Readonly<Record<DeviationCategory, number>> = {
  'technical-error': 0,
  uncertain: 0,
  variation: 0,
  'not-assessable': 0,
  'fatigue-related': 0,
  improvement: 0,
};

/**
 * σ "large relative to the band": larger than the spread s the band is
 * scaled by, with the value less than σ inside the bound. Such a value cannot
 * be told apart from a fault. Engineering choice.
 */
function sigmaTooLarge(e: ElementAssessment): boolean {
  if (e.sigma === null || e.band === null) return false;
  const bound = e.direction === 'below' ? e.band.lo : e.band.hi;
  if (bound === null || e.value === null) return false;
  const margin = Math.abs(e.value - bound);
  return e.sigma > e.spread && margin < e.sigma;
}

/** The category of one element. */
export function classifyElement(e: ElementAssessment, ctx: ClassifyContext): DeviationCategory {
  if (e.status === 'not-assessable') return 'not-assessable';
  const isFocus = ctx.focusBefore !== null && e.correctionId === ctx.focusBefore;
  if (e.status === 'fault') {
    if (isFocus && ctx.improved) return 'improvement';
    return ctx.fatigueActive ? 'fatigue-related' : 'technical-error';
  }
  if (e.distance > 0 || sigmaTooLarge(e)) return 'uncertain';
  // Back inside the band after being the focus.
  if (isFocus) return 'improvement';
  return 'variation';
}

/** Category of every applicable element of a stroke, and the counts. */
export function classifyStroke(
  assessment: StrokeAssessment,
  ctx: ClassifyContext,
): StrokeCategories {
  const counts: Record<DeviationCategory, number> = { ...EMPTY_COUNTS };
  const byElement: Record<string, DeviationCategory> = {};
  for (const e of assessment.elements) {
    if (e.reason === 'wrong-stroke') continue;
    const category = classifyElement(e, ctx);
    byElement[e.key] = category;
    counts[category]++;
  }
  return { counts, byElement };
}
