import type {
  ImuSeries,
  MountCalibration,
  StrokeMetrics,
  StrokeType,
  SwingSize,
  SwingStyle,
} from '../domain/types';
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
  attitudeFromGravity,
  attitudeSeries,
  findAttitudeAnchor,
} from '../processing/attitude';
import {
  activeRange,
  type ContactReference,
  argMax,
  contactReference,
  detectImpact,
  findPreparationStart,
  longestQuietRun,
  rotationPath,
} from '../processing/segmentation';

export interface AnalysisParams {
  /**
   * Effective lever from the swing's centre of rotation to the sweet spot, m.
   * Racket head speed = ω⊥ · lever (rigid-lever model, see ADR 0003).
   *
   * Default 0.72 m: the effective radius used by TennisEye (≈ 0.2 m from the
   * butt to the centre of rotation plus ≈ 0.52 m from the butt to the face
   * centre; docs/research/racket-dynamics.md §5). It was not validated for
   * forehands, so head speed is a model estimate: compare it within a player
   * over time (a personal trend), not against published speeds.
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
  /**
   * Length of the quiet window that anchors absolute tilt, s. Long enough to
   * average out noise and to expose a moving racket through the spread of its
   * specific force; short enough to fit into a brief ready position.
   * Engineering choice; tune on recorded data.
   */
  readonly anchorWindowS: number;
  /**
   * Max standard deviation of each specific-force axis inside the anchor
   * window, g. A static racket shows only sensor noise (≈ 0.01 g), a racket
   * starting to swing shows a growing tangential acceleration.
   * Engineering choice; tune on recorded data.
   */
  readonly anchorMaxAccelStdG: number;
  /**
   * Max drift of each specific-force axis across the anchor window (second
   * half mean minus first half mean), g. Rejects windows on the slowly rising
   * tangential acceleration at swing onset; sensor noise of 0.01 g moves it
   * by ≈ 0.006 g rms. Engineering choice; tune on recorded data.
   */
  readonly anchorMaxAccelDriftG: number;
  /**
   * Max |‖mean specific force‖ − 1 g| over the anchor window, g. At 0.05 g a
   * steady perpendicular acceleration of up to 0.32 g still passes (≤ 18° of
   * tilt error); the spread and rate limits make that case unlikely.
   * Engineering choice; tune on recorded data.
   */
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
  /**
   * The racket counts as still below this rate, rad/s. Applies to the ready
   * position and to every sample of the attitude anchor window.
   */
  readonly quietRateRadPerS: number;
  /**
   * Stillness of at least this long is the ready position; anything shorter
   * inside the preparation is a pause (hitch) in the swing, s.
   */
  readonly readyMinS: number;
}

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  leverRadiusM: 0.72,
  impactJumpThresholdG: 6,
  impactGyroJumpRadPerS: 7,
  sliceMaxPathDeg: -8,
  impactSearchS: 0.08,
  activeFraction: 0.15,
  anchorWindowS: 0.1,
  anchorMaxAccelStdG: 0.03,
  anchorMaxAccelDriftG: 0.01,
  maxAnchorErrorG: 0.05,
  maxSaturatedSamples: 6,
  overheadTipElevationDeg: 35,
  compactMaxSpeedMps: 14,
  compactMaxArcDeg: 80,
  quietRateRadPerS: 0.5,
  readyMinS: 0.3,
};

const elevationDeg = (unit: Vec3): number =>
  Math.asin(Math.max(-1, Math.min(1, dot(unit, UNIT_Z)))) * RAD_TO_DEG;

const countTrue = (flags: readonly boolean[], from: number, to: number): number =>
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

