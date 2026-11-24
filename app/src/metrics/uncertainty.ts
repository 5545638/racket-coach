import type { FeatureSigmaKey } from '../domain/types';
import { RAD_TO_DEG } from '../math/vec3';
import type { AttitudeAnchor } from '../processing/attitude';
import type { AnalysisParams } from './analyzeSwing';
import { type SwingKinematics, countTrue, gapIn, maxSaturatedAt } from './kinematics';

/**
 * Inputs of the uncertainty model. Every value is an engineering assumption
 * to be checked against recorded data (docs/metrics.md, "Uncertainty").
 */
export interface UncertaintyParams {
  /**
   * Residual gyro bias after calibration, deg/s: calibration residual plus
   * temperature drift. Engineering assumption, not measured on this sensor.
   */
  readonly gyroBiasResidualDps: number;
  /**
   * The tilt bound √(2 e_g) from the anchor's gravity error is treated as
   * this many σ. Engineering choice.
   */
  readonly anchorBoundSigmas: number;
  /**
   * Model error of the swing path, deg: the rigid-lever model cannot see hand
   * translation (≈ 2° per m/s of upward hand speed at 24 m/s head speed in
   * simulation, app/test/metrics/simulatorRealism.test.ts). Engineering choice.
   */
  readonly swingPathModelDeg: number;
  /**
   * Relative model error of head speed (lever length and centre of rotation
   * unknown, ADR 0003). Engineering choice.
   */
  readonly headSpeedModelFraction: number;
  /**
   * Share of the sample-quantisation error left after extrapolating contact
   * angles by half a sample. Engineering choice (spec: ½).
   */
  readonly contactTimingShare: number;
  /**
   * 1-σ error of a reconstructed (de-clipped) rate as a fraction of the part
   * added above the clipped value. Engineering choice, checked in simulation
   * (app/test/processing/declip.test.ts: errors stayed below a fifth of the
   * excess for Gaussian-like peaks of 2200–2800 dps).
   */
  readonly declipExcessFraction: number;
}

export const DEFAULT_UNCERTAINTY_PARAMS: UncertaintyParams = {
  gyroBiasResidualDps: 1,
  anchorBoundSigmas: 3,
  swingPathModelDeg: 3,
  headSpeedModelFraction: 0.15,
  contactTimingShare: 0.5,
  declipExcessFraction: 0.3,
};

/** Root-sum-square of independent 1-σ terms. */
export const rss = (...terms: readonly number[]): number =>
  Math.sqrt(terms.reduce((acc, t) => acc + t * t, 0));

/** Standard deviation of a uniform quantisation error of one sample, s. */
const quantisationS = (sampleRateHz: number): number => 1 / sampleRateHz / Math.sqrt(12);

/**
 * 1-σ tilt error of the attitude anchor, rad.
 *
 * Noise: the mean per-axis spread of the specific force over the window,
 * divided by √N (in g, which for small angles is radians of tilt).
 * Bias: a steady acceleration a_p perpendicular to gravity raises ‖ā‖ by
 * e_g ≈ a_p²/2 while tilting the apparent vertical by ≈ a_p, so the tilt is
 * ≈ √(2 e_g); that bound is taken as `anchorBoundSigmas` σ. The larger of the
 * two terms is returned (they describe the same window, not independent errors).
 */
export function anchorSigmaRad(
  anchor: Pick<AttitudeAnchor, 'errorG' | 'accelStdG' | 'samples'>,
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
): number {
  const meanStdG = (anchor.accelStdG[0] + anchor.accelStdG[1] + anchor.accelStdG[2]) / 3;
  const noise = meanStdG / Math.sqrt(Math.max(1, anchor.samples));
  const bias = Math.sqrt(2 * anchor.errorG) / up.anchorBoundSigmas;
  return Math.max(noise, bias);
}

/**
 * Attitude drift from the residual gyro bias over `elapsedS`, deg. The bias
 * is the model value, or the residual measured on the stillest window before
 * the swing (`measuredBiasDps`) when that is larger: a wrong calibration bias
 * then widens σ instead of leaving it confidently small.
 */
export const driftSigmaDeg = (
  elapsedS: number,
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
  measuredBiasDps: number | null = null,
): number => Math.max(up.gyroBiasResidualDps, measuredBiasDps ?? 0) * Math.abs(elapsedS);

/** Measured residual bias of a stroke, deg/s (see `SwingKinematics.residualBiasRadPerS`). */
const measuredBiasDps = (kin: SwingKinematics): number | null =>
  kin.residualBiasRadPerS === null ? null : kin.residualBiasRadPerS * RAD_TO_DEG;

