import type {
  ImuSeries,
  MountCalibration,
  StrokeMetrics,
  StrokeType,
  SwingSize,
  SwingStyle,
} from '../domain/types';
import { mulVec } from '../math/mat3';
import { rotate } from '../math/quat';
import {
  type Vec3,
  RAD_TO_DEG,
  UNIT_X,
  UNIT_Z,
  cross,
  dot,
  norm,
  normalize,
  sub,
} from '../math/vec3';
import { attitudeFromGravity, attitudeSeries, findAttitudeAnchor } from '../processing/attitude';
import {
  activeRange,
  argMax,
  detectImpact,
  findPreparationStart,
  longestQuietRun,
  rotationPath,
} from '../processing/segmentation';

export interface AnalysisParams {
  /**
   * Effective lever from the swing's centre of rotation to the sweet spot, m.
   * Racket head speed = ω⊥ · lever (rigid-lever model, see ADR 0003).
   */
  readonly leverRadiusM: number;
  /** Sample-to-sample jump in specific force that counts as ball contact, g. */
  readonly impactJumpThresholdG: number;
  /**
   * Sample-to-sample jump in angular rate that counts as ball contact, rad/s.
   * A full swing changes by < 2 rad/s per sample at 104 Hz.
   */
  readonly impactGyroJumpRadPerS: number;
  /** Swing path below this is a slice, deg (slices travel 15–25° downwards). */
  readonly sliceMaxPathDeg: number;
  /** Contact is searched within this time of peak racket rate, s. */
  readonly impactSearchS: number;
  /** The swing is "active" while ω⊥ exceeds this fraction of its peak. */
  readonly activeFraction: number;
  /** Max anchor gravity error for angles to be reported, g. */
  readonly maxAnchorErrorG: number;
  /**
   * Max gyro samples clipped between the attitude anchor and contact for
   * angles to be reported. Clipping loses rotation, so attitude error grows
   * with every clipped sample (≈1° at 6 samples, ≈8° at 20, in simulation).
   */
  readonly maxSaturatedSamples: number;
  /** Tip elevation at contact above which a stroke is classified as overhead, deg. */
  readonly overheadTipElevationDeg: number;
  /** Swings slower than this AND shorter than `compactMaxArcDeg` are compact. */
  readonly compactMaxSpeedMps: number;
  readonly compactMaxArcDeg: number;
  /** The racket counts as still below this rate, rad/s. */
  readonly quietRateRadPerS: number;
  /**
   * Stillness of at least this long is the ready position; anything shorter
   * inside the preparation is a pause (hitch) in the swing, s.
   */
  readonly readyMinS: number;
}

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  leverRadiusM: 1.0,
  impactJumpThresholdG: 6,
  impactGyroJumpRadPerS: 7,
  sliceMaxPathDeg: -8,
  impactSearchS: 0.08,
  activeFraction: 0.15,
  maxAnchorErrorG: 0.2,
  maxSaturatedSamples: 6,
  overheadTipElevationDeg: 35,
  compactMaxSpeedMps: 14,
  compactMaxArcDeg: 80,
  quietRateRadPerS: 0.5,
  readyMinS: 0.3,
};

const elevationDeg = (unit: Vec3): number =>
  Math.asin(Math.max(-1, Math.min(1, dot(unit, UNIT_Z)))) * RAD_TO_DEG;

/**
 * Computes stroke metrics from one swing capture. Pure function: no I/O, no
 * global state. See docs/metrics.md for definitions and assumptions.
 */
