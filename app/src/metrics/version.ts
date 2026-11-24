/**
 * Version of the analysis algorithm (segmentation, attitude, metric formulas
 * and their defaults). Bump whenever the output of `analyzeSwing` for the same
 * capture, calibration and parameters can change. Stored with every stroke so
 * that old results can be told apart from, and re-computed against, newer ones.
 *
 * 1: implicit, strokes saved before versioning existed.
 * 2: first version recorded together with calibration and parameters.
 */
export const ANALYSIS_VERSION = 2;
