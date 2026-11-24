import type {
  ImuSeries,
  MountCalibration,
  StrokeMetrics,
  StrokeType,
  SwingSize,
  SwingStyle,
} from '../domain/types';
import { type Quat, rotate } from '../math/quat';
import { type Vec3, RAD_TO_DEG, UNIT_X } from '../math/vec3';
import { longestQuietRun, rotationPath } from '../processing/segmentation';
import { computeFeatures } from './features';
import { computeSwingKinematics, elevationDeg } from './kinematics';

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
  const msFromSamples = (samples: number): number => (samples / fs) * 1000;

  // Steps 1–5: racket frame, rates, contact, attitude (see kinematics.ts).
  const kin = computeSwingKinematics(series, calibration, params);
  const { gyro, perpRate, peakIndex, active, impactIndex, contact, forwardStart } = kin;
  const { hittingNormal, tipSpeedPerMetre, anchor, attitude, attitudeReliable, rawAngles } = kin;
  const ref = contact.sampleIndex;
  const followEnd = Math.max(active.end, ref);
  const hitsWithForehandFace = hittingNormal[2] > 0;

  // 6. Preparation: from the last still moment to the start of the forward swing.
  const prepStart = kin.readyEnd;
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
  const gyroClippedInSwing = kin.gyroClippedInSwing;
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
      saturatedSamples: kin.saturatedSamples,
    },
    features: computeFeatures(kin, params, strokeType, headSpeedMps),
  };
}
