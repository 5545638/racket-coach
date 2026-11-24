import { EMPTY_BASELINE, type PersonalBaseline } from '../coach/baseline';
import { selectCue, type RuleSet } from '../coaching/rules';
import type {
  Cue,
  MountCalibration,
  RawCapture,
  StrokeMetrics,
  StrokeRecord,
} from '../domain/types';
import {
  type AssessConfig,
  DEFAULT_ASSESS_CONFIG,
  type StrokeAssessment,
  assessStroke,
} from '../elements/assess';
import {
  type AnalysisParams,
  DEFAULT_ANALYSIS_PARAMS,
  analyzeSwing,
} from '../metrics/analyzeSwing';
import { seriesFromCapture } from '../processing/highRate';

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
  // v2 M416 captures are spliced to 416 Hz (processing/highRate.ts).
  const metrics = analyzeSwing(seriesFromCapture(capture), calibration, params);
  return {
    metrics,
    cue: selectCue(metrics, rules),
    assessment: assessStroke(metrics, baseline, assessConfig),
  };
}

/**
 * Re-analyses a stored stroke from its raw capture with the calibration and
 * parameters it was recorded with (current defaults for parameters added
 * since, e.g. the version 6 bias re-estimation). Null for records that lack
 * the calibration snapshot. With the same `ANALYSIS_VERSION` the metrics are
 * reproduced exactly.
 */
export function reanalyseStroke(
  stroke: StrokeRecord,
  rules: RuleSet,
  baseline: PersonalBaseline = EMPTY_BASELINE,
): StrokeAnalysis | null {
  if (!stroke.calibration) return null;
  const params: AnalysisParams = { ...DEFAULT_ANALYSIS_PARAMS, ...stroke.analysisParams };
  return analyzeCapture(stroke.capture, stroke.calibration, params, rules, baseline);
}
