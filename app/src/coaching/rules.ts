import type { Cue, StrokeMetrics, StrokeType, SwingSize, SwingStyle } from '../domain/types';

/** Metrics a rule may test. Restricted to numeric, possibly-null fields. */
export type RuleMetric =
  | 'faceTiltDeg'
  | 'swingPathDeg'
  | 'headSpeedMps'
  | 'peakSpeedOffsetMs'
  | 'preparationTimeMs'
  | 'backswingPauseMs'
  | 'racketDropDeg'
  | 'faceAtDropDeg'
  | 'peakAccelerationOffsetMs'
  | 'forwardSwingArcDeg'
  | 'followThroughArcDeg';

export interface CoachingRule {
  readonly id: string;
  readonly metric: RuleMetric;
  /** Rule fires when the value is strictly above this bound. */
  readonly above?: number;
  /** Rule fires when the value is strictly below this bound. */
  readonly below?: number;
  readonly strokes: readonly StrokeType[];
  readonly swingSizes: readonly SwingSize[];
  /** Drives and slices have opposite ideals, so every rule names its style(s). */
  readonly styles: readonly SwingStyle[];
  /** Higher fires first; only one cue is given per stroke. */
  readonly priority: number;
  /** Short phrase spoken to the player. */
  readonly cue: string;
  /** Where the threshold comes from: a citation, or "heuristic" until validated. */
  readonly source: string;
}

export interface RuleSet {
  readonly version: 1;
  readonly goodCue: string;
  readonly rules: readonly CoachingRule[];
}

export interface RuleViolation {
  readonly rule: CoachingRule;
  readonly value: number;
}

export interface RuleEvaluation {
  /** Rules that fired, highest priority first. */
  readonly violations: RuleViolation[];
  /** Applicable rules that could not be checked because their metric was unavailable. */
  readonly unchecked: CoachingRule[];
}

export const NO_READING_CUE: Cue = { ruleId: 'no-reading', severity: 'none', text: 'No reading' };
/** Strokes the app counts but has no reference values to judge (serve, smash, volley). */
export const NOT_RATED_CUE: Cue = { ruleId: 'not-rated', severity: 'none', text: 'Counted' };

export function evaluateRules(metrics: StrokeMetrics, ruleSet: RuleSet): RuleEvaluation {
  const violations: RuleViolation[] = [];
  const unchecked: CoachingRule[] = [];
  for (const rule of ruleSet.rules) {
    if (!rule.strokes.includes(metrics.strokeType)) continue;
    if (!rule.swingSizes.includes(metrics.swingSize)) continue;
    if (metrics.swingStyle === null) {
      unchecked.push(rule); // drive or slice unknown: cannot pick the right ideal
      continue;
    }
    if (!rule.styles.includes(metrics.swingStyle)) continue;
    const value =
      rule.metric === 'headSpeedMps' && metrics.quality.gyroSaturated ? null : metrics[rule.metric];
    if (value === null) {
      unchecked.push(rule);
      continue;
    }
    const fires =
      (rule.above !== undefined && value > rule.above) ||
      (rule.below !== undefined && value < rule.below);
    if (fires) violations.push({ rule, value });
  }
  violations.sort((a, b) => b.rule.priority - a.rule.priority);
  return { violations, unchecked };
}

/**
 * Selects the single most important cue. One correction at a time is
 * deliberate: players cannot act on several cues between two shots.
 * A stroke is only called good when every applicable rule could be checked,
 * and strokes without any rules are counted, not praised.
 */
export function selectCue(metrics: StrokeMetrics, ruleSet: RuleSet): Cue {
  const { violations, unchecked } = evaluateRules(metrics, ruleSet);
  const [top] = violations;
  if (top) {
    return { ruleId: top.rule.id, severity: 'fix', text: top.rule.cue };
  }
  if (unchecked.length > 0) return NO_READING_CUE;
  const rated = ruleSet.rules.some(
    (r) => r.strokes.includes(metrics.strokeType) && r.swingSizes.includes(metrics.swingSize),
  );
  if (!rated) return NOT_RATED_CUE;
  return { ruleId: 'good', severity: 'good', text: ruleSet.goodCue };
}
