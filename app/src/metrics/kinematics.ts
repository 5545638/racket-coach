import type { ImuSeries, MountCalibration } from '../domain/types';
import { mulVec } from '../math/mat3';
import { type Quat, IDENTITY_QUAT, rotate } from '../math/quat';
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
import {
  type AnchorCriteria,
  type AttitudeAnchor,
  attitudeFromGravity,
  attitudeSeries,
  findAttitudeAnchor,
} from '../processing/attitude';
import {
  type ContactReference,
  activeRange,
  argMax,
  contactReference,
  detectImpact,
  findPreparationStart,
} from '../processing/segmentation';
import type { AnalysisParams } from './analyzeSwing';

/** Elevation of a unit vector above the horizontal plane, deg. */
export const elevationDeg = (unit: Vec3): number =>
  Math.asin(Math.max(-1, Math.min(1, dot(unit, UNIT_Z)))) * RAD_TO_DEG;

/** Number of true flags in the inclusive range `[from, to]`. */
export const countTrue = (flags: readonly boolean[], from: number, to: number): number =>
  flags.slice(Math.max(0, from), to + 1).filter(Boolean).length;

function anchorCriteria(params: AnalysisParams, sampleRateHz: number): AnchorCriteria {
  return {
    windowSamples: Math.round(params.anchorWindowS * sampleRateHz),
    maxRateRadPerS: params.quietRateRadPerS,
    maxAccelStdG: params.anchorMaxAccelStdG,
    maxAccelDriftG: params.anchorMaxAccelDriftG,
    maxGravityErrorG: params.maxAnchorErrorG,
  };
}

export interface ContactAngles {
  readonly faceTiltDeg: number;
  readonly swingPathDeg: number;
  readonly tipElevationDeg: number;
  readonly faceClosingRateDps: number | null;
}

/**
 * Gravity-referenced angles at one sample from its attitude `q` and body rate
 * `omega`. The sweet-spot velocity of the rigid lever is ω × (L x̂), so its
 * direction is ω × x̂ whatever L is.
 */
export function anglesAtSample(q: Quat, omega: Vec3, hittingNormal: Vec3): ContactAngles {
  const normalWorld = rotate(q, hittingNormal);
  const faceTiltDeg = elevationDeg(normalWorld);
  // d(elevation)/dt of the hitting normal n is (ω × n)·up / cos(elevation).
  const normalRate = dot(cross(rotate(q, omega), normalWorld), UNIT_Z);
  const cosTilt = Math.cos(faceTiltDeg / RAD_TO_DEG);
  const velocityDir = cross(omega, UNIT_X);
  return {
    faceTiltDeg,
    swingPathDeg: norm(velocityDir) > 1e-9 ? elevationDeg(normalize(rotate(q, velocityDir))) : 0,
    tipElevationDeg: elevationDeg(rotate(q, UNIT_X)),
    faceClosingRateDps: cosTilt > 0.1 ? (-normalRate / cosTilt) * RAD_TO_DEG : null,
  };
}

/** Linear extrapolation from `prev` through `last` by `fraction` of their spacing. */
const extrapolate = (prev: number, last: number, fraction: number): number =>
  last + (last - prev) * fraction;

/**
 * Angles at the contact time, extrapolated linearly from the last two
 * pre-impact samples by `fraction` of a sample (½ with an impact, 0 without).
 *
 * Extrapolating the angles, rather than carrying the attitude forward at the
 * last measured body rate, keeps forearm roll from leaking into the swing
 * path: with roll the body rate is not constant over the step, and the
 * constant-rate assumption tilted the path by ≈ 4° at 15 rad/s of roll in
 * simulation. The closing rate is extrapolated too: it changes by tens of
 * deg/s within half a sample near contact.
 */
function extrapolateAngles(
  prev: ContactAngles,
  last: ContactAngles,
  fraction: number,
): ContactAngles {
  const closing =
    prev.faceClosingRateDps === null || last.faceClosingRateDps === null
      ? last.faceClosingRateDps
      : extrapolate(prev.faceClosingRateDps, last.faceClosingRateDps, fraction);
  return {
    faceTiltDeg: extrapolate(prev.faceTiltDeg, last.faceTiltDeg, fraction),
    swingPathDeg: extrapolate(prev.swingPathDeg, last.swingPathDeg, fraction),
    tipElevationDeg: extrapolate(prev.tipElevationDeg, last.tipElevationDeg, fraction),
    faceClosingRateDps: closing,
  };
}

/** Angles at the last pre-impact sample and the one before it (null at the capture start). */
export interface ContactAngleSamples {
  readonly last: ContactAngles;
  readonly prev: ContactAngles | null;
}

/** Angles at `contact.sampleIndex` and the sample before it. */
export function contactAngleSamples(
  attitude: readonly Quat[],
  gyro: readonly Vec3[],
  contact: ContactReference,
  hittingNormal: Vec3,
): ContactAngleSamples {
  const at = (i: number): ContactAngles =>
    anglesAtSample(attitude[i] ?? IDENTITY_QUAT, gyro[i] ?? [0, 0, 0], hittingNormal);
  const prevIndex = contact.sampleIndex - 1;
  const prevOmega = gyro[prevIndex];
  const prevUsable = prevIndex >= 0 && prevOmega && norm(cross(prevOmega, UNIT_X)) >= 1e-6;
  return { last: at(contact.sampleIndex), prev: prevUsable ? at(prevIndex) : null };
}

/**
 * Contact angles from an attitude series: read at the last pre-impact sample
 * `contact.sampleIndex` and extrapolated to `contact.time`.
 */
