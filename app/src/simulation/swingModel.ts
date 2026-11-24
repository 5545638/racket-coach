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
  /**
   * Distance from sensor to sweet spot along the long axis, m. The sensor sits
   * `leverRadiusM − sensorToSweetSpotM` from the centre of rotation, which
   * sets its centripetal acceleration ω²r (see BUTT_CAP_MOUNT).
   */
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
  /**
   * Peak linear velocity of the centre of rotation (the hand), world frame,
   * m/s. Its magnitude follows the forward-swing rate envelope, so the hand
   * speeds up and slows down with the racket. It adds to the sweet-spot
   * velocity (true speed and path) and to the specific force, never to the
   * angular rate: the rigid-lever analysis cannot see it (ADR 0003).
   */
  readonly centreVelocityMps: Vec3;
  readonly withImpact: boolean;
  /**
   * Fraction of angular rate the racket keeps after contact. Elliott et al.
   * (1989) measured about 80 % of racket velocity retained after impact
   * (docs/research/racket-dynamics.md §1.2). 1 disables the drop.
   */
  readonly impactRateRetention: number;
  /**
   * Where in the sample interval before `contactIndex` the ball arrives:
   * contact time = (contactIndex − 1 + phase) / fs, phase in (0, 1]. Sample
   * `contactIndex` is the first to show the impact.
   */
  readonly contactPhase: number;
  /** Size of the impact transient in specific force, g (string bed ≈ 40, handle much less). */
  readonly impactAccelG: number;
  /** Jolt in roll rate at contact from an off-centre hit, rad/s. */
  readonly impactRollKickRadPerS: number;
  readonly noiseStd: { readonly accelG: number; readonly gyroDps: number };
  readonly seed: number;
}

/**
 * Reference swing for geometry tests: a 1 m lever with the sensor near the
 * string bed, so the accelerometer clips at ±16 g and the impact transient is
 * large. The ball's rate drop (80 % retained) is on by default; hand
 * translation, centre offset and roll are off. Combine with BUTT_CAP_MOUNT for
 * the real mount.
 */
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
  centreVelocityMps: [0, 0, 0],
  withImpact: true,
  impactRateRetention: 0.8,
  contactPhase: 0.5,
  impactAccelG: 40,
  impactRollKickRadPerS: 0,
  noiseStd: { accelG: 0, gyroDps: 0 },
  seed: 1,
};

/**
 * The real sensor's mount: inside the butt cap, on the racket axis at the
 * butt. Mitchell et al. (2001, serve) found the instantaneous centre of
 * rotation 12.6 cm behind and 18 cm below the butt (≈ 0.22 m away), and
 * TennisEye uses 0.2 m plus 0.52 m butt-to-face-centre = 0.72 m
 * (docs/research/racket-dynamics.md §5). Here the centre lies on the axis
 * extension 0.2 m behind the sensor, so ω²r exceeds the ±16 g range above
 * ≈ 28 rad/s and the accelerometer clips in fast swings.
 *
 * The impact transient at the handle (4 g) and the roll jolt of an
 * off-centre hit (9 rad/s) are assumptions, not measurements; bring-up must
 * replace them with recorded values.
 */
export const BUTT_CAP_MOUNT: Pick<
  SwingSpec,
  'leverRadiusM' | 'sensorToSweetSpotM' | 'impactAccelG' | 'impactRollKickRadPerS'
> = {
  leverRadiusM: 0.72,
  sensorToSweetSpotM: 0.52,
  impactAccelG: 4,
  impactRollKickRadPerS: 9,
};

export interface SimulationSetup {
  readonly sampleRateHz: number;
  readonly durationS: number;
  readonly contactTimeS: number;
  readonly mount: MountCalibration;
  /** Firmware swing trigger on ‖ω‖, rad/s. */
  readonly triggerRadPerS: number;
  /**
   * Gyro count at which the simulated sensor clips. Default 32767 (the int16
   * limit); 28571 emulates a part that stops at its nominal ±2000 dps.
   */
  readonly gyroClipCounts?: number;
}

