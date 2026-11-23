import type { Cue, StrokeMetrics, StrokeType, SwingSize } from '../domain/types';

/** Metrics a rule may test. Restricted to numeric, possibly-null fields. */
export type RuleMetric =
  | 'faceTiltDeg'
  | 'swingPathDeg'
  | 'headSpeedMps'
  | 'peakSpeedOffsetMs'
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

/** All rules that fire for these metrics, highest priority first. */
export function findViolations(metrics: StrokeMetrics, ruleSet: RuleSet): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (const rule of ruleSet.rules) {
    if (!rule.strokes.includes(metrics.strokeType)) continue;
    if (!rule.swingSizes.includes(metrics.swingSize)) continue;
    if (rule.metric === 'headSpeedMps' && metrics.quality.gyroSaturated) continue;
    const value = metrics[rule.metric];
    if (value === null) continue;
    const fires =
      (rule.above !== undefined && value > rule.above) ||
      (rule.below !== undefined && value < rule.below);
    if (fires) violations.push({ rule, value });
  }
  return violations.sort((a, b) => b.rule.priority - a.rule.priority);
}

/**
 * Selects the single most important cue. One correction at a time is
 * deliberate: players cannot act on several cues between two shots.
 */
export function selectCue(metrics: StrokeMetrics, ruleSet: RuleSet): Cue {
  const [top] = findViolations(metrics, ruleSet);
  if (top) {
    return { ruleId: top.rule.id, severity: 'fix', text: top.rule.cue };
  }
  return { ruleId: 'good', severity: 'good', text: ruleSet.goodCue };
}