/** 1-σ of a time read from sample indices, ms: T_s / √12 (≈ 2.8 ms at 104 Hz). */
export const timingSigmaMs = (sampleRateHz: number): number => quantisationS(sampleRateHz) * 1000;

/**
 * 1-σ of an angle extrapolated to the contact time, from the angle's rate
 * `rateDps`: |dx/dt| · T_s/√12 · share (½: the extrapolation removes about
 * half of the quantisation error).
 */
export const contactTimingSigmaDeg = (
  rateDps: number,
  sampleRateHz: number,
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
): number => Math.abs(rateDps) * quantisationS(sampleRateHz) * up.contactTimingShare;

/**
 * True when the attitude can be assessed between the anchor and `event`
 * (fractional sample): an anchor exists, at most `maxSaturatedSamples`
 * reference samples' worth of gyro samples clipped without reconstruction
 * in between, and no data is missing from the anchor window to the event.
 */
export function attitudeAssessable(
  kin: SwingKinematics,
  params: AnalysisParams,
  event: number,
): boolean {
  const anchor = kin.anchor;
  if (!anchor || !kin.attitude) return false;
  const from = Math.min(anchor.index, Math.floor(event));
  const to = Math.max(anchor.index, Math.ceil(event));
  if (gapIn(kin.gap, Math.min(from, anchor.start), to)) return false;
  return countTrue(kin.gyroUnrecovered, from, to) <= maxSaturatedAt(params, kin.sampleRateHz);
}

/**
 * Total 1-σ of an attitude-derived angle at `event` (fractional sample), deg:
 * RSS of anchor tilt, gyro drift since the anchor and the given extra terms
 * (timing, model). Null when the attitude is not assessable there.
 */
export function angleSigmaDeg(
  kin: SwingKinematics,
  params: AnalysisParams,
  event: number,
  extraDeg: readonly number[] = [],
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
): number | null {
  const anchor = kin.anchor;
  if (!anchor || !attitudeAssessable(kin, params, event)) return null;
  const elapsedS = (event - anchor.index) / kin.sampleRateHz;
  return rss(
    anchorSigmaRad(anchor, up) * RAD_TO_DEG,
    driftSigmaDeg(elapsedS, up, measuredBiasDps(kin)),
    reconstructionSigmaDeg(kin, anchor.index, event, up),
    ...extraDeg,
  );
}

/**
 * Attitude σ from reconstructed clipping between samples `a` and `b`, deg:
 * `declipExcessFraction` of the rotation the reconstruction added there (the
 * same model as for the reconstructed rate).
 */
export function reconstructionSigmaDeg(
  kin: SwingKinematics,
  a: number,
  b: number,
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
): number {
  const cum = kin.reconstructedRotationRad;
  const at = (x: number): number => cum[Math.max(0, Math.min(cum.length - 1, Math.round(x)))] ?? 0;
  return up.declipExcessFraction * Math.abs(at(b + 1) - at(Math.min(a, b))) * RAD_TO_DEG;
}

/** Event samples and values the σ record needs; null where a feature is unavailable. */
export interface SigmaInputs {
  /** Contact angles (face, path, tip) are reported (reliable attitude). */
  readonly contactAnglesReported: boolean;
  /** Contact tip elevation exists (classification attitude). */
  readonly contactTipAvailable: boolean;
  /** Rates of face, path and tip elevation at contact, deg/s (finite difference). */
  readonly contactRatesDps: { readonly face: number; readonly path: number; readonly tip: number };
  readonly racketDropSample: number | null;
  readonly takebackTurn: {
    readonly from: number;
    readonly to: number;
    readonly arcRad: number;
  } | null;
  readonly takebackAnglesSample: number | null;
  readonly finishSample: number | null;
  readonly trophySample: number | null;
  readonly dropSample: number | null;
  readonly headSpeedMps: number | null;
  /** Head speed from the gyro as clipped (equals `headSpeedMps` without reconstruction), m/s. */
  readonly headSpeedFloorMps?: number;
  /** Timing features that are available. */
  readonly timing: Readonly<
    Record<
      | 'peakSpeedOffsetMs'
      | 'takebackTimeMs'
      | 'forwardSwingMs'
      | 'brakingTimeMs'
      | 'recoveryMs'
      | 'dropToContactMs'
      | 'rollPeakOffsetMs',
      boolean
    >
  >;
}