/** Geometry the simulator actually produced, for comparing against analysis. */
export interface SwingTruth {
  /** First sample that shows the impact. */
  readonly contactIndex: number;
  /** Time of ball contact, s; kinematics below are just before it. */
  readonly contactTimeS: number;
  readonly faceTiltDeg: number;
  readonly swingPathDeg: number;
  readonly tipElevationDeg: number;
  /** Sweet-spot speed just before contact, including hand translation, m/s. */
  readonly headSpeedMps: number;
  readonly hittingFace: 'forehand' | 'backhand';
  /** Lowest tip elevation up to contact, and the hitting-face tilt at that moment. */
  readonly racketDropDeg: number;
  readonly faceAtDropDeg: number;
  /** Rate at which the hitting face closes at contact, deg/s. */
  readonly faceClosingRateDps: number;
}

const UP: Vec3 = [0, 0, 1];
const elevationDeg = (v: Vec3): number => Math.asin(dot(normalize(v), UP)) * RAD_TO_DEG;

function orthogonalTo(v: Vec3, axis: Vec3): Vec3 {
  return normalize(sub(v, scale(axis, dot(v, axis))));
}

/** ∫ f over [a, b] by the trapezoidal rule with `steps` sub-intervals. */
function integrateFine(f: (t: number) => number, a: number, b: number, steps: number): number {
  const h = (b - a) / steps;
  let sum = 0;
  for (let k = 0; k < steps; k++) sum += 0.5 * (f(a + k * h) + f(a + (k + 1) * h)) * h;
  return sum;
}

