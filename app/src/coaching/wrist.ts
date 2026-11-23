import type { StrokeMetrics } from '../domain/types';

export type WristHint = 'loose' | 'stiff';

/**
 * Peak racket acceleration earlier than this before contact (ms) means the
 * racket moved with the arm instead of lagging and whipping through.
 * Heuristic; see docs/metrics.md ("What the sensor cannot say about the wrist").
 */
export const STIFF_ACCELERATION_OFFSET_MS = -150;

/**
 * Indirect estimate of wrist looseness from racket lag. A racket-only sensor
 * cannot measure the wrist itself, so this is a hint, given only for full
 * groundstrokes where the lag pattern is meaningful.
 */
export function wristHint(metrics: StrokeMetrics): WristHint | null {
  if (metrics.swingSize !== 'full' || metrics.strokeType === 'overhead') return null;
  return metrics.peakAccelerationOffsetMs < STIFF_ACCELERATION_OFFSET_MS ? 'stiff' : 'loose';
}
