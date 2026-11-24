import type { ImuSeries, MountCalibration, TimebaseQuality } from '../domain/types';
import { mulVec } from '../math/mat3';
import { type Quat, IDENTITY_QUAT, fromRotationVector, multiply, rotate } from '../math/quat';
import {
  type Vec3,
  RAD_TO_DEG,
  UNIT_X,
  UNIT_Z,
  add,
  cross,
  dot,
  norm,
  normalize,
  scale,
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
  type ConditionedSeries,
  conditionSeries,
  isConditioned,
  sampleTimesS,
} from '../processing/condition';
import type { ClippedRun } from '../processing/declip';
import {
  type ContactReference,
  REFERENCE_INTERVAL_S,
  activeRange,
  argMax,
  contactReference,
  detectImpact,
  findPreparationStart,
  samplesFor,
} from '../processing/segmentation';
import type { AnalysisParams } from './analyzeSwing';

/** Elevation of a unit vector above the horizontal plane, deg. */
export const elevationDeg = (unit: Vec3): number =>
  Math.asin(Math.max(-1, Math.min(1, dot(unit, UNIT_Z)))) * RAD_TO_DEG;

/** Number of true flags in the inclusive range `[from, to]`. */
export const countTrue = (flags: readonly boolean[], from: number, to: number): number =>
  flags.slice(Math.max(0, from), to + 1).filter(Boolean).length;

/**
 * `maxSaturatedSamples` is counted in reference samples (1/104 s each, the
 * v1 rate); the same clipped time is allowed at any rate.
 */
export const maxSaturatedAt = (params: AnalysisParams, sampleRateHz: number): number =>
  params.maxSaturatedSamples * sampleRateHz * REFERENCE_INTERVAL_S;

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
 * Tip elevation at the contact time for overheads, deg, by carrying the
 * attitude of the last pre-impact sample forward over the remaining fraction
 * of a sample with the body rate extrapolated linearly to the middle of that
 * step. Roll about the long axis does not move the tip, so the roll leak that
 * rules this out for the swing path (see `extrapolateAngles`) does not apply.
 *
 * At contact a serve's tip is near the top of its arc, where the linear angle
 * extrapolation overshoots. On the simulated serve (SERVE_SWING, 30 rad/s,
 * tip 70°) the errors were: linear +3.0°, no extrapolation −2.0°, quadratic
 * through the last three samples +1.7°, this rotation −0.3°; over tips of
 * 50–80° and 24–34 rad/s the rotation stayed within ≈ 1.5° where the
 * quadratic reached 4.5°. Null without an attitude.
 */
