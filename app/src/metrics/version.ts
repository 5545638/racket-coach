/**
 * Version of the analysis algorithm (segmentation, attitude, metric formulas
 * and their defaults). Bump whenever the output of `analyzeSwing` for the same
 * capture, calibration and parameters can change. Stored with every stroke so
 * that old results can be told apart from, and re-computed against, newer ones.
 *
 * 1: implicit, strokes saved before versioning existed.
 * 2: first version recorded together with calibration and parameters.
 * 3: adds `StrokeMetrics.features` (phase timeline, coaching features, σ).
 * 4: serve roll peak and angle skip the impact jolt; overhead contact tip is
 *    carried forward by rotation instead of linear angle extrapolation.
 * 5: signal path v2 (docs/metrics.md, "Signal path v2"): timestamps and
 *    resampling, gyro clipping reconstruction, rate-agnostic thresholds,
 *    impact consistency checks, labelled phases, gap and clipping rules
 *    (`maxSaturatedSamples` now counts only unreconstructed samples, default 1).
 * 6: v2 capture integration (docs/metrics.md, "v2 captures"): header
 *    sensitivities → ranges (unknown ones reject the capture), BEGIN_B flags
 *    (FIFO reset, hidden clipping), M416 splice to 416 Hz with measured /
 *    interpolated samples (σ uses the measured resolution), impact onset
 *    refined with the measured gyro, per-capture gyro bias re-estimation,
 *    temperature against the calibration.
 */
export const ANALYSIS_VERSION = 6;
