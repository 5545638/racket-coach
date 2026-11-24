import type {
  ImuSeries,
  MountCalibration,
  StrokeMetrics,
  StrokeType,
  SwingSize,
  SwingStyle,
} from '../domain/types';
import { type Quat, rotate } from '../math/quat';
import { type Vec3, RAD_TO_DEG, UNIT_X, norm } from '../math/vec3';
import {
  REFERENCE_INTERVAL_S,
  longestQuietRun,
  rotationPath,
  samplesFor,
} from '../processing/segmentation';
import { computeFeatures } from './features';
import {
  computeSwingKinematics,
  elevationDeg,
  overheadContactTipDeg,
  resolutionHzAt,
} from './kinematics';

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
  /**
   * Jump in specific force over one reference interval (1/104 s, i.e. one
   * sample at 104 Hz, round(f_s/104) samples at other rates) that counts as
   * ball contact, g. Measuring over a fixed time keeps the smooth swing's
   * contribution, and therefore the threshold's meaning, rate-independent.
   */
  readonly impactJumpThresholdG: number;
  /**
   * Jump in angular rate over one reference interval that counts as ball
   * contact, rad/s. A full swing changes by < 2 rad/s per 1/104 s.
   */
  readonly impactGyroJumpRadPerS: number;
  /**
   * Consistency: a candidate on one channel needs at least this fraction of
   * the other channel's threshold, when that channel is usable (unclipped,
   * no gap). Engineering choice: 0.25 (1.5 g, 1.75 rad/s) accepts the
   * simulated butt-cap hit (4 g with a 20 % rate drop) and rejects
   * accelerometer-only vibration and bounces that leave the rate unchanged.
   */
  readonly impactConfirmFraction: number;
  /**
   * Jumps within this time before the strongest one belong to the same
   * impact; the onset is searched only there, s. Engineering choice.
   */
  readonly impactRefractoryS: number;
  /**
   * The backswing starts when ‖ω‖ first reaches this fraction of its largest
   * value between the ready end and the forward swing (and at least the
   * quiet rate). Engineering choice.
   */
  readonly backswingStartFraction: number;
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
   * Max gyro samples clipped WITHOUT reconstruction between the attitude
   * anchor and contact (or another event) for angles to be reported, counted
   * in reference samples of 1/104 s (at 416 Hz four times as many samples are
   * allowed: the same clipped time). An unreconstructed clipped sample loses
   * an unknown amount of rotation: in simulation 6 samples cost ≈ 1° on a
   * swing just above full scale but ≈ 8° on the butt-cap swing at 42 rad/s
   * (robustness.test.ts), so analysis version 5 allows only 1. Reconstructed
   * samples do not count; they widen σ instead (uncertainty.ts).
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
  /**
   * Per-capture gyro bias re-estimation (processing/gyroBias.ts). The still
   * window ending at the attitude anchor is extended backwards up to
   * `biasWindowMaxS`; it must last at least `biasWindowMinS`. A mean rate
   * above `biasMaxDps` is not believed to be bias (LSM6DS3TR-C zero-rate level
   * ±3 dps typical; 0 disables re-estimation). The window's accelerometer
   * must be able to see a rotation of `biasMaxUndetectedDps` (else it cannot
   * tell slow motion from bias). Engineering choices; analysis version 6.
   */
  readonly biasWindowMinS: number;
  readonly biasWindowMaxS: number;
  readonly biasMaxDps: number;
  readonly biasMaxUndetectedDps: number;
  /**
   * A capture whose IMU temperature differs from the calibration's by more
   * than this gets `quality.temperatureDriftC` (the zero-rate level moves by
   * up to 0.05 dps/°C, datasheet), °C. Engineering choice.
   */
  readonly temperatureWarnC: number;
}

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  leverRadiusM: 0.72,
  impactJumpThresholdG: 6,
  impactGyroJumpRadPerS: 7,
  impactConfirmFraction: 0.25,
  impactRefractoryS: 0.03,
  backswingStartFraction: 0.3,
  sliceMaxPathDeg: -8,
  impactSearchS: 0.08,
  activeFraction: 0.15,
  anchorWindowS: 0.1,
  anchorMaxAccelStdG: 0.03,
  anchorMaxAccelDriftG: 0.01,
  maxAnchorErrorG: 0.05,
  maxSaturatedSamples: 1,
  overheadTipElevationDeg: 35,
  compactMaxSpeedMps: 14,
  compactMaxArcDeg: 80,
  quietRateRadPerS: 0.5,
  readyMinS: 0.3,
  biasWindowMinS: 0.1,
  biasWindowMaxS: 0.5,
  biasMaxDps: 5,
  biasMaxUndetectedDps: 1,
  temperatureWarnC: 10,
};

