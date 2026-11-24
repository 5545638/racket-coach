import type { ServeFeatures, StrokeFeatures, StrokePhases, StrokeType } from '../domain/types';
import { type Quat, rotate } from '../math/quat';
import { type Vec3, RAD_TO_DEG, UNIT_X, norm } from '../math/vec3';
import { rotationPath } from '../processing/segmentation';
import type { AnalysisParams } from './analyzeSwing';
import {
  type ContactAngles,
  type SwingKinematics,
  anglesAtSample,
  countTrue,
  elevationDeg,
  overheadContactTipDeg,
} from './kinematics';
import { attitudeAssessable, featureSigmas } from './uncertainty';

/**
 * Thresholds of the coaching features. All are engineering choices, not
 * values from the literature; tune them on recorded strokes.
 */
export interface FeatureParams {
  /** The follow-through ends when ω⊥ falls below this fraction of its pre-impact value. Engineering choice. */
  readonly followEndFraction: number;
  /** A standstill must last this long to end the recovery, s. Engineering choice. */
  readonly recoveryMinS: number;
  /** The racket counts as still below this ‖ω‖ during recovery, rad/s. Engineering choice. */
  readonly recoveryRateRadPerS: number;
  /** Look-back of the late-gain fraction G50, s. Engineering choice. */
  readonly lateGainLeadS: number;
  /** A dip of ω⊥ counts as a hitch when it falls this fraction below the running maximum. Engineering choice. */
  readonly hitchMinDropFraction: number;
  /** Pre-impact samples averaged for contact stability. Engineering choice. */
  readonly stabilitySamples: number;
  /** The serve trophy is searched this long before the racket drop, s. Engineering choice. */
  readonly trophySearchS: number;
  /** Roll peak is searched within contact ± this, s. Engineering choice. */
  readonly rollPeakWindowS: number;
  /** Roll angle is integrated up to this long after contact, s. Engineering choice. */
  readonly rollAngleWindowS: number;
  /**
   * Samples from the impact sample on that roll peak and roll angle skip: the
   * jolt of an off-centre hit shows at the impact sample and can ring into
   * the next one. Engineering choice (2: the impact sample and the next).
   */
  readonly rollJoltSamples: number;
}

export const DEFAULT_FEATURE_PARAMS: FeatureParams = {
  followEndFraction: 0.3,
  recoveryMinS: 0.2,
  recoveryRateRadPerS: 0.5,
  lateGainLeadS: 0.05,
  hitchMinDropFraction: 0.15,
  stabilitySamples: 3,
  trophySearchS: 0.8,
  rollPeakWindowS: 0.05,
  rollAngleWindowS: 0.1,
  rollJoltSamples: 2,
};

/** Tip (long-axis) elevation for attitude `q`, deg. */
const tipDeg = (q: Quat): number => elevationDeg(rotate(q, UNIT_X));

/** Linear interpolation of `values` at fractional index `t` (clamped to the ends). */
export function interpolate(values: readonly number[], t: number): number {
  const i0 = Math.max(0, Math.min(values.length - 1, Math.floor(t)));
  const i1 = Math.min(values.length - 1, i0 + 1);
  const frac = Math.max(0, Math.min(1, t - i0));
  const v0 = values[i0] ?? 0;
  return v0 + ((values[i1] ?? v0) - v0) * frac;
}

/**
 * ∫ values dt over the fractional sample interval `[from, to]`, exact for the
 * piecewise-linear interpolant, in value · samples (divide by the rate for seconds).
 */
export function integrateSamples(values: readonly number[], from: number, to: number): number {
  const points = [from];
  for (let i = Math.floor(from) + 1; i < to; i++) points.push(i);
  points.push(to);
  let sum = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] ?? from;
    const b = points[k] ?? to;
    sum += 0.5 * (interpolate(values, a) + interpolate(values, b)) * (b - a);
  }
  return sum;
}

/**
 * End of the follow-through: the first sample after contact at which ω⊥ is
 * below `fraction` of its pre-impact value ω⊥(t_c⁻). Null when the capture
 * ends first.
 */
export function findFollowEnd(kin: SwingKinematics, fraction: number): number | null {
  const reference = kin.perpRate[kin.contact.sampleIndex] ?? 0;
  for (let i = Math.floor(kin.contact.time) + 1; i < kin.perpRate.length; i++) {
    if ((kin.perpRate[i] ?? Infinity) < fraction * reference) return i;
  }
  return null;
}

/**
 * End of the recovery: the first sample, after `from`, that starts a run of at
 * least `minSamples` with ‖ω‖ < `quietRate`. Null when no complete run fits
 * into the capture.
 */
