import type { MountCalibration, RawCapture } from '../domain/types';
import { type Mat3, fromColumns, mulVec, transpose } from '../math/mat3';
import {
  type Vec3,
  DEG_TO_RAD,
  RAD_TO_DEG,
  add,
  cross,
  dot,
  norm,
  normalize,
  scale,
  sub,
} from '../math/vec3';
import { conjugate, fromAxisAngle, rotate } from '../math/quat';
import { STANDARD_GRAVITY } from '../processing/units';
import { createRandom, gaussian } from './random';

/** LSM6DS3TR-C at ±16 g / ±2000 dps, as configured by the firmware. */
export const SENSOR_ACCEL_G_PER_LSB = 0.000488;
export const SENSOR_GYRO_DPS_PER_LSB = 0.07;

export interface SwingSpec {
  readonly hittingFace: 'forehand' | 'backhand';
  /** Elevation of the hitting-face normal at contact, deg (negative = closed). */
  readonly faceTiltDeg: number;
  /** Requested elevation of the sweet-spot velocity at contact, deg. */
  readonly swingPathDeg: number;
  /** Elevation of the racket long axis at contact, deg. */
  readonly tipElevationDeg: number;
  /** Peak angular rate, rad/s. */
  readonly peakRateRadPerS: number;
  /** Time of peak rate relative to contact, s (negative = early). */
  readonly peakOffsetS: number;
  /** Lever from centre of rotation to sweet spot, m. */
  readonly leverRadiusM: number;
  /** Distance from sensor to sweet spot along the long axis, m. */
  readonly sensorToSweetSpotM: number;
  /** Width of the acceleration and deceleration phases, s. */
  readonly riseSigmaS: number;
  readonly fallSigmaS: number;
  /**
   * Backswing: peak rate (rad/s, applied in reverse) and its lead before contact (s).
   * 0 disables it. A backswing is what first trips the sensor's trigger.
   */
  readonly backswingRateRadPerS: number;
  readonly backswingLeadS: number;
  /** Peak roll rate about the racket long axis around contact, rad/s (forearm pronation). */
  readonly rollRateRadPerS: number;
  /**
   * Offset of the centre of rotation from the racket axis, world frame, m.
   * Non-zero violates the rigid-lever assumption the analysis makes (ADR 0003).
   */
  readonly centreOffsetM: Vec3;
  readonly withImpact: boolean;
  readonly noiseStd: { readonly accelG: number; readonly gyroDps: number };
  readonly seed: number;
}

export const DEFAULT_SWING: SwingSpec = {
  hittingFace: 'forehand',
  faceTiltDeg: -12,
  swingPathDeg: 25,
  tipElevationDeg: 0,
  peakRateRadPerS: 24,
  peakOffsetS: 0,
  leverRadiusM: 1.0,
  sensorToSweetSpotM: 0.12,
  riseSigmaS: 0.09,
  fallSigmaS: 0.16,
  backswingRateRadPerS: 0,
  backswingLeadS: 0.45,
  rollRateRadPerS: 0,
  centreOffsetM: [0, 0, 0],
  withImpact: true,
  noiseStd: { accelG: 0, gyroDps: 0 },
  seed: 1,
};

export interface SimulationSetup {
  readonly sampleRateHz: number;
  readonly durationS: number;
  readonly contactTimeS: number;
  readonly mount: MountCalibration;
  /** Firmware swing trigger on ‖ω‖, rad/s. */
  readonly triggerRadPerS: number;
}

/** Geometry the simulator actually produced, for comparing against analysis. */
export interface SwingTruth {
  readonly contactIndex: number;
  readonly faceTiltDeg: number;
  readonly swingPathDeg: number;
  readonly tipElevationDeg: number;
  readonly headSpeedMps: number;
  readonly hittingFace: 'forehand' | 'backhand';
}

const UP: Vec3 = [0, 0, 1];
const elevationDeg = (v: Vec3): number => Math.asin(dot(normalize(v), UP)) * RAD_TO_DEG;

function orthogonalTo(v: Vec3, axis: Vec3): Vec3 {
  return normalize(sub(v, scale(axis, dot(v, axis))));
}