/** Temperature of the capture against the calibration's (both optional). */
function temperatureQuality(
  captureC: number | undefined,
  calibrationC: number | undefined,
  warnC: number,
): { readonly temperatureDeltaC?: number; readonly temperatureWarning?: boolean } {
  if (captureC === undefined || calibrationC === undefined) return {};
  const delta = captureC - calibrationC;
  return { temperatureDeltaC: delta, temperatureWarning: Math.abs(delta) > warnC };
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
 * Sample of steepest rise in ω⊥ in `[from, to]`, by central difference over
 * ±`half` samples (one reference interval each way, so the difference spans
 * the same time at every rate). The caller keeps `to + half` before the
 * impact so the post-impact drop never counts.
 */
function steepestRise(perpRate: readonly number[], from: number, to: number, half: number): number {
  let best = from;
  let bestRise = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(half, from); i <= to && i < perpRate.length - half; i++) {
    const rise = (perpRate[i + half] ?? 0) - (perpRate[i - half] ?? 0);
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
  //    Reconstructed clipping (processing/declip.ts) does not withhold them;
  //    a gap inside the stroke does.
  const timingWithheld = kin.gyroClippedInSwing || kin.signalGap;
  const half = samplesFor(REFERENCE_INTERVAL_S, fs);
  const peakAccelIndex = steepestRise(perpRate, forwardStart, ref - half, half);

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

  // Overheads: the tip is near the top of its arc at contact, where the linear
  // angle extrapolation overshoots; carry the attitude forward instead.
  const tipElevationDeg = angles
    ? strokeType === 'overhead'
      ? overheadContactTipDeg(kin)
      : angles.tipElevationDeg
    : null;

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
    tipElevationDeg,
    peakSpeedOffsetMs: timingWithheld ? null : msFromSamples(peakIndex - contact.time),
    preparationTimeMs:
      prepStart === null || kin.signalGap ? null : msFromSamples(contact.time - prepStart),
    backswingArcDeg,
    backswingPauseMs: msFromSamples(pauseSamples),
    racketDropDeg: drop.racketDropDeg,
    faceAtDropDeg: drop.faceAtDropDeg,
    peakAccelerationOffsetMs: timingWithheld ? null : msFromSamples(peakAccelIndex - contact.time),
    faceClosingRateDps: angles?.faceClosingRateDps ?? null,
    forwardSwingArcDeg,
    followThroughArcDeg,
    quality: {
      attitudeReliable,
      anchorErrorG: anchor?.errorG ?? null,
      gyroSaturated: kin.gyroClippedInSwing,
      saturatedSamples: kin.saturatedSamples,
      gyroReconstructed: kin.gyroReconstructedInSwing,
      reconstructedSamples: kin.reconstructedSamples,
      timebase: kin.timebase,
      signalGap: kin.signalGap,
      gyroBiasCorrectionDps:
        kin.biasEstimate?.decision === 'accepted'
          ? norm(kin.biasEstimate.meanRadPerS) * RAD_TO_DEG
          : 0,
      ...temperatureQuality(kin.temperatureC, calibration.temperatureC, params.temperatureWarnC),
      ...(kin.gyroMeasured
        ? {
            highRate: {
              measuredGyroSamples: kin.gyroMeasured.filter(Boolean).length,
              contactMeasured: resolutionHzAt(kin, ref) === fs,
            },
          }
        : {}),
    },
    features: computeFeatures(kin, params, strokeType, headSpeedMps),
  };
}
