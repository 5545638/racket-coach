import type { StrokeFeatures, StrokeMetrics, StrokeRecord } from '../src/domain/types';
import { ANALYSIS_VERSION } from '../src/metrics/version';

/** A textbook topspin forehand that should trigger no correction. */
export const GOOD_FOREHAND: StrokeMetrics = {
  strokeType: 'forehand',
  swingSize: 'full',
  swingStyle: 'drive',
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

/** Coaching features (analysis version ≥ 3) matching GOOD_FOREHAND, with typical σ. */
export const GOOD_FEATURES: StrokeFeatures = {
  phases: {
    readyEndMs: 0,
    forwardStartMs: 725,
    contactMs: 900,
    contactSample: 93,
    followEndMs: 1124,
    recoveryEndMs: 1500,
  },
  takebackTurnDeg: 90,
  takebackTimeMs: 900,
  takebackTipDeg: 30,
  takebackFaceDeg: -10,
  lateGainFraction: 0.3,
  forwardSwingMs: 175,
  hitchCount: 0,
  contactStabilityDps: 200,
  brushAngleDeg: 37,
  brakingTimeMs: 224,
  finishTipDeg: 60,
  recoveryMs: 600,
  serve: null,
  sigma: {
    faceTiltDeg: 1.5,
    swingPathDeg: 3.3,
    tipElevationDeg: 1.5,
    brushAngleDeg: 3.6,
    racketDropDeg: 1.2,
    takebackTurnDeg: 2,
    takebackTipDeg: 1.2,
    takebackFaceDeg: 1.2,
    finishTipDeg: 1.8,
    trophyTipDeg: null,
    dropTipDeg: null,
    contactTipDeg: 1.5,
    headSpeedMps: 3.6,
    peakSpeedOffsetMs: 2.8,
    takebackTimeMs: 2.8,
    forwardSwingMs: 2.8,
    brakingTimeMs: 2.8,
    recoveryMs: 2.8,
    dropToContactMs: null,
    rollPeakOffsetMs: null,
  },
};

/** GOOD_FOREHAND as analysed by version 3 and later (with features). */
export const GOOD_FOREHAND_V3: StrokeMetrics = { ...GOOD_FOREHAND, features: GOOD_FEATURES };

/** A serve with features, roll not clipped. */
export const GOOD_SERVE: StrokeMetrics = {
  ...GOOD_FOREHAND,
  strokeType: 'overhead',
  tipElevationDeg: 70,
  features: {
    ...GOOD_FEATURES,
    serve: {
      trophyTipDeg: 60,
      dropTipDeg: -70,
      dropToContactMs: 120,
      rollPeakDps: 1100,
      rollPeakOffsetMs: 20,
      rollAngleDeg: 40,
      rollSaturated: false,
      contactTipDeg: 70,
      contactTipReliable: true,
    },
    sigma: { ...GOOD_FEATURES.sigma, dropTipDeg: 1.5, trophyTipDeg: 1.5, dropToContactMs: 2.8 },
  },
};

/** Metrics with some features replaced. */
export function withFeatures(
  metrics: StrokeMetrics,
  patch: Partial<StrokeFeatures>,
): StrokeMetrics {
  const features = metrics.features ?? GOOD_FEATURES;
  return { ...metrics, features: { ...features, ...patch } };
}

/** A stored stroke around `metrics` (capture content is irrelevant to coaching). */
export function strokeRecord(
  metrics: StrokeMetrics,
  receivedAt: number,
  /** null: a record from before versioning. */
  analysisVersion: number | null = ANALYSIS_VERSION,
): StrokeRecord {
  return {
    id: `stroke-${String(receivedAt)}`,
    sessionId: 'session',
    capture: {
      kind: 'swing',
      sequence: receivedAt,
      sampleRateHz: 104,
      accelGPerLsb: 0.000488,
      gyroDpsPerLsb: 0.07,
      triggerIndex: 0,
      samples: new Int16Array(6),
      receivedAt,
    },
    metrics,
    cue: { ruleId: 'good', severity: 'good', text: 'Good' },
    ...(analysisVersion === null ? {} : { analysisVersion }),
  };
}