/**
 * Forward model of a swing as a rigid racket rotating about a fixed axis
 * through a fixed centre (the "rigid lever" assumption of ADR 0003), with a
 * quiet preparation phase so the attitude anchor is observable.
 *
 * World frame: x forward (towards the target), y to the hitter's side, z up.
 */
export function simulateSwing(
  spec: SwingSpec,
  setup: SimulationSetup,
  sequence = 0,
): { capture: RawCapture; truth: SwingTruth } {
  const fs = setup.sampleRateHz;
  const n = Math.round(setup.durationS * fs);
  const contactIndex = Math.round(setup.contactTimeS * fs);
  const tContact = contactIndex / fs;
  const tPeak = tContact + spec.peakOffsetS;

  // Racket attitude at contact.
  const e = spec.tipElevationDeg * DEG_TO_RAD;
  const xContact: Vec3 = [0, Math.cos(e), Math.sin(e)];
  const a = spec.swingPathDeg * DEG_TO_RAD;
  const vDir = orthogonalTo([Math.cos(a), 0, Math.sin(a)], xContact);
  const b = spec.faceTiltDeg * DEG_TO_RAD;
  const hitNormal = orthogonalTo([Math.cos(b), 0, Math.sin(b)], xContact);
  const zContact = spec.hittingFace === 'forehand' ? hitNormal : scale(hitNormal, -1);
  const yContact = cross(zContact, xContact);
  const worldFromRacketAtContact: Mat3 = fromColumns(xContact, yContact, zContact);
  const axis = normalize(cross(xContact, vDir)); // ω ∥ axis gives v ∥ vDir for r ∥ x
  const contactRacketFromWorld = transpose(worldFromRacketAtContact);

  // Angular rate: asymmetric Gaussian forward swing peaking at tPeak, plus an
  // optional reversed Gaussian backswing.
  const tBack = tContact - spec.backswingLeadS;
  const backSigma = 0.08;
  const forward = (t: number): number => {
    const s = t < tPeak ? spec.riseSigmaS : spec.fallSigmaS;
    return spec.peakRateRadPerS * Math.exp(-0.5 * ((t - tPeak) / s) ** 2);
  };
  const back = (t: number): number =>
    -spec.backswingRateRadPerS * Math.exp(-0.5 * ((t - tBack) / backSigma) ** 2);
  const rate = (t: number): number => forward(t) + back(t);
  const rateDot = (t: number): number => {
    const s = t < tPeak ? spec.riseSigmaS : spec.fallSigmaS;
    return (-forward(t) * (t - tPeak)) / s ** 2 - (back(t) * (t - tBack)) / backSigma ** 2;
  };
  const rollRate = (t: number): number =>
    spec.rollRateRadPerS * Math.exp(-0.5 * ((t - tContact) / 0.1) ** 2);

  // θ(t) and roll φ(t), relative to contact, by fine trapezoidal integration.
  const integrate = (f: (t: number) => number): Float64Array => {
    const out = new Float64Array(n);
    const steps = 20;
    const h = 1 / fs / steps;
    let acc = 0;
    for (let i = 1; i < n; i++) {
      const t0 = (i - 1) / fs;
      for (let k = 0; k < steps; k++) acc += 0.5 * (f(t0 + k * h) + f(t0 + (k + 1) * h)) * h;
      out[i] = acc;
    }
    const atContact = out[contactIndex] ?? 0;
    return out.map((v) => v - atContact);
  };
  const theta = integrate(rate);
  const roll = integrate(rollRate);

  const sensorFromRacket = transpose(setup.mount.racketFromSensor);
  // Positions relative to the centre of rotation at contact; both rotate rigidly about `axis`.
  const sensorAtContact = add(
    scale(xContact, spec.leverRadiusM - spec.sensorToSweetSpotM),
    spec.centreOffsetM,
  );
  const sweetSpotAtContact = add(scale(xContact, spec.leverRadiusM), spec.centreOffsetM);
  const random = createRandom(spec.seed);
  const accelScale = SENSOR_ACCEL_G_PER_LSB * STANDARD_GRAVITY;
  const gyroScale = SENSOR_GYRO_DPS_PER_LSB * DEG_TO_RAD;
  const samples = new Int16Array(n * 6);
  let triggerIndex = -1;

  for (let i = 0; i < n; i++) {
    const t = i / fs;
    // Attitude: swing rotation about `axis`, then roll about the racket's own long axis.
    const swingRot = fromAxisAngle(axis, theta[i] ?? 0);
    const rollRot = fromAxisAngle([1, 0, 0], roll[i] ?? 0);
    const toRacket = (vWorld: Vec3): Vec3 =>
      rotate(
        conjugate(rollRot),
        mulVec(contactRacketFromWorld, rotate(conjugate(swingRot), vWorld)),
      );

    const w = rate(t);
    const r = rotate(swingRot, sensorAtContact);
    const accelWorld = add(
      scale(cross(axis, r), rateDot(t)),
      scale(cross(axis, cross(axis, r)), w * w),
    );
    let specificForce = toRacket(add(accelWorld, [0, 0, STANDARD_GRAVITY]));
    const omega = add(toRacket(scale(axis, w)), [rollRate(t), 0, 0]);

    if (spec.withImpact && (i === contactIndex || i === contactIndex + 1)) {
      // Ball impact: a large, brief push along the hitting-face normal.
      const sign = spec.hittingFace === 'forehand' ? -1 : 1;
      specificForce = add(specificForce, [0, 0, sign * 40 * STANDARD_GRAVITY]);
    }

    const fS = mulVec(sensorFromRacket, specificForce);
    const wS = add(mulVec(sensorFromRacket, omega), setup.mount.gyroBias);
    if (triggerIndex < 0 && norm(wS) > setup.triggerRadPerS) triggerIndex = i;

    const noisyA = fS.map(
      (v) => v + gaussian(random) * spec.noiseStd.accelG * STANDARD_GRAVITY,
    ) as unknown as Vec3;
    const noisyW = wS.map(
      (v) => v + gaussian(random) * spec.noiseStd.gyroDps * DEG_TO_RAD,
    ) as unknown as Vec3;
    for (let k = 0; k < 3; k++) {
      samples[i * 6 + k] = toCounts((noisyA[k] ?? 0) / accelScale);
      samples[i * 6 + 3 + k] = toCounts((noisyW[k] ?? 0) / gyroScale);
    }
  }

  const capture: RawCapture = {
    kind: 'swing',
    sequence: sequence & 0xff,
    sampleRateHz: fs,
    accelGPerLsb: SENSOR_ACCEL_G_PER_LSB,
    gyroDpsPerLsb: SENSOR_GYRO_DPS_PER_LSB,
    triggerIndex: Math.max(0, triggerIndex),
    samples,
    receivedAt: 0,
  };

  const sweetSpotVelocity = scale(cross(axis, sweetSpotAtContact), rate(tContact));
  return {
    capture,
    truth: {
      contactIndex,
      faceTiltDeg: elevationDeg(hitNormal),
      swingPathDeg: elevationDeg(sweetSpotVelocity),
      tipElevationDeg: elevationDeg(xContact),
      headSpeedMps: norm(sweetSpotVelocity),
      hittingFace: spec.hittingFace,
    },
  };
}

