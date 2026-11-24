import { EMPTY_BASELINE, type PersonalBaseline } from '../coach/baseline';
import { selectCue, type RuleSet } from '../coaching/rules';
import type { Cue, MountCalibration, RawCapture, StrokeMetrics } from '../domain/types';
import {
  type AssessConfig,
  DEFAULT_ASSESS_CONFIG,
  type StrokeAssessment,
  assessStroke,
} from '../elements/assess';
import { type AnalysisParams, analyzeSwing } from '../metrics/analyzeSwing';
import { toImuSeries } from '../processing/units';

export interface StrokeAnalysis {
  readonly metrics: StrokeMetrics;
  /** Verdict of the fixed rule set (population limits only). */
  readonly cue: Cue;
  /** Element-by-element assessment against population limits and the personal baseline. */
  readonly assessment: StrokeAssessment;
}

/**
 * Raw capture → metrics → rule cue and element assessment. Pure; the single
 * entry point for re-analysis. `baseline` defaults to none (population
 * limits only).
 */
export function analyzeCapture(
  capture: RawCapture,
  calibration: MountCalibration,
  params: AnalysisParams,
  rules: RuleSet,
  baseline: PersonalBaseline = EMPTY_BASELINE,
  assessConfig: AssessConfig = DEFAULT_ASSESS_CONFIG,
): StrokeAnalysis {
  const metrics = analyzeSwing(toImuSeries(capture), calibration, params);
  return {
    metrics,
    cue: selectCue(metrics, rules),
    assessment: assessStroke(metrics, baseline, assessConfig),
  };
}