interface ContactAngles {
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
function anglesAtSample(q: Quat, omega: Vec3, hittingNormal: Vec3): ContactAngles {
  const normalWorld = rotate(q, hittingNormal);
  const faceTiltDeg = elevationDeg(normalWorld);
  // d(elevation)/dt of the hitting normal n is (ω × n)·up / cos(elevation).
  const normalRate = dot(cross(rotate(q, omega), normalWorld), UNIT_Z);
  const cosTilt = Math.cos(faceTiltDeg / RAD_TO_DEG);
  return {
    faceTiltDeg,
    swingPathDeg: elevationDeg(normalize(rotate(q, cross(omega, UNIT_X)))),
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

/**
 * Contact angles from an attitude series: read at the last pre-impact sample
 * `contact.sampleIndex` and extrapolated to `contact.time`.
 */
function anglesAtContact(
  attitude: readonly Quat[],
  gyro: readonly Vec3[],
  contact: ContactReference,
  hittingNormal: Vec3,
): ContactAngles {
  const at = (i: number): ContactAngles =>
    anglesAtSample(attitude[i] ?? IDENTITY_QUAT, gyro[i] ?? [0, 0, 0], hittingNormal);
  const last = at(contact.sampleIndex);
  const fraction = contact.time - contact.sampleIndex;
  const prevIndex = contact.sampleIndex - 1;
  const prevOmega = gyro[prevIndex];
  if (fraction === 0 || prevIndex < 0 || !prevOmega || norm(cross(prevOmega, UNIT_X)) < 1e-6) {
    return last;
  }
  return extrapolateAngles(at(prevIndex), last, fraction);
}

/** Lowest tip elevation in `[from, to]` and the hitting-face tilt at that moment. */
function racketDrop(
  attitude: readonly Quat[],
  from: number,
  to: number,
  hittingNormal: Vec3,
): { readonly racketDropDeg: number | null; readonly faceAtDropDeg: number | null } {
  let racketDropDeg: number | null = null;
  let faceAtDropDeg: number | null = null;
  for (let i = from; i <= to; i++) {
    const q = attitude[i];
    if (!q) continue;
    const tip = elevationDeg(rotate(q, UNIT_X));
    if (racketDropDeg === null || tip < racketDropDeg) {
      racketDropDeg = tip;
      faceAtDropDeg = elevationDeg(rotate(q, hittingNormal));
    }
  }
  return { racketDropDeg, faceAtDropDeg };
}

/**
 * Sample of steepest rise in ω⊥ in `[from, to]`, by central difference. The
 * caller keeps `to + 1` before the impact so the post-impact drop never counts.
 */
function steepestRise(perpRate: readonly number[], from: number, to: number): number {
  let best = from;
  let bestRise = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(1, from); i <= to && i < perpRate.length - 1; i++) {
    const rise = (perpRate[i + 1] ?? 0) - (perpRate[i - 1] ?? 0);
    if (rise > bestRise) {
      bestRise = rise;
      best = i;
    }
  }
  return best;
}

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
  const msFromSamples = (samples: number): number => (samples / fs) * 1000;

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
  const followEnd = Math.max(active.end, ref);

  // 4. Kinematics at contact, racket frame, from the last pre-impact sample.
  //    Near contact the rate is close to its peak and changes little within
  //    half a sample, so speed is not extrapolated.
  const tipVelocityDir = cross(gyro[ref] ?? [0, 0, 0], UNIT_X); // direction of ω × r, r ∥ +x
  const tipSpeedPerMetre = norm(tipVelocityDir);
  const hitsWithForehandFace = dot(tipVelocityDir, UNIT_Z) >= 0;
  const hittingNormal: Vec3 = hitsWithForehandFace ? UNIT_Z : [0, 0, -1];

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
  const attitudeReliable = anchor !== null && saturatedSamples <= params.maxSaturatedSamples;
  const attitude = anchor
    ? attitudeSeries(attitudeFromGravity(anchor.gravity), gyro, anchor.index, fs)
    : null;
  // Computed whenever the anchor is valid; displayed only when reliable.
  const rawAngles =
    attitude && tipSpeedPerMetre > 1e-6
      ? anglesAtContact(attitude, gyro, contact, hittingNormal)
      : null;

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

  const angles = attitudeReliable ? rawAngles : null;
  const drop =
    attitude && angles
      ? racketDrop(attitude, preparationFrom, ref, hittingNormal)
      : { racketDropDeg: null, faceAtDropDeg: null };

  // 7. Timing. A clipped gyro plateau moves the argmax of ω⊥ (and of its rise)
  //    early by up to the plateau's length, so timing is withheld when the
  //    gyro clipped anywhere in the forward swing.
  const gyroClippedInSwing = countTrue(series.gyroSaturated, forwardStart, ref) > 0;
  const peakAccelIndex = steepestRise(perpRate, forwardStart, ref - 1);

  const headSpeedMps = tipSpeedPerMetre * params.leverRadiusM;
  // Arcs split at the first sample after the contact time (the impact sample).
  const split = Math.ceil(contact.time);
  const forwardSwingArcDeg = rotationPath(gyro, forwardStart, split, fs) * RAD_TO_DEG;
  const backswingArcDeg = rotationPath(gyro, preparationFrom, forwardStart, fs) * RAD_TO_DEG;
  const followThroughArcDeg = rotationPath(gyro, split, followEnd + 1, fs) * RAD_TO_DEG;

  // Classification only: the coarse tip elevation stays usable when the
  // displayed angles are withheld because the gyro clipped, as long as the
  // anchor itself is valid. Overheads are the fastest swings and clip most.
  const classificationTipDeg = rawAngles?.tipElevationDeg ?? null;
  const strokeType: StrokeType =
    classificationTipDeg !== null && classificationTipDeg > params.overheadTipElevationDeg
      ? 'overhead'
      : hitsWithForehandFace
        ? 'forehand'
        : 'backhand';

  const swingPathDeg = angles?.swingPathDeg ?? null;
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
    referenceIndex: impactIndex ?? peakIndex,
    headSpeedMps,
    faceTiltDeg: angles?.faceTiltDeg ?? null,
    swingPathDeg,
    tipElevationDeg: angles?.tipElevationDeg ?? null,
    peakSpeedOffsetMs: gyroClippedInSwing ? null : msFromSamples(peakIndex - contact.time),
    preparationTimeMs: prepStart === null ? null : msFromSamples(contact.time - prepStart),
    backswingArcDeg,
    backswingPauseMs: msFromSamples(pauseSamples),
    racketDropDeg: drop.racketDropDeg,
    faceAtDropDeg: drop.faceAtDropDeg,
    peakAccelerationOffsetMs: gyroClippedInSwing
      ? null
      : msFromSamples(peakAccelIndex - contact.time),
    faceClosingRateDps: angles?.faceClosingRateDps ?? null,
    forwardSwingArcDeg,
    followThroughArcDeg,
    quality: {
      attitudeReliable,
      anchorErrorG: anchor?.errorG ?? null,
      gyroSaturated: gyroClippedInSwing,
      saturatedSamples,
    },
  };
}
