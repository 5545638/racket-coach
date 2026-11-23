import { selectCue, type RuleSet } from '../coaching/rules';
import type { Cue, MountCalibration, RawCapture, StrokeMetrics } from '../domain/types';
import { type AnalysisParams, analyzeSwing } from '../metrics/analyzeSwing';
import { toImuSeries } from '../processing/units';

export interface StrokeAnalysis {
  readonly metrics: StrokeMetrics;
  readonly cue: Cue;
}

/** Raw capture → metrics → cue. Pure; the single entry point for re-analysis. */
export function analyzeCapture(
  capture: RawCapture,
  calibration: MountCalibration,
  params: AnalysisParams,
  rules: RuleSet,
): StrokeAnalysis {
  const metrics = analyzeSwing(toImuSeries(capture), calibration, params);
  return { metrics, cue: selectCue(metrics, rules) };
}
