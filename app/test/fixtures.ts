import type { StrokeMetrics } from '../src/domain/types';

/** A textbook topspin forehand that should trigger no correction. */
export const GOOD_FOREHAND: StrokeMetrics = {
  strokeType: 'forehand',
  swingSize: 'full',
  impactDetected: true,
  referenceIndex: 90,
  headSpeedMps: 24,
  faceTiltDeg: -12,
  swingPathDeg: 25,
  tipElevationDeg: 0,
  peakSpeedOffsetMs: 0,
  preparationTimeMs: 900,
  backswingArcDeg: 120,
  backswingPauseMs: 0,
  racketDropDeg: -40,
  faceAtDropDeg: -20,
  peakAccelerationOffsetMs: -80,
  faceClosingRateDps: 150,
  forwardSwingArcDeg: 140,
  followThroughArcDeg: 260,
  quality: {
    attitudeReliable: true,
    anchorErrorG: 0.01,
    gyroSaturated: false,
    saturatedSamples: 0,
  },
};
