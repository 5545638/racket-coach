import { type Vec3, add, cross, dot, norm, normalize, scale, sub } from '../math/vec3';
import { STANDARD_GRAVITY } from './units';

/**
 * Per-capture gyro bias re-estimation (docs/metrics.md, "Gyro bias
 * re-estimation").
 *
 * In the quiet window that anchors the attitude the racket is (nearly)
 * still, so the mean gyro rate there, after the calibration bias was
 * removed, is the residual bias: calibration error plus temperature drift
 * (LSM6DS3TR-C zero-rate level ±3 dps, ±0.05 dps/°C, datasheet). Removing it
 * for the whole capture takes the drift out of every integrated angle.
 *
 * The danger is a racket that really turns slowly: its rotation would be
 * subtracted as "bias" and every later angle would drift by it. A real
 * rotation perpendicular to gravity turns the gravity vector the
 * accelerometer sees; a bias does not. So the estimate is used only when the
 * raw specific force keeps its direction while the gyro claims it should
 * have turned, and when that test can resolve the motion at all.
 * Rotation about the vertical leaves gravity unchanged and cannot be told
 * from bias: the plausibility limit bounds what such a motion can cost.
 */
export interface BiasParams {
  /** Minimum length of the still window, s. */
  readonly minWindowS: number;
  /** The window is extended backwards from the anchor up to this length, s. */
  readonly maxWindowS: number;
  /** Largest believable residual bias, deg/s (0 disables re-estimation). */
  readonly maxBiasDps: number;
  /**
   * The accelerometer test must be able to see a rotation of this rate or
   * more (6 σ of the direction noise over the half-window spacing), deg/s;
   * otherwise the window cannot tell motion from bias and the calibration
   * bias is kept.
   */
  readonly maxUndetectedRateDps: number;
  /** Every sample of the window turns slower than this, rad/s. */
  readonly quietRateRadPerS: number;
}

export interface BiasInput {
  /** Racket-frame gyro with the calibration bias removed, rad/s. */
  readonly gyro: readonly Vec3[];
  /** Racket-frame specific force, m/s². */
  readonly accel: readonly Vec3[];
  /** Samples that may not be used (clipped, missing). */
  readonly unusable: readonly boolean[];
  readonly sampleRateHz: number;
}

export type BiasDecision =
  'accepted' | 'window-too-short' | 'implausible' | 'unresolvable' | 'gravity-turned';

export interface BiasEstimate {
  /** Mean rate over the window, racket frame, rad/s. */
  readonly meanRadPerS: Vec3;
  /** Inclusive sample range of the window. */
  readonly start: number;
  readonly end: number;
  readonly windowS: number;
  /** Angle between the mean specific force of the window's halves, rad. */
  readonly gravityTurnRad: number;
  /** What the gyro mean would turn gravity by between the halves if it were real motion, rad. */
  readonly predictedTurnRad: number;
  /** 1σ of `gravityTurnRad` from the accelerometer noise, rad. */
  readonly turnNoiseRad: number;
  readonly decision: BiasDecision;
}

const DEG = Math.PI / 180;

const mean = (vs: readonly Vec3[]): Vec3 =>
  scale(
    vs.reduce<Vec3>((acc, v) => add(acc, v), [0, 0, 0]),
    1 / Math.max(1, vs.length),
  );

/**
 * Residual-bias estimate over the still window ending at `anchorIndex`: the
 * longest run (≤ `maxWindowS`) of usable samples rotating slower than the
 * quiet rate. Null when no sample there qualifies.
 */
export function estimateGyroBias(
  input: BiasInput,
  anchorIndex: number,
  params: BiasParams,
): BiasEstimate | null {
  const fs = input.sampleRateHz;
  const still = (i: number): boolean =>
    !(input.unusable[i] ?? true) && norm(input.gyro[i] ?? [9, 9, 9]) < params.quietRateRadPerS;
  if (!still(anchorIndex)) return null;
  let start = anchorIndex;
  const earliest = Math.max(0, anchorIndex - Math.round(params.maxWindowS * fs) + 1);
  while (start > earliest && still(start - 1)) start--;
  const end = anchorIndex;
  const count = end - start + 1;
  const windowS = count / fs;
  const gyro = input.gyro.slice(start, end + 1);
  const accel = input.accel.slice(start, end + 1);
  const b = mean(gyro);

  const half = Math.floor(count / 2);
  const first = mean(accel.slice(0, half));
  const second = mean(accel.slice(count - half));
  const g = normalize(add(first, second));
  const gravityTurnRad = half > 0 ? Math.atan2(norm(cross(first, second)), dot(first, second)) : 0;
  // Centres of the two halves are (count − half) samples apart.
  const spacingS = (count - half) / fs;
  const predictedTurnRad = norm(sub(b, scale(g, dot(b, g)))) * spacingS;
  // Direction noise from sample-to-sample differences (insensitive to a slow
  // trend): per-axis σ ≈ rms(Δa)/√2, in g ≈ rad; each half mean has σ/√half,
  // their difference √2 times that.
  let sq = 0;
  for (let i = 1; i < count; i++) {
    const d = sub(accel[i] ?? [0, 0, 0], accel[i - 1] ?? [0, 0, 0]);
    sq += dot(d, d) / 3;
  }
  const sampleSigma = count > 1 ? Math.sqrt(sq / (count - 1) / 2) / STANDARD_GRAVITY : 0;
  const turnNoiseRad = half > 0 ? (Math.SQRT2 * sampleSigma) / Math.sqrt(half) : Infinity;

  let decision: BiasDecision = 'accepted';
  if (windowS < params.minWindowS - 1e-9) decision = 'window-too-short';
  else if (norm(b) > params.maxBiasDps * DEG) decision = 'implausible';
  else if ((6 * turnNoiseRad) / spacingS > params.maxUndetectedRateDps * DEG)
    decision = 'unresolvable';
  else if (gravityTurnRad > 0.5 * predictedTurnRad + 3 * turnNoiseRad) decision = 'gravity-turned';
  return {
    meanRadPerS: b,
    start,
    end,
    windowS,
    gravityTurnRad,
    predictedTurnRad,
    turnNoiseRad,
    decision,
  };
}