export function findRecoveryEnd(
  gyro: readonly Vec3[],
  from: number,
  quietRate: number,
  minSamples: number,
): number | null {
  let run = 0;
  for (let i = from; i < gyro.length; i++) {
    const w = gyro[i];
    run = w && norm(w) < quietRate ? run + 1 : 0;
    if (run >= minSamples) return i - run + 1;
  }
  return null;
}

/**
 * Dips of ω⊥ in `[from, to]`: local minima whose drop from the preceding
 * running maximum exceeds `minDropFraction` of that maximum. Hysteresis
 * (engineering choice): after a counted dip, ω⊥ must climb back by the same
 * margin above the dip's floor before another dip can count, so noise on the
 * floor of one dip is not counted twice.
 */
export function countHitches(
  perpRate: readonly number[],
  from: number,
  to: number,
  minDropFraction: number,
): number {
  let runMax = perpRate[from] ?? 0;
  let floor: number | null = null;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    const prev = perpRate[i - 1] ?? 0;
    const here = perpRate[i] ?? 0;
    const next = perpRate[i + 1] ?? here;
    runMax = Math.max(runMax, prev);
    const margin = minDropFraction * runMax;
    if (floor !== null) {
      floor = here - floor > margin ? null : Math.min(floor, here);
      continue;
    }
    if (here < prev && here <= next && runMax - here > margin) {
      count++;
      floor = here;
    }
  }
  return count;
}

/** |∫ (q ω)·ẑ dt| over `[from, to]`: rotation about the world vertical, deg. */
function verticalTurnDeg(
  attitude: readonly Quat[],
  gyro: readonly Vec3[],
  from: number,
  to: number,
  sampleRateHz: number,
): number {
  const vertical = (i: number): number => {
    const q = attitude[i];
    const w = gyro[i];
    return q && w ? rotate(q, w)[2] : 0;
  };
  let sum = 0;
  for (let i = from; i < to; i++) sum += 0.5 * (vertical(i) + vertical(i + 1));
  return Math.abs(sum / sampleRateHz) * RAD_TO_DEG;
}

/** Index of the lowest tip elevation in `[from, to]`. */
function lowestTipSample(attitude: readonly Quat[], from: number, to: number): number | null {
  let best: number | null = null;
  let bestTip = Infinity;
  for (let i = Math.max(0, from); i <= to; i++) {
    const q = attitude[i];
    if (!q) continue;
    const tip = tipDeg(q);
    if (tip < bestTip) {
      bestTip = tip;
      best = i;
    }
  }
  return best;
}

/**
 * Mean of |dφ/dt| + |ωx| over the `count` pre-impact samples, deg/s: how
 * much the hitting face turns (tilt change plus roll) just before contact.
 */
function contactStabilityDps(
  kin: SwingKinematics,
  attitude: readonly Quat[],
  count: number,
): number | null {
  const ref = kin.contact.sampleIndex;
  let sum = 0;
  for (let i = ref - count + 1; i <= ref; i++) {
    const q = attitude[i];
    const w = kin.gyro[i];
    if (!q || !w) return null;
    const closing = anglesAtSample(q, w, kin.hittingNormal).faceClosingRateDps;
    if (closing === null) return null;
    sum += Math.abs(closing) + Math.abs(w[0]) * RAD_TO_DEG;
  }
  return sum / count;
}

/**
 * G50 = 1 − ω⊥(t_c − lead) / ω⊥(t_c⁻), ω⊥ interpolated linearly. Null without
 * an impact (no contact to time from), when the gyro clipped in the forward
 * swing (the rates are lower bounds) or when the look-back leaves the capture.
 */
function lateGainFraction(kin: SwingKinematics, leadS: number): number | null {
  if (kin.impactIndex === null || kin.gyroClippedInSwing) return null;
  const t = kin.contact.time - leadS * kin.sampleRateHz;
  const reference = kin.perpRate[kin.contact.sampleIndex] ?? 0;
  if (t < 0 || reference <= 0) return null;
  return 1 - interpolate(kin.perpRate, t) / reference;
}

/** Attitude at `sample` when it can be trusted there (see `attitudeAssessable`). */
function usableAttitude(
  kin: SwingKinematics,
  params: AnalysisParams,
  sample: number | null,
): Quat | null {
  if (sample === null || !kin.attitude || !attitudeAssessable(kin, params, sample)) return null;
  return kin.attitude[sample] ?? null;
}

interface ServeResult {
  readonly serve: ServeFeatures;
  readonly trophySample: number | null;
  readonly dropSample: number | null;
}

