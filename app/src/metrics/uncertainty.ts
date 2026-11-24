import type { FeatureSigmaKey } from '../domain/types';
import { RAD_TO_DEG } from '../math/vec3';
import type { AttitudeAnchor } from '../processing/attitude';
import type { AnalysisParams } from './analyzeSwing';
import { type SwingKinematics, countTrue } from './kinematics';

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
}

export const DEFAULT_UNCERTAINTY_PARAMS: UncertaintyParams = {
  gyroBiasResidualDps: 1,
  anchorBoundSigmas: 3,
  swingPathModelDeg: 3,
  headSpeedModelFraction: 0.15,
  contactTimingShare: 0.5,
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

/** Attitude drift from the residual gyro bias over `elapsedS`, deg. */
export const driftSigmaDeg = (
  elapsedS: number,
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
): number => up.gyroBiasResidualDps * Math.abs(elapsedS);

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
 * (fractional sample): an anchor exists and at most `maxSaturatedSamples`
 * gyro samples clipped in between.
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
  return countTrue(kin.gyroSaturated, from, to) <= params.maxSaturatedSamples;
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
  return rss(anchorSigmaRad(anchor, up) * RAD_TO_DEG, driftSigmaDeg(elapsedS, up), ...extraDeg);
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

/** The σ record of `StrokeFeatures`. */
export function featureSigmas(
  kin: SwingKinematics,
  params: AnalysisParams,
  input: SigmaInputs,
  up: UncertaintyParams = DEFAULT_UNCERTAINTY_PARAMS,
): Readonly<Record<FeatureSigmaKey, number | null>> {
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
    headSpeedMps:
      input.headSpeedMps === null ? null : input.headSpeedMps * up.headSpeedModelFraction,
    peakSpeedOffsetMs: timed('peakSpeedOffsetMs'),
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
  const drift = driftSigmaDeg((turn.to - turn.from) / kin.sampleRateHz, up);
  return rss(drift, anchorSigmaRad(anchor, up) * turn.arcRad * RAD_TO_DEG);
}