export function analyzeSwing(
  series: ImuSeries,
  calibration: MountCalibration,
  params: AnalysisParams = DEFAULT_ANALYSIS_PARAMS,
): StrokeMetrics {
  const n = series.gyro.length;
  if (n < 3) {
    throw new RangeError('Swing capture too short to analyse');
  }
  const fs = series.sampleRateHz;
  const R = calibration.racketFromSensor;

  // 1. Express everything in the racket frame, gyro bias removed.
  const gyro = series.gyro.map((w) => mulVec(R, sub(w, calibration.gyroBias)));
  const accel = series.accel.map((a) => mulVec(R, a));

  // 2. Rotation perpendicular to the long axis moves the head; roll about the
  //    long axis does not.
  const perpRate = gyro.map((w) => Math.hypot(w[1], w[2]));
  const peakIndex = argMax(perpRate);
  const peakRate = perpRate[peakIndex] ?? 0;
  const active = activeRange(perpRate, peakIndex, params.activeFraction * peakRate);

  // 3. Contact.
  const impactIndex = detectImpact(accel, gyro, peakIndex, Math.round(params.impactSearchS * fs), {
    accelG: params.impactJumpThresholdG,
    gyroRadPerS: params.impactGyroJumpRadPerS,
  });
  const ref = impactIndex ?? peakIndex;
  const forwardStart = Math.min(active.start, ref);
  const followEnd = Math.max(active.end, ref);

  // 4. Kinematics at contact, racket frame.
  const omegaRef = gyro[ref] ?? [0, 0, 0];
  const tipVelocityDir = cross(omegaRef, UNIT_X); // direction of ω × r, r ∥ +x
  const tipSpeedPerMetre = norm(tipVelocityDir);
  const hitsWithForehandFace = dot(tipVelocityDir, UNIT_Z) >= 0;

  // 5. Absolute attitude from the quiet phase before the forward swing.
  const anchor = findAttitudeAnchor(accel, gyro, series.accelSaturated, 0, forwardStart);
  const saturatedSamples = anchor
    ? series.gyroSaturated.slice(anchor.index, ref + 1).filter(Boolean).length
    : 0;
  const attitudeReliable =
    anchor !== null &&
    anchor.errorG <= params.maxAnchorErrorG &&
    saturatedSamples <= params.maxSaturatedSamples;

  // 6. Preparation: from the last still moment to the start of the forward swing.
  const prepStart = findPreparationStart(
    gyro,
    forwardStart,
    params.quietRateRadPerS,
    Math.round(params.readyMinS * fs),
  );
  const preparationFrom = prepStart ?? 0;
  const pauseSamples = longestQuietRun(
    gyro,
    preparationFrom,
    forwardStart,
    params.quietRateRadPerS,
  );

  let faceTiltDeg: number | null = null;
  let swingPathDeg: number | null = null;
  let tipElevationDeg: number | null = null;
  let racketDropDeg: number | null = null;
  let faceAtDropDeg: number | null = null;
  let faceClosingRateDps: number | null = null;
  if (anchor && attitudeReliable && tipSpeedPerMetre > 1e-6) {
    const anchorAttitude = attitudeFromGravity(accel[anchor.index] ?? UNIT_Z);
    const attitude = attitudeSeries(anchorAttitude, gyro, anchor.index, fs);
    const hittingNormal: Vec3 = hitsWithForehandFace ? UNIT_Z : [0, 0, -1];
    const qRef = attitude[ref] ?? anchorAttitude;
    const normalWorld = rotate(qRef, hittingNormal);
    faceTiltDeg = elevationDeg(normalWorld);
    swingPathDeg = elevationDeg(normalize(rotate(qRef, tipVelocityDir)));
    tipElevationDeg = elevationDeg(rotate(qRef, UNIT_X));

    // d(elevation)/dt of the hitting normal n is (ω × n)·up / cos(elevation).
    const normalRate = dot(cross(rotate(qRef, omegaRef), normalWorld), UNIT_Z);
    const cosTilt = Math.cos(faceTiltDeg / RAD_TO_DEG);
    faceClosingRateDps = cosTilt > 0.1 ? (-normalRate / cosTilt) * RAD_TO_DEG : null;

    for (let i = preparationFrom; i <= ref; i++) {
      const q = attitude[i] ?? anchorAttitude;
      const tip = elevationDeg(rotate(q, UNIT_X));
      if (racketDropDeg === null || tip < racketDropDeg) {
        racketDropDeg = tip;
        faceAtDropDeg = elevationDeg(rotate(q, hittingNormal));
      }
    }
  }

  // 7. "Whip": when the racket head accelerates hardest, relative to contact.
  let peakAccelIndex = forwardStart;
  let peakAccel = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(1, forwardStart); i <= ref && i < n - 1; i++) {
    const a = (perpRate[i + 1] ?? 0) - (perpRate[i - 1] ?? 0);
    if (a > peakAccel) {
      peakAccel = a;
      peakAccelIndex = i;
    }
  }

  const headSpeedMps = tipSpeedPerMetre * params.leverRadiusM;
  const forwardSwingArcDeg = rotationPath(gyro, forwardStart, ref, fs) * RAD_TO_DEG;
  const backswingArcDeg = rotationPath(gyro, preparationFrom, forwardStart, fs) * RAD_TO_DEG;
  const followThroughArcDeg = rotationPath(gyro, ref, followEnd + 1, fs) * RAD_TO_DEG;

  const strokeType: StrokeType =
    tipElevationDeg !== null && tipElevationDeg > params.overheadTipElevationDeg
      ? 'overhead'
      : hitsWithForehandFace
        ? 'forehand'
        : 'backhand';

  const swingStyle: SwingStyle | null =
    swingPathDeg === null ? null : swingPathDeg < params.sliceMaxPathDeg ? 'slice' : 'drive';

  const swingSize: SwingSize =
    headSpeedMps < params.compactMaxSpeedMps && forwardSwingArcDeg < params.compactMaxArcDeg
      ? 'compact'
      : 'full';

  return {
    strokeType,
    swingSize,
    swingStyle,
    impactDetected: impactIndex !== null,
    referenceIndex: ref,
    headSpeedMps,
    faceTiltDeg,
    swingPathDeg,
    tipElevationDeg,
    peakSpeedOffsetMs: ((peakIndex - ref) / fs) * 1000,
    preparationTimeMs: prepStart === null ? null : ((ref - prepStart) / fs) * 1000,
    backswingArcDeg,
    backswingPauseMs: (pauseSamples / fs) * 1000,
    racketDropDeg,
    faceAtDropDeg,
    peakAccelerationOffsetMs: ((peakAccelIndex - ref) / fs) * 1000,
    faceClosingRateDps,
    forwardSwingArcDeg,
    followThroughArcDeg,
    quality: {
      attitudeReliable,
      anchorErrorG: anchor?.errorG ?? null,
      gyroSaturated: series.gyroSaturated.slice(forwardStart, ref + 1).some(Boolean),
      saturatedSamples,
    },
  };
}