/** Serve features (overheads only). */
function serveFeatures(
  kin: SwingKinematics,
  params: AnalysisParams,
  fp: FeatureParams,
): ServeResult {
  const fs = kin.sampleRateHz;
  const tc = kin.contact.time;
  const ms = (samples: number): number => (samples / fs) * 1000;
  const start = kin.readyEnd ?? kin.anchor?.index ?? null;
  const dropSample =
    kin.attitude && start !== null
      ? lowestTipSample(kin.attitude, start, kin.contact.sampleIndex)
      : null;
  const dropQ = usableAttitude(kin, params, dropSample);

  // Trophy: slowest moment before the drop. The window starts no earlier than
  // the end of the ready position, whose standstill would otherwise always win
  // (engineering choice).
  let trophySample: number | null = null;
  if (dropSample !== null) {
    const from = Math.max(0, dropSample - Math.round(fp.trophySearchS * fs), kin.readyEnd ?? 0);
    let slowest = Infinity;
    for (let i = from; i < dropSample; i++) {
      const rate = norm(kin.gyro[i] ?? [0, 0, 0]);
      if (rate < slowest) {
        slowest = rate;
        trophySample = i;
      }
    }
  }
  const trophyQ = usableAttitude(kin, params, trophySample);

  const roll = kin.gyro.map((w) => w[0]);
  const last = roll.length - 1;
  const peakFrom = Math.max(0, Math.ceil(tc - fp.rollPeakWindowS * fs));
  const peakTo = Math.min(last, Math.floor(tc + fp.rollPeakWindowS * fs));
  // The impact sample and the one after it carry the jolt of an off-centre
  // hit, not the swing's own roll: both are skipped (see rollJoltSamples).
  const joltFrom = kin.impactIndex;
  const joltTo = joltFrom === null ? null : joltFrom + fp.rollJoltSamples - 1;
  const inJolt = (i: number): boolean =>
    joltFrom !== null && joltTo !== null && i >= joltFrom && i <= joltTo;
  let rollPeakSample: number | null = null;
  for (let i = peakFrom; i <= peakTo; i++) {
    if (inJolt(i)) continue;
    if (rollPeakSample === null || Math.abs(roll[i] ?? 0) > Math.abs(roll[rollPeakSample] ?? 0)) {
      rollPeakSample = i;
    }
  }
  const peakSample = rollPeakSample ?? peakFrom;
  const angleStart = joltTo === null ? tc : joltTo + 1;
  const angleEnd = tc + fp.rollAngleWindowS * fs;
  return {
    trophySample,
    dropSample,
    serve: {
      trophyTipDeg: trophyQ ? tipDeg(trophyQ) : null,
      dropTipDeg: dropQ ? tipDeg(dropQ) : null,
      dropToContactMs: dropQ && dropSample !== null ? ms(tc - dropSample) : null,
      rollPeakDps: (roll[peakSample] ?? 0) * RAD_TO_DEG,
      rollPeakOffsetMs: ms(peakSample - tc),
      rollAngleDeg:
        angleEnd <= last && angleStart < angleEnd
          ? (integrateSamples(roll, angleStart, angleEnd) / fs) * RAD_TO_DEG
          : null,
      rollSaturated: countTrue(kin.gyroSaturated, Math.floor(peakFrom), Math.ceil(angleEnd)) > 0,
      contactTipDeg: kin.rawAngles ? overheadContactTipDeg(kin) : null,
      contactTipReliable: kin.attitudeReliable && kin.rawAngles !== null,
    },
  };
}

/** Phase timeline in ms from the capture start. */
function phases(
  kin: SwingKinematics,
  followEnd: number | null,
  recoveryEnd: number | null,
): StrokePhases {
  const ms = (samples: number | null): number | null =>
    samples === null ? null : (samples / kin.sampleRateHz) * 1000;
  return {
    readyEndMs: ms(kin.readyEnd),
    forwardStartMs: (kin.forwardStart / kin.sampleRateHz) * 1000,
    contactMs: (kin.contact.time / kin.sampleRateHz) * 1000,
    contactSample: kin.contact.sampleIndex,
    followEndMs: ms(followEnd),
    recoveryEndMs: ms(recoveryEnd),
  };
}

/**
 * Coaching features of one stroke from its kinematics. Pure function. See
 * docs/metrics.md, "Coaching features", for the definitions.
 *
 * @param strokeType classification from `analyzeSwing` (serve features need `overhead`)
 * @param headSpeedMps head speed from `analyzeSwing`, for its σ
 */
