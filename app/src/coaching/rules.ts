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
/**
 * Strokes the app counts but does not judge: strokes without reference values
 * (serve, smash, volley), and swings without ball contact (shadow swings and
 * misses), whose "contact" metrics are only read at peak racket speed.
 */
export const NOT_RATED_CUE: Cue = { ruleId: 'not-rated', severity: 'none', text: 'Counted' };

/**
 * A stroke is only rated when ball contact was detected. Without contact the
 * metrics describe the moment of peak racket speed, not a hit, and the
 * thresholds (all taken from studies of real contacts) do not apply. A stroke
 * with missing data inside it (`quality.signalGap`, analysis version 5) is
 * not rated either: its contact, timing and angles may be off.
 */
export const isRateable = (metrics: StrokeMetrics): boolean =>
  metrics.impactDetected && metrics.quality.signalGap !== true;

/**
 * Checks every applicable rule. Unrateable strokes (see `isRateable`) yield no
 * violations and no unchecked rules. Rules whose metric is null (withheld,
 * e.g. angles without a reliable attitude or timing after gyro clipping) are
 * reported as unchecked, never as passed or failed.
 */
export function evaluateRules(metrics: StrokeMetrics, ruleSet: RuleSet): RuleEvaluation {
  const violations: RuleViolation[] = [];
  const unchecked: CoachingRule[] = [];
  if (!isRateable(metrics)) return { violations, unchecked };
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
 * and strokes without any rules, or without ball contact, are counted, not
 * praised or corrected.
 */
export function selectCue(metrics: StrokeMetrics, ruleSet: RuleSet): Cue {
  if (!isRateable(metrics)) return NOT_RATED_CUE;
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