function anglesAtContact(samples: ContactAngleSamples, contact: ContactReference): ContactAngles {
  const fraction = contact.time - contact.sampleIndex;
  if (fraction === 0 || samples.prev === null) return samples.last;
  return extrapolateAngles(samples.prev, samples.last, fraction);
}

/**
 * Everything `analyzeSwing` derives from a capture before it computes metrics:
 * racket-frame signals, segmentation, contact and attitude. Internal to the
 * metrics module; the coaching features (`features.ts`) and their uncertainty
 * (`uncertainty.ts`) are pure functions of it.
 */
export interface SwingKinematics {
  readonly sampleRateHz: number;
  /** Bias-corrected angular rate in the racket frame, rad/s. */
  readonly gyro: readonly Vec3[];
  /** Specific force in the racket frame, m/s². */
  readonly accel: readonly Vec3[];
  /** ω⊥ = hypot(ωy, ωz) per sample, rad/s. */
  readonly perpRate: readonly number[];
  readonly gyroSaturated: readonly boolean[];
  readonly accelSaturated: readonly boolean[];
  readonly peakIndex: number;
  /** Inclusive bounds of the active phase (ω⊥ above `activeFraction` of its peak). */
  readonly active: { readonly start: number; readonly end: number };
  readonly impactIndex: number | null;
  readonly contact: ContactReference;
  /** First sample of the forward swing (start of the active phase, at most the contact sample). */
  readonly forwardStart: number;
  /** End of the ready position (first sample after the last long standstill), or null. */
  readonly readyEnd: number | null;
  /** Racket-frame normal of the face that hits the ball (±ẑ). */
  readonly hittingNormal: Vec3;
  /** ‖ω × x̂‖ at the contact sample, rad/s (head speed per metre of lever). */
  readonly tipSpeedPerMetre: number;
  /** Quiet-window attitude anchor, with its window statistics; null when none qualified. */
  readonly anchor: AttitudeAnchor | null;
  /** Attitude q_WB per sample, or null without an anchor. */
  readonly attitude: readonly Quat[] | null;
  /** Clipped gyro samples between the anchor and the contact sample. */
  readonly saturatedSamples: number;
  /** Anchor valid and saturation up to contact within `maxSaturatedSamples`. */
  readonly attitudeReliable: boolean;
  /** Gyro clipped anywhere between forward-swing start and contact. */
  readonly gyroClippedInSwing: boolean;
  /** Angles at the two pre-impact samples, whenever an attitude exists. */
  readonly contactSamples: ContactAngleSamples | null;
  /** Contact angles extrapolated to the contact time, whenever an attitude exists. */
  readonly rawAngles: ContactAngles | null;
}

/** Racket-frame signals, contact and segmentation; steps 1–3 of the pipeline. */
export function computeSwingKinematics(
  series: ImuSeries,
  calibration: MountCalibration,
  params: AnalysisParams,
): SwingKinematics {
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

  // 3. Contact: kinematics from the last pre-impact sample, timing from the
  //    estimated contact time (see contactReference).
  const impactIndex = detectImpact(accel, gyro, peakIndex, Math.round(params.impactSearchS * fs), {
    accelG: params.impactJumpThresholdG,
    gyroRadPerS: params.impactGyroJumpRadPerS,
  });
  const contact = contactReference(impactIndex, peakIndex);
  const ref = contact.sampleIndex;
  const forwardStart = Math.min(active.start, ref);

  // 4. Kinematics at contact, racket frame, from the last pre-impact sample.
  const tipVelocityDir = cross(gyro[ref] ?? [0, 0, 0], UNIT_X); // direction of ω × r, r ∥ +x
  const tipSpeedPerMetre = norm(tipVelocityDir);
  const hittingNormal: Vec3 = dot(tipVelocityDir, UNIT_Z) >= 0 ? UNIT_Z : [0, 0, -1];

  // 5. Absolute attitude from a quiet window before the forward swing.
  const anchor = findAttitudeAnchor(
    {
      accel,
      gyro,
      accelSaturated: series.accelSaturated,
      gyroSaturated: series.gyroSaturated,
      sampleRateHz: fs,
    },
    0,
    forwardStart,
    anchorCriteria(params, fs),
  );
  const saturatedSamples = anchor ? countTrue(series.gyroSaturated, anchor.index, ref) : 0;
  const attitude = anchor
    ? attitudeSeries(attitudeFromGravity(anchor.gravity), gyro, anchor.index, fs)
    : null;
  const contactSamples =
    attitude && tipSpeedPerMetre > 1e-6
      ? contactAngleSamples(attitude, gyro, contact, hittingNormal)
      : null;

  return {
    sampleRateHz: fs,
    gyro,
    accel,
    perpRate,
    gyroSaturated: series.gyroSaturated,
    accelSaturated: series.accelSaturated,
    peakIndex,
    active,
    impactIndex,
    contact,
    forwardStart,
    readyEnd: findPreparationStart(
      gyro,
      forwardStart,
      params.quietRateRadPerS,
      Math.round(params.readyMinS * fs),
    ),
    hittingNormal,
    tipSpeedPerMetre,
    anchor,
    attitude,
    saturatedSamples,
    attitudeReliable: anchor !== null && saturatedSamples <= params.maxSaturatedSamples,
    gyroClippedInSwing: countTrue(series.gyroSaturated, forwardStart, ref) > 0,
    contactSamples,
    rawAngles: contactSamples ? anglesAtContact(contactSamples, contact) : null,
  };
}