export function overheadContactTipDeg(kin: SwingKinematics): number | null {
  const ref = kin.contact.sampleIndex;
  const q = kin.attitude?.[ref];
  const w = kin.gyro[ref];
  if (!q || !w) return null;
  const fraction = kin.contact.time - ref;
  const prev = kin.gyro[ref - 1] ?? w;
  const mid = add(w, scale(sub(w, prev), fraction / 2));
  const carried = multiply(q, fromRotationVector(mid, fraction / kin.sampleRateHz));
  return elevationDeg(rotate(carried, UNIT_X));
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
  /** Gyro clipped at the sensor (reconstructed or not). */
  readonly gyroSaturated: readonly boolean[];
  readonly accelSaturated: readonly boolean[];
  /** Gyro value reconstructed from a short clipped run (processing/declip.ts). */
  readonly gyroReconstructed: readonly boolean[];
  /** A gyro axis clipped and was not reconstructed (the rate is a lower bound). */
  readonly gyroUnrecovered: readonly boolean[];
  /**
   * Cumulative rotation added by the reconstruction, rad: element i is
   * Σ_{k<i} (‖ω_k‖ − ‖ω_k as clipped‖) / f_s. Differences give the
   * reconstructed rotation between two samples (for its σ).
   */
  readonly reconstructedRotationRad: readonly number[];
  /** Sample synthesised by interpolation across a short gap. */
  readonly interpolated: readonly boolean[];
  /** No data at this sample (long gap, or lost samples that cannot be located). */
  readonly gap: readonly boolean[];
  readonly timebase: TimebaseQuality;
  /** Clipped gyro runs (indices of the native samples, before resampling). */
  readonly clippedRuns: readonly ClippedRun[];
  readonly peakIndex: number;
  /** Inclusive bounds of the active phase (ω⊥ above `activeFraction` of its peak). */
  readonly active: { readonly start: number; readonly end: number };
  readonly impactIndex: number | null;
  readonly contact: ContactReference;
  /** First sample of the forward swing (start of the active phase, at most the contact sample). */
  readonly forwardStart: number;
  /** End of the ready position (first sample after the last long standstill), or null. */
  readonly readyEnd: number | null;
  /**
   * Start of the backswing (see `findBackswingStart`); null when the racket
   * already turned that fast at the first sample (backswing truncated).
   */
  readonly backswingStart: number | null;
  /** Racket-frame normal of the face that hits the ball (±ẑ). */
  readonly hittingNormal: Vec3;
  /** ‖ω × x̂‖ at the contact sample, rad/s (head speed per metre of lever). */
  readonly tipSpeedPerMetre: number;
  /** Quiet-window attitude anchor, with its window statistics; null when none qualified. */
  readonly anchor: AttitudeAnchor | null;
  /** Attitude q_WB per sample, or null without an anchor. */
  readonly attitude: readonly Quat[] | null;
  /** Clipped gyro samples (reconstructed or not) between the anchor and the contact sample. */
  readonly saturatedSamples: number;
  /** Reconstructed gyro samples between the anchor and the contact sample. */
  readonly reconstructedSamples: number;
  /**
   * ‖mean ω‖ (bias-corrected) over the stillest window of the anchor's length
   * within `RESIDUAL_BIAS_LOOKBACK_S` up to the anchor, rad/s: what is left
   * of the gyro bias after calibration, plus any slow hand motion (so an
   * upper-bound estimate). Null without an anchor.
   */
  readonly residualBiasRadPerS: number | null;
  /**
   * Head speed per metre of lever at the contact sample from the gyro as
   * clipped (before reconstruction), rad/s; equals `tipSpeedPerMetre` when
   * nothing was reconstructed there.
   */
  readonly clippedTipSpeedPerMetre: number;
  /** Length of the reconstructed run containing the peak sample, s (0 if none). */
  readonly peakReconstructedS: number;
  /**
   * Anchor valid, unrecovered gyro clipping up to contact within
   * `maxSaturatedSamples` (reconstructed samples add σ instead), no
   * gap between the anchor window and contact, no `signalGap`, and no gyro clipping near the
   * peak of a swing without detected contact (a hit hidden by clipping would
   * put the reference at the wrong moment).
   */
  readonly attitudeReliable: boolean;
  /** Gyro clipped and NOT reconstructed anywhere between forward-swing start and contact. */
  readonly gyroClippedInSwing: boolean;
  /** Gyro reconstructed anywhere between forward-swing start and contact (speed and timing use it). */
  readonly gyroReconstructedInSwing: boolean;
  /**
   * A gap lies inside the stroke (ready end or capture start … end of the
   * contact search), or an interpolated sample lies where contact is read
   * (±2 reference intervals around it; the whole search window without an
   * impact): not rated.
   */
  readonly signalGap: boolean;
  /** Angles at the two pre-impact samples, whenever an attitude exists. */
  readonly contactSamples: ContactAngleSamples | null;
  /** Contact angles extrapolated to the contact time, whenever an attitude exists. */
  readonly rawAngles: ContactAngles | null;
}

/** Any gap flag in the inclusive range `[from, to]`. */
export const gapIn = (gap: readonly boolean[], from: number, to: number): boolean =>
  countTrue(gap, Math.floor(from), Math.ceil(to)) > 0;

/**
 * Start of the backswing: the first sample in `[from, forwardStart]` at which
 * ‖ω‖ reaches max(`quietRate`, `fraction` × the largest ‖ω‖ in
 * `[from, forwardStart)`). Before it the racket only drifts out of the ready
 * position (preparation: unit turn starting, grip and stance settling); from
 * it on it is being taken back. Returns `forwardStart` when the take-back is
 * no faster than the quiet band (no distinct backswing), and null when the
 * rate is already above the threshold at `from` = 0 (capture started inside
 * the backswing).
 */
export function findBackswingStart(
  gyro: readonly Vec3[],
  from: number,
  forwardStart: number,
  fraction: number,
  quietRate: number,
): number | null {
  let peak = 0;
  for (let i = from; i < forwardStart; i++) peak = Math.max(peak, norm(gyro[i] ?? [0, 0, 0]));
  const threshold = Math.max(quietRate, fraction * peak);
  for (let i = from; i <= forwardStart; i++) {
    if (norm(gyro[i] ?? [0, 0, 0]) >= threshold) return i === 0 && from === 0 ? null : i;
  }
  return forwardStart;
}