const SIGMA_KEYS: readonly FeatureSigmaKey[] = [
  'faceTiltDeg',
  'swingPathDeg',
  'tipElevationDeg',
  'brushAngleDeg',
  'racketDropDeg',
  'takebackTurnDeg',
  'takebackTipDeg',
  'takebackFaceDeg',
  'finishTipDeg',
  'trophyTipDeg',
  'dropTipDeg',
  'contactTipDeg',
  'headSpeedMps',
  'peakSpeedOffsetMs',
  'takebackTimeMs',
  'forwardSwingMs',
  'brakingTimeMs',
  'recoveryMs',
  'dropToContactMs',
  'rollPeakOffsetMs',
];

/** The σ record of `StrokeFeatures`. */
export function featureSigmas(
  kin: SwingKinematics,
  params: AnalysisParams,
  input: SigmaInputs,
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
): Readonly<Record<FeatureSigmaKey, number | null>> {
  // A gap inside the stroke: nothing is assessable.
  if (kin.signalGap)
    return Object.fromEntries(SIGMA_KEYS.map((k) => [k, null])) as Record<FeatureSigmaKey, null>;
  const fs = kin.sampleRateHz;
  const tc = kin.contact.time;
  const at = (sample: number | null, extra: readonly number[] = []): number | null =>
    sample === null ? null : angleSigmaDeg(kin, params, sample, extra, up);
  // Without an impact the contact reference is the peak sample itself: no extrapolation.
  const timing = (rate: number): number =>
    kin.impactIndex === null ? 0 : contactTimingSigmaDeg(rate, fs, up);
  const rates = input.contactRatesDps;
  const tip = input.contactTipAvailable ? at(tc, [timing(rates.tip)]) : null;
  const face = input.contactAnglesReported ? at(tc, [timing(rates.face)]) : null;
  const path = input.contactAnglesReported
    ? at(tc, [timing(rates.path), up.swingPathModelDeg])
    : null;
  const t = timingSigmaMs(fs);
  const timed = (key: keyof SigmaInputs['timing']): number | null => (input.timing[key] ? t : null);
  // Reconstructed clipping: the peak time is uniform over the reconstructed
  // run (≤ maxRunS), and the rate carries a fraction of the added excess.
  const peakTiming = input.timing.peakSpeedOffsetMs
    ? rss(t, (kin.peakReconstructedS * 1000) / Math.sqrt(12))
    : null;
  const headSpeed =
    input.headSpeedMps === null
      ? null
      : rss(
          input.headSpeedMps * up.headSpeedModelFraction,
          Math.max(0, input.headSpeedMps - (input.headSpeedFloorMps ?? input.headSpeedMps)) *
            up.declipExcessFraction,
        );
  return {
    faceTiltDeg: face,
    swingPathDeg: path,
    tipElevationDeg: input.contactAnglesReported ? tip : null,
    // Treats face and path errors as independent; overestimates the shared anchor tilt.
    brushAngleDeg: face === null || path === null ? null : rss(face, path),
    racketDropDeg: at(input.racketDropSample),
    takebackTurnDeg: turnSigmaDeg(kin, params, input.takebackTurn, up),
    takebackTipDeg: at(input.takebackAnglesSample),
    takebackFaceDeg: at(input.takebackAnglesSample),
    finishTipDeg: at(input.finishSample),
    trophyTipDeg: at(input.trophySample),
    dropTipDeg: at(input.dropSample),
    contactTipDeg: tip,
    headSpeedMps: headSpeed,
    peakSpeedOffsetMs: peakTiming,
    takebackTimeMs: timed('takebackTimeMs'),
    forwardSwingMs: timed('forwardSwingMs'),
    brakingTimeMs: timed('brakingTimeMs'),
    recoveryMs: timed('recoveryMs'),
    dropToContactMs: timed('dropToContactMs'),
    rollPeakOffsetMs: timed('rollPeakOffsetMs'),
  };
}

/**
 * 1-σ of the take-back turn about the vertical, deg: the residual bias
 * integrates directly into the turn over the interval, and an anchor tilt of
 * δ mixes at most δ · (rotation path) of horizontal rotation into the
 * vertical component.
 */
function turnSigmaDeg(
  kin: SwingKinematics,
  params: AnalysisParams,
  turn: SigmaInputs['takebackTurn'],
  up: UncertaintyParams,
): number | null {
  const anchor = kin.anchor;
  if (turn === null || !anchor) return null;
  if (!attitudeAssessable(kin, params, turn.from) || !attitudeAssessable(kin, params, turn.to)) {
    return null;
  }
  const drift = driftSigmaDeg((turn.to - turn.from) / kin.sampleRateHz, up, measuredBiasDps(kin));
  return rss(drift, anchorSigmaRad(anchor, up) * turn.arcRad * RAD_TO_DEG);
}
