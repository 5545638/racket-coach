import type {
  ImuSeries,
  MountCalibration,
  StrokeMetrics,
  StrokeType,
  SwingSize,
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
import { attitudeFromGravity, findAttitudeAnchor, propagateAttitude } from '../processing/attitude';
import { activeRange, argMax, detectImpact, rotationPath } from '../processing/segmentation';

export interface AnalysisParams {
  /**
   * Effective lever from the swing's centre of rotation to the sweet spot, m.
   * Racket head speed = ω⊥ · lever (rigid-lever model, see ADR 0003).
   */
  readonly leverRadiusM: number;
  /** Sample-to-sample jump in specific force that counts as ball contact, g. */
  readonly impactJumpThresholdG: number;
  /** The swing is "active" while ω⊥ exceeds this fraction of its peak. */
  readonly activeFraction: number;
  /** Max anchor gravity error for angles to be reported, g. */
  readonly maxAnchorErrorG: number;
  /** Tip elevation at contact above which a stroke is classified as overhead, deg. */
  readonly overheadTipElevationDeg: number;
  /** Swings slower than this AND shorter than `compactMaxArcDeg` are compact. */
  readonly compactMaxSpeedMps: number;
  readonly compactMaxArcDeg: number;
}

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  leverRadiusM: 1.0,
  impactJumpThresholdG: 6,
  activeFraction: 0.15,
  maxAnchorErrorG: 0.2,
  overheadTipElevationDeg: 35,
  compactMaxSpeedMps: 14,
  compactMaxArcDeg: 80,
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
  const impactIndex = detectImpact(accel, active.start, params.impactJumpThresholdG);
  const ref = impactIndex ?? peakIndex;
  const forwardStart = Math.min(active.start, ref);
  const followEnd = Math.max(active.end, ref);

  // 4. Kinematics at contact, racket frame.
  const omegaRef = gyro[ref] ?? [0, 0, 0];
  const tipVelocityDir = cross(omegaRef, UNIT_X); // direction of ω × r, r ∥ +x
  const tipSpeedPerMetre = norm(tipVelocityDir);
  const hitsWithForehandFace = dot(tipVelocityDir, UNIT_Z) >= 0;

  // 5. Absolute attitude from the quiet phase before the forward swing.
  const anchor = findAttitudeAnchor(accel, gyro, 0, forwardStart);
  const attitudeReliable = anchor !== null && anchor.errorG <= params.maxAnchorErrorG;

  let faceTiltDeg: number | null = null;
  let swingPathDeg: number | null = null;
  let tipElevationDeg: number | null = null;
  if (anchor && attitudeReliable && tipSpeedPerMetre > 1e-6) {
    const anchorAccel = accel[anchor.index] ?? UNIT_Z;
    const qAnchor = attitudeFromGravity(anchorAccel);
    const qRef = propagateAttitude(qAnchor, gyro, anchor.index, ref, fs);
    const hittingNormal: Vec3 = hitsWithForehandFace ? UNIT_Z : [0, 0, -1];
    faceTiltDeg = elevationDeg(rotate(qRef, hittingNormal));
    swingPathDeg = elevationDeg(normalize(rotate(qRef, tipVelocityDir)));
    tipElevationDeg = elevationDeg(rotate(qRef, UNIT_X));
  }

  const headSpeedMps = tipSpeedPerMetre * params.leverRadiusM;
  const forwardSwingArcDeg = rotationPath(gyro, forwardStart, ref, fs) * RAD_TO_DEG;
  const followThroughArcDeg = rotationPath(gyro, ref, followEnd + 1, fs) * RAD_TO_DEG;

  const strokeType: StrokeType =
    tipElevationDeg !== null && tipElevationDeg > params.overheadTipElevationDeg
      ? 'overhead'
      : hitsWithForehandFace
        ? 'forehand'
        : 'backhand';

  const swingSize: SwingSize =
    headSpeedMps < params.compactMaxSpeedMps && forwardSwingArcDeg < params.compactMaxArcDeg
      ? 'compact'
      : 'full';

  return {
    strokeType,
    swingSize,
    impactDetected: impactIndex !== null,
    referenceIndex: ref,
    headSpeedMps,
    faceTiltDeg,
    swingPathDeg,
    tipElevationDeg,
    peakSpeedOffsetMs: ((peakIndex - ref) / fs) * 1000,
    forwardSwingArcDeg,
    followThroughArcDeg,
    quality: {
      attitudeReliable,
      anchorErrorG: anchor?.errorG ?? null,
      gyroSaturated: series.gyroSaturated.slice(forwardStart, ref + 1).some(Boolean),
    },
  };
}