/**
 * Look-back before the anchor for the residual-bias estimate, s. Engineering
 * choice: long enough to find a still moment, short enough that a bias step
 * long before the stroke does not hide the bias that applies to it.
 */
export const RESIDUAL_BIAS_LOOKBACK_S = 0.5;

/**
 * ‖mean ω‖ over the stillest window of `window` samples within
 * `[from, before)` in which every sample is quiet, unclipped and present,
 * rad/s; null if none.
 */
function stillestMeanRate(
  gyro: readonly Vec3[],
  saturated: readonly boolean[],
  gap: readonly boolean[],
  from: number,
  before: number,
  window: number,
  quietRate: number,
): number | null {
  let best: number | null = null;
  for (let start = from; start + window <= before; start++) {
    let sum: Vec3 = [0, 0, 0];
    let ok = true;
    for (let i = start; i < start + window && ok; i++) {
      const w = gyro[i] ?? [0, 0, 0];
      ok = !saturated[i] && !gap[i] && norm(w) < quietRate;
      sum = add(sum, w);
    }
    if (!ok) continue;
    const mean = norm(sum) / window;
    if (best === null || mean < best) best = mean;
  }
  return best;
}

interface LocatedContact {
  readonly series: ConditionedSeries;
  readonly gyro: readonly Vec3[];
  readonly accel: readonly Vec3[];
  readonly perpRate: readonly number[];
  readonly peakIndex: number;
  readonly active: { readonly start: number; readonly end: number };
  readonly impactIndex: number | null;
  readonly halfWindow: number;
}

/** Steps 1–3: racket frame, racket rate and its peak, active phase, impact. */
function locateContact(
  series: ConditionedSeries,
  calibration: MountCalibration,
  params: AnalysisParams,
): LocatedContact {
  const fs = series.sampleRateHz;
  const R = calibration.racketFromSensor;
  const gap = series.gap;

  // 1. Express everything in the racket frame, gyro bias removed.
  const gyro = series.gyro.map((w) => mulVec(R, sub(w, calibration.gyroBias)));
  const accel = series.accel.map((a) => mulVec(R, a));

  // 2. Rotation perpendicular to the long axis moves the head; roll about the
  //    long axis does not.
  const perpRate = gyro.map((w, i) => (gap[i] ? 0 : Math.hypot(w[1], w[2])));
  const peakIndex = argMax(perpRate);
  const peakRate = perpRate[peakIndex] ?? 0;
  const active = activeRange(perpRate, peakIndex, params.activeFraction * peakRate);

  // 3. Contact: jumps measured over one reference interval whatever the rate.
  //    When the peak sits on an unrecovered clipped plateau its argmax is the
  //    plateau's first sample, up to half a plateau early: the search window
  //    is then centred on the plateau and widened by half its length.
  const halfWindow = Math.round(params.impactSearchS * fs);
  let plateauFrom = peakIndex;
  let plateauTo = peakIndex;
  if (series.gyroUnrecovered[peakIndex]) {
    while (plateauFrom > 0 && series.gyroUnrecovered[plateauFrom - 1]) plateauFrom--;
    while (plateauTo < gyro.length - 1 && series.gyroUnrecovered[plateauTo + 1]) plateauTo++;
  }
  const found = detectImpact(
    accel,
    gyro,
    Math.round((plateauFrom + plateauTo) / 2),
    halfWindow + Math.ceil((plateauTo - plateauFrom) / 2),
    {
      accelG: params.impactJumpThresholdG,
      gyroRadPerS: params.impactGyroJumpRadPerS,
      spanSamples: samplesFor(REFERENCE_INTERVAL_S, fs),
      confirmFraction: params.impactConfirmFraction,
      refractorySamples: Math.round(params.impactRefractoryS * fs),
      detrendGyro: true,
    },
    { accelSaturated: series.accelSaturated, gyroUnreliable: series.gyroUnrecovered, gap },
  );
  // Both channels clipped before the candidate: neither the rate drop nor
  // the transient can place it (a gyro clipped without reconstruction within
  // the refractory window before it may hide the true onset, an accelerometer
  // already clipped before it hides the transient's start), so it is not
  // accepted as contact.
  const span = samplesFor(REFERENCE_INTERVAL_S, fs);
  const refractory = Math.max(2 * span, Math.round(params.impactRefractoryS * fs));
  const ambiguous =
    found !== null &&
    countTrue(series.gyroUnrecovered, found - refractory, found) > 0 &&
    countTrue(series.accelSaturated, found - span, found - 1) > 0;
  const impactIndex = ambiguous ? null : found;
  return { series, gyro, accel, perpRate, peakIndex, active, impactIndex, halfWindow };
}