/**
 * Forward model of a swing as a rigid racket rotating about a fixed axis
 * through a centre (the "rigid lever" assumption of ADR 0003), with a quiet
 * preparation phase so the attitude anchor is observable. Optional departures
 * from the ideal: the centre may sit off the racket axis (`centreOffsetM`) and
 * translate (`centreVelocityMps`), and the ball takes rate away at contact
 * (`impactRateRetention`).
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
  const tContact = (contactIndex - 1 + spec.contactPhase) / fs;
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
  // After contact the ball has taken part of the rate away (a step in rate;
  // the impulse itself is modelled as the impact transient below).
  const retained = (t: number): number =>
    spec.withImpact && t > tContact ? spec.impactRateRetention : 1;
  const sigma = (t: number): number => (t < tPeak ? spec.riseSigmaS : spec.fallSigmaS);
  const forward = (t: number): number =>
    retained(t) * spec.peakRateRadPerS * Math.exp(-0.5 * ((t - tPeak) / sigma(t)) ** 2);
  const forwardDot = (t: number): number => (-forward(t) * (t - tPeak)) / sigma(t) ** 2;
  const back = (t: number): number =>
    -spec.backswingRateRadPerS * Math.exp(-0.5 * ((t - tBack) / backSigma) ** 2);
  const rate = (t: number): number => forward(t) + back(t);
  const rateDot = (t: number): number => forwardDot(t) - (back(t) * (t - tBack)) / backSigma ** 2;
  // Hand (centre of rotation) velocity and acceleration, following the forward swing.
  const handShare = (f: number): number =>
    spec.peakRateRadPerS > 0 ? f / spec.peakRateRadPerS : 0;
  const centreVelocity = (t: number): Vec3 => scale(spec.centreVelocityMps, handShare(forward(t)));
  const centreAccel = (t: number): Vec3 => scale(spec.centreVelocityMps, handShare(forwardDot(t)));
  const rollRate = (t: number): number =>
    spec.rollRateRadPerS * Math.exp(-0.5 * ((t - tContact) / 0.1) ** 2);

  // θ(t) and roll φ(t), relative to contact, by fine trapezoidal integration.
  const integrate = (f: (t: number) => number): Float64Array => {
    const out = new Float64Array(n);
    const steps = 20;
    for (let i = 1; i < n; i++) {
      out[i] = (out[i - 1] ?? 0) + integrateFine(f, (i - 1) / fs, i / fs, steps);
    }
    const before = contactIndex - 1;
    const atContact = (out[before] ?? 0) + integrateFine(f, before / fs, tContact, steps);
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
  const gyroClip = setup.gyroClipCounts ?? 32767;
  const samples = new Int16Array(n * 6);
  let triggerIndex = -1;
  let racketDropDeg = Number.POSITIVE_INFINITY;
  let faceAtDropDeg = 0;
  const hitNormalRacket: Vec3 = spec.hittingFace === 'forehand' ? [0, 0, 1] : [0, 0, -1];

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

    if (i < contactIndex) {
      const tip = elevationDeg(rotate(swingRot, xContact));
      if (tip < racketDropDeg) {
        racketDropDeg = tip;
        faceAtDropDeg = elevationDeg(
          rotate(swingRot, mulVec(worldFromRacketAtContact, rotate(rollRot, hitNormalRacket))),
        );
      }
    }

    const w = rate(t);
    const r = rotate(swingRot, sensorAtContact);
    // Rigid body about a moving centre: a = a_centre + α × r + ω × (ω × r).
    const accelWorld = add(
      centreAccel(t),
      add(scale(cross(axis, r), rateDot(t)), scale(cross(axis, cross(axis, r)), w * w)),
    );
    let specificForce = toRacket(add(accelWorld, [0, 0, STANDARD_GRAVITY]));
    const omega = add(toRacket(scale(axis, w)), [rollRate(t), 0, 0]);

    if (spec.withImpact && (i === contactIndex || i === contactIndex + 1)) {
      // Ball impact: a large, brief push along the hitting-face normal.
      const sign = spec.hittingFace === 'forehand' ? -1 : 1;
      specificForce = add(specificForce, [0, 0, sign * spec.impactAccelG * STANDARD_GRAVITY]);
    }
    const kick: Vec3 =
      spec.withImpact && i === contactIndex ? [spec.impactRollKickRadPerS, 0, 0] : [0, 0, 0];

    const fS = mulVec(sensorFromRacket, specificForce);
    const wS = add(mulVec(sensorFromRacket, add(omega, kick)), setup.mount.gyroBias);
    if (triggerIndex < 0 && norm(wS) > setup.triggerRadPerS) triggerIndex = i;

    const noisyA = fS.map(
      (v) => v + gaussian(random) * spec.noiseStd.accelG * STANDARD_GRAVITY,
    ) as unknown as Vec3;
    const noisyW = wS.map(
      (v) => v + gaussian(random) * spec.noiseStd.gyroDps * DEG_TO_RAD,
    ) as unknown as Vec3;
    for (let k = 0; k < 3; k++) {
      samples[i * 6 + k] = toCounts((noisyA[k] ?? 0) / accelScale);
      samples[i * 6 + 3 + k] = toCounts((noisyW[k] ?? 0) / gyroScale, gyroClip);
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

  // Just before contact (rate(tContact) is the pre-impact rate).
  const sweetSpotVelocity = add(
    scale(cross(axis, sweetSpotAtContact), rate(tContact)),
    centreVelocity(tContact),
  );
  // At contact the racket is at its contact attitude: ω = θ̇·axis + φ̇·x.
  const omegaAtContact = add(scale(axis, rate(tContact)), scale(xContact, rollRate(tContact)));
  const normalRate = dot(cross(omegaAtContact, hitNormal), UP);
  const faceClosingRateDps = (-normalRate / Math.cos(b)) * RAD_TO_DEG;
  return {
    capture,
    truth: {
      contactIndex,
      contactTimeS: tContact,
      faceTiltDeg: elevationDeg(hitNormal),
      swingPathDeg: elevationDeg(sweetSpotVelocity),
      tipElevationDeg: elevationDeg(xContact),
      headSpeedMps: norm(sweetSpotVelocity),
      hittingFace: spec.hittingFace,
      racketDropDeg,
      faceAtDropDeg,
      faceClosingRateDps,
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

const toCounts = (v: number, clip = 32767): number =>
  Math.max(-clip - 1, Math.min(clip, Math.round(v)));