/** A static capture with gravity along `upInRacket` (racket frame), e.g. for calibration. */
export function simulateStatic(
  upInRacket: Vec3,
  mount: MountCalibration,
  sampleRateHz: number,
  samplesCount: number,
): RawCapture {
  const sensorFromRacket = transpose(mount.racketFromSensor);
  const f = mulVec(sensorFromRacket, scale(normalize(upInRacket), STANDARD_GRAVITY));
  const accelScale = SENSOR_ACCEL_G_PER_LSB * STANDARD_GRAVITY;
  const gyroScale = SENSOR_GYRO_DPS_PER_LSB * DEG_TO_RAD;
  const samples = new Int16Array(samplesCount * 6);
  for (let i = 0; i < samplesCount; i++) {
    for (let k = 0; k < 3; k++) {
      samples[i * 6 + k] = toCounts((f[k] ?? 0) / accelScale);
      samples[i * 6 + 3 + k] = toCounts((mount.gyroBias[k] ?? 0) / gyroScale);
    }
  }
  return {
    kind: 'static',
    sequence: 0,
    sampleRateHz,
    accelGPerLsb: SENSOR_ACCEL_G_PER_LSB,
    gyroDpsPerLsb: SENSOR_GYRO_DPS_PER_LSB,
    triggerIndex: 0,
    samples,
    receivedAt: 0,
  };
}

const toCounts = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));