/** Racket-frame signals, contact and segmentation; steps 1–3 of the pipeline. */
export function computeSwingKinematics(
  input: ImuSeries,
  calibration: MountCalibration,
  params: AnalysisParams,
): SwingKinematics {
  // 0. Signal path v2: resample onto the nominal grid and de-clip the gyro.
  //    Contact is located first, on the native samples taken as uniform and
  //    without reconstruction; neither the reconstruction nor the resampling
  //    may then bridge it (the racket before and after the impact are
  //    different curves): its time, midway between the native samples around
  //    it, is a barrier for both. Then contact is located again on the result.
  const native: ImuSeries = {
    sampleRateHz: input.sampleRateHz,
    accel: input.accel,
    gyro: input.gyro,
    accelSaturated: input.accelSaturated,
    gyroSaturated: input.gyroSaturated,
    triggerIndex: input.triggerIndex,
  };
  const firstPass = isConditioned(input)
    ? null
    : locateContact(conditionSeries(native, { reconstruct: false }), calibration, params);
  const nativeTimes = sampleTimesS(input);
  /** Barrier midway between the native samples around time `t` (s). */
  const barrierAt = (t: number): number[] => {
    let j = 1;
    while (j < nativeTimes.length - 1 && (nativeTimes[j] ?? 0) < t) j++;
    return [0.5 * ((nativeTimes[j - 1] ?? 0) + (nativeTimes[j] ?? 0))];
  };
  const j = firstPass?.impactIndex ?? null;
  let barrier = j === null ? [] : [0.5 * ((nativeTimes[j - 1] ?? 0) + (nativeTimes[j] ?? 0))];
  let located = locateContact(conditionSeries(input, { barriersS: barrier }), calibration, params);
  // A reconstruction can make an impact visible that the clipped data hid;
  // it must not have bridged that impact itself, so repeat once with the
  // newly found contact as the barrier (the impact may then be hidden again,
  // which is reported as such).
  if (located.impactIndex !== null && barrier.length === 0 && !isConditioned(input)) {
    barrier = barrierAt((located.impactIndex - 0.5) / input.sampleRateHz);
    located = locateContact(conditionSeries(input, { barriersS: barrier }), calibration, params);
  }
  const { series, gyro, accel, perpRate, peakIndex, active, impactIndex, halfWindow } = located;
  const fs = series.sampleRateHz;
  const R = calibration.racketFromSensor;
  const gap = series.gap;
  const contact = contactReference(impactIndex, peakIndex);
  const ref = contact.sampleIndex;
  const forwardStart = Math.min(active.start, ref);

  // 4. Kinematics at contact, racket frame, from the last pre-impact sample.
  const tipVelocityDir = cross(gyro[ref] ?? [0, 0, 0], UNIT_X); // direction of ω × r, r ∥ +x
  const tipSpeedPerMetre = norm(tipVelocityDir);
  const hittingNormal: Vec3 = dot(tipVelocityDir, UNIT_Z) >= 0 ? UNIT_Z : [0, 0, -1];

  // 5. Absolute attitude from a quiet window before the forward swing. A
  //    window must not contain missing data.
  const anchor = findAttitudeAnchor(
    {
      accel,
      gyro,
      accelSaturated: series.accelSaturated.map((s, i) => s || (gap[i] ?? false)),
      gyroSaturated: series.gyroSaturated.map((s, i) => s || (gap[i] ?? false)),
      sampleRateHz: fs,
    },
    0,
    forwardStart,
    anchorCriteria(params, fs),
  );
  const saturatedSamples = anchor ? countTrue(series.gyroSaturated, anchor.index, ref) : 0;
  const unrecoveredSamples = anchor ? countTrue(series.gyroUnrecovered, anchor.index, ref) : 0;
  const reconstructedRotationRad: number[] = [0];
  for (let i = 0; i < gyro.length; i++) {
    const raw = series.gyroClipped[i];
    const extra = series.gyroReconstructed[i] && raw ? norm(series.gyro[i] ?? raw) - norm(raw) : 0;
    reconstructedRotationRad.push((reconstructedRotationRad[i] ?? 0) + Math.max(0, extra) / fs);
  }
  const reconstructedSamples = anchor ? countTrue(series.gyroReconstructed, anchor.index, ref) : 0;
  const attitude = anchor
    ? attitudeSeries(attitudeFromGravity(anchor.gravity), gyro, anchor.index, fs)
    : null;
  // Clipping near the peak without a detected impact: a hit may be hidden
  // (both channels clipped through contact), so the reference may be wrong.
  const contactHidden =
    impactIndex === null &&
    countTrue(series.gyroSaturated, peakIndex - halfWindow, peakIndex + halfWindow) > 0;
  const contactSamples =
    attitude && tipSpeedPerMetre > 1e-6
      ? contactAngleSamples(attitude, gyro, contact, hittingNormal)
      : null;
  // Residual bias: stillest window in the 0.5 s up to the anchor (the bias
  // that applies to the integration from the anchor on).
  const residualBiasRadPerS = anchor
    ? stillestMeanRate(
        gyro,
        series.gyroSaturated,
        gap,
        Math.max(0, anchor.index - Math.round(RESIDUAL_BIAS_LOOKBACK_S * fs)),
        anchor.index + 1,
        anchor.samples,
        params.quietRateRadPerS,
      )
    : null;
  const rawAtRef = series.gyroClipped[ref];
  const clippedTipSpeedPerMetre = rawAtRef
    ? norm(cross(mulVec(R, sub(rawAtRef, calibration.gyroBias)), UNIT_X))
    : tipSpeedPerMetre;
  let runFrom = peakIndex;
  let runTo = peakIndex - 1;
  if (series.gyroReconstructed[peakIndex]) {
    runTo = peakIndex;
    while (runFrom > 0 && series.gyroReconstructed[runFrom - 1]) runFrom--;
    while (runTo < series.gyroReconstructed.length - 1 && series.gyroReconstructed[runTo + 1]) {
      runTo++;
    }
  }

  // Segmentation events next to missing data are unknown.
  const nearGap = (i: number | null): boolean => i !== null && gapIn(gap, i - 1, i + 1);
  const foundReadyEnd = findPreparationStart(
    gyro,
    forwardStart,
    params.quietRateRadPerS,
    Math.round(params.readyMinS * fs),
  );
  const readyEnd = nearGap(foundReadyEnd) ? null : foundReadyEnd;
  const foundBackswing = findBackswingStart(
    gyro,
    readyEnd ?? 0,
    forwardStart,
    params.backswingStartFraction,
    params.quietRateRadPerS,
  );
  const backswingStart = foundBackswing;
  const strokeFrom = readyEnd ?? 0;
  const strokeTo = Math.max(active.end, peakIndex + halfWindow, (impactIndex ?? ref) + 1);
  // An interpolated sample where contact is read (or, without a detected
  // impact, anywhere it could have been) may hide or blur the impact: treated
  // like a gap.
  const span = samplesFor(REFERENCE_INTERVAL_S, fs);
  const [nearFrom, nearTo] =
    impactIndex === null
      ? [peakIndex - halfWindow, peakIndex + halfWindow]
      : [ref - 2 * span, impactIndex + 2 * span];
  const interpolatedAtContact = countTrue(series.interpolated, nearFrom, nearTo) > 0;
  const signalGap = gapIn(gap, strokeFrom, strokeTo) || interpolatedAtContact;
  const gapBeforeContact = anchor ? gapIn(gap, anchor.start, ref + 1) : true;

  return {
    sampleRateHz: fs,
    gyro,
    accel,
    perpRate,
    gyroSaturated: series.gyroSaturated,
    accelSaturated: series.accelSaturated,
    gyroReconstructed: series.gyroReconstructed,
    gyroUnrecovered: series.gyroUnrecovered,
    reconstructedRotationRad,
    interpolated: series.interpolated,
    gap,
    timebase: series.timebase,
    clippedRuns: series.clippedRuns,
    peakIndex,
    active,
    impactIndex,
    contact,
    forwardStart,
    readyEnd,
    backswingStart,
    hittingNormal,
    tipSpeedPerMetre,
    anchor,
    attitude,
    saturatedSamples,
    reconstructedSamples,
    residualBiasRadPerS,
    clippedTipSpeedPerMetre,
    peakReconstructedS: (runTo - runFrom + 1) / fs,
    attitudeReliable:
      anchor !== null &&
      !gapBeforeContact &&
      !contactHidden &&
      !signalGap &&
      unrecoveredSamples <= maxSaturatedAt(params, fs),
    gyroClippedInSwing: countTrue(series.gyroUnrecovered, forwardStart, ref) > 0,
    gyroReconstructedInSwing: countTrue(series.gyroReconstructed, forwardStart, ref) > 0,
    signalGap,
    contactSamples,
    rawAngles: contactSamples ? anglesAtContact(contactSamples, contact) : null,
  };
}