export function computeFeatures(
  kin: SwingKinematics,
  params: AnalysisParams,
  strokeType: StrokeType,
  headSpeedMps: number,
  fp: FeatureParams = DEFAULT_FEATURE_PARAMS,
): StrokeFeatures {
  const fs = kin.sampleRateHz;
  const tc = kin.contact.time;
  const ref = kin.contact.sampleIndex;
  const ms = (samples: number): number => (samples / fs) * 1000;
  const followEnd = findFollowEnd(kin, fp.followEndFraction);
  const recoveryEnd =
    followEnd === null
      ? null
      : findRecoveryEnd(
          kin.gyro,
          followEnd + 1,
          fp.recoveryRateRadPerS,
          Math.round(fp.recoveryMinS * fs),
        );

  // Contact angles are reported only with a reliable attitude, as in StrokeMetrics.
  const angles = kin.attitudeReliable ? kin.rawAngles : null;
  const turnFrom = kin.readyEnd ?? kin.anchor?.index ?? null;
  const takebackQ = usableAttitude(kin, params, kin.forwardStart);
  const takebackTurnDeg =
    kin.attitude && turnFrom !== null && takebackQ && usableAttitude(kin, params, turnFrom)
      ? verticalTurnDeg(kin.attitude, kin.gyro, turnFrom, kin.forwardStart, fs)
      : null;
  const finishQ = usableAttitude(kin, params, followEnd);
  const serve = strokeType === 'overhead' ? serveFeatures(kin, params, fp) : null;
  const racketDropSample =
    angles && kin.attitude ? lowestTipSample(kin.attitude, kin.readyEnd ?? 0, ref) : null;

  const takebackTimeMs = kin.readyEnd === null ? null : ms(tc - kin.readyEnd);
  const brakingTimeMs = followEnd === null ? null : ms(followEnd - tc);
  const recoveryMs = recoveryEnd === null ? null : ms(recoveryEnd - tc);
  const samples = kin.contactSamples;
  const rate = (pick: (a: ContactAngles) => number): number =>
    samples?.prev ? (pick(samples.last) - pick(samples.prev)) * fs : 0;

  return {
    phases: phases(kin, followEnd, recoveryEnd),
    takebackTurnDeg,
    takebackTimeMs,
    takebackTipDeg: takebackQ ? tipDeg(takebackQ) : null,
    takebackFaceDeg: takebackQ ? elevationDeg(rotate(takebackQ, kin.hittingNormal)) : null,
    lateGainFraction: lateGainFraction(kin, fp.lateGainLeadS),
    forwardSwingMs: ms(tc - kin.forwardStart),
    hitchCount: countHitches(kin.perpRate, kin.forwardStart, ref, fp.hitchMinDropFraction),
    contactStabilityDps:
      angles && kin.attitude ? contactStabilityDps(kin, kin.attitude, fp.stabilitySamples) : null,
    brushAngleDeg: angles ? angles.swingPathDeg - angles.faceTiltDeg : null,
    brakingTimeMs,
    finishTipDeg: finishQ ? tipDeg(finishQ) : null,
    recoveryMs,
    serve: serve?.serve ?? null,
    sigma: featureSigmas(kin, params, {
      contactAnglesReported: angles !== null,
      contactTipAvailable: kin.rawAngles !== null,
      contactRatesDps: {
        face: rate((a) => a.faceTiltDeg),
        path: rate((a) => a.swingPathDeg),
        tip: rate((a) => a.tipElevationDeg),
      },
      racketDropSample,
      takebackTurn:
        takebackTurnDeg !== null && turnFrom !== null
          ? {
              from: turnFrom,
              to: kin.forwardStart,
              arcRad: rotationPath(kin.gyro, turnFrom, kin.forwardStart, fs),
            }
          : null,
      takebackAnglesSample: takebackQ ? kin.forwardStart : null,
      finishSample: finishQ ? followEnd : null,
      trophySample: serve && serve.serve.trophyTipDeg !== null ? serve.trophySample : null,
      dropSample: serve && serve.serve.dropTipDeg !== null ? serve.dropSample : null,
      headSpeedMps: kin.gyroClippedInSwing ? null : headSpeedMps,
      timing: {
        peakSpeedOffsetMs: !kin.gyroClippedInSwing,
        takebackTimeMs: takebackTimeMs !== null,
        forwardSwingMs: true,
        brakingTimeMs: brakingTimeMs !== null,
        recoveryMs: recoveryMs !== null,
        dropToContactMs: serve !== null && serve.serve.dropToContactMs !== null,
        rollPeakOffsetMs: serve !== null,
      },
    }),
  };
}
