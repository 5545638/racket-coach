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
  /** Time of the roll-rate peak relative to contact, s (serves pronate mostly after contact). */
  readonly rollPeakOffsetS: number;
  /** Width (σ) of the roll-rate Gaussian, s. */
  readonly rollSigmaS: number;
  /**
   * A hitch in the forward swing: the rate is multiplied by
   * 1 − depth · exp(−½((t − t_c − at)/width)²). Depth 0 disables it.
   */
  readonly hitchDepth: number;
  readonly hitchAtS: number;
  readonly hitchWidthS: number;
  /**
   * Take-back turn about the world vertical, deg: the racket starts at heading
   * −turn and turns (smoothly, quintic smoothstep) to its contact heading
   * between `takebackTurnStartS` and `takebackTurnStartS + takebackTurnDurationS`
   * (relative to contact). A vertical rotation changes no elevation. 0 disables it.
   * Hand translation (`centreVelocityMps`) is ignored in its acceleration terms.
   */
  readonly takebackTurnDeg: number;
  readonly takebackTurnStartS: number;
  readonly takebackTurnDurationS: number;
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
  /**
   * Duration of the impact transient after contact, s. Default (when
   * absent) 2/104 s: the two samples at 104 Hz that v1 simulations used.
   */
  readonly impactDurationS?: number;
  /** Jolt in roll rate at contact from an off-centre hit, rad/s. */
  readonly impactRollKickRadPerS: number;
  /** Duration of the roll jolt after contact, s. Default 1/104 s (one sample at 104 Hz). */
  readonly impactKickDurationS?: number;
  /** White noise per sample (1 σ), independent of the sample rate. */
  readonly noiseStd: { readonly accelG: number; readonly gyroDps: number };
  /**
   * White noise given as a density (datasheet style), added to `noiseStd`:
   * per-sample σ = density · √(f_s / 2), i.e. a noise bandwidth of half the
   * sample rate (an approximation; the real bandwidth depends on the filter
   * configuration). LSM6DS3TR-C typical: 130 µg/√Hz at ±16 g, 5 mdps/√Hz.
   */
  readonly noiseDensity?: {
    readonly accelUgPerRtHz: number;
    readonly gyroMdpsPerRtHz: number;
  };
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
  rollPeakOffsetS: 0,
  rollSigmaS: 0.1,
  hitchDepth: 0,
  hitchAtS: -0.1,
  hitchWidthS: 0.015,
  takebackTurnDeg: 0,
  takebackTurnStartS: -1,
  takebackTurnDurationS: 0.5,
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
 * A serve-like overhead (use with a capture that has ≥ 1 s before contact):
 * tip 70° up at contact, a fast forward swing whose ≈ 250° arc before contact
 * takes the tip down behind the back (back-scratch, tip ≈ −70°), a reversed
 * take-back that stops at a "trophy" pause, and forearm pronation (long-axis
 * roll) peaking 20 ms after contact. A kinematic sketch for testing the
 * serve features, not a measured serve.
 */
export const SERVE_SWING: Partial<SwingSpec> = {
  tipElevationDeg: 70,
  swingPathDeg: 0,
  faceTiltDeg: 0,
  peakRateRadPerS: 30,
  riseSigmaS: 0.12,
  fallSigmaS: 0.16,
  backswingRateRadPerS: 5,
  backswingLeadS: 0.6,
  rollRateRadPerS: 20,
  rollPeakOffsetS: 0.02,
  rollSigmaS: 0.06,
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
  /**
   * True acquisition time of sample i, s. Default i / sampleRateHz. Use it to
   * simulate a clock error (true rate ≠ reported rate) or jitter.
   */
  readonly sampleTimeS?: (index: number) => number;
  /** Rate written into the capture header, Hz. Default `sampleRateHz`. */
  readonly reportedRateHz?: number;
  /**
   * Emit per-sample timestamps (protocol v2): (startUs + t rounded to `lsbUs`)
   * modulo `wrapUs`, with t the true sample time.
   */
  readonly timestamps?: {
    readonly startUs: number;
    readonly lsbUs: number;
    readonly wrapUs: number;
  };
  /** Gyro full scale written into the header (v2), ±dps. */
  readonly gyroRangeDps?: number;
}

/** Geometry the simulator actually produced, for comparing against analysis. */
export interface SwingTruth {
  /** First sample that shows the impact. */
  readonly contactIndex: number;
  /** Time of ball contact, s; kinematics below are just before it. */
  readonly contactTimeS: number;
  /**
   * Noise-free angular rate in the racket frame at any time t (s), without
   * the impact jolt: for ground truth between samples (e.g. phase boundaries).
   */
  readonly omegaAt: (tS: number) => Vec3;
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
  /** Noise-free per-sample truth (index = sample). */
  readonly series: TruthSeries;
  /** True roll about the long axis between two times (s), deg. */
  readonly rollAngleDeg: (fromS: number, toS: number) => number;
}

/** Per-sample ground truth of the simulated swing, without noise, bias or impact jolt. */
export interface TruthSeries {
  /** Tip (long-axis) elevation, deg. */
  readonly tipDeg: readonly number[];
  /** Hitting-face normal elevation, deg. */
  readonly faceDeg: readonly number[];
  /** Angular rate in the racket frame, rad/s. */
  readonly omegaRacket: readonly Vec3[];
  /** Vertical (world z) component of the angular rate, rad/s. */
  readonly omegaWorldZ: readonly number[];
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
  const timeOf = setup.sampleTimeS ?? ((i: number): number => i / fs);
  const nominalContact = Math.round(setup.contactTimeS * fs);
  const tContact = (nominalContact - 1 + spec.contactPhase) / fs;
  // First sample at or after contact (equals nominalContact for uniform sampling).
  let contactIndex = 0;
  while (contactIndex < n - 1 && timeOf(contactIndex) < tContact - 1e-9) contactIndex++;
  const impactDuration = spec.impactDurationS ?? 2 / 104;
  const kickDuration = spec.impactKickDurationS ?? 1 / 104;
  /** True when t lies in [tContact, tContact + duration). */
  const afterContact = (t: number, duration: number): boolean =>
    t >= tContact - 1e-9 && t - tContact < duration - 1e-9;
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
  const base = (t: number): number =>
    retained(t) * spec.peakRateRadPerS * Math.exp(-0.5 * ((t - tPeak) / sigma(t)) ** 2);
  const baseDot = (t: number): number => (-base(t) * (t - tPeak)) / sigma(t) ** 2;
  // Optional hitch: a multiplicative dip (factor 1 and slope 0 when disabled).
  const tHitch = tContact + spec.hitchAtS;
  const dipShape = (t: number): number =>
    spec.hitchDepth * Math.exp(-0.5 * ((t - tHitch) / spec.hitchWidthS) ** 2);
  const dip = (t: number): number => 1 - dipShape(t);
  const dipDot = (t: number): number => (dipShape(t) * (t - tHitch)) / spec.hitchWidthS ** 2;
  const forward = (t: number): number => base(t) * dip(t);
  const forwardDot = (t: number): number => baseDot(t) * dip(t) + base(t) * dipDot(t);
  const back = (t: number): number =>
    -spec.backswingRateRadPerS * Math.exp(-0.5 * ((t - tBack) / backSigma) ** 2);
  const rate = (t: number): number => forward(t) + back(t);
  const rateDot = (t: number): number => forwardDot(t) - (back(t) * (t - tBack)) / backSigma ** 2;
  // Hand (centre of rotation) velocity and acceleration, following the forward swing.
  const handShare = (f: number): number =>
    spec.peakRateRadPerS > 0 ? f / spec.peakRateRadPerS : 0;
  const centreVelocity = (t: number): Vec3 => scale(spec.centreVelocityMps, handShare(forward(t)));
  const centreAccel = (t: number): Vec3 => scale(spec.centreVelocityMps, handShare(forwardDot(t)));
  const tRoll = tContact + spec.rollPeakOffsetS;
  const rollRate = (t: number): number =>
    spec.rollRateRadPerS * Math.exp(-0.5 * ((t - tRoll) / spec.rollSigmaS) ** 2);
  const turn = takebackTurn(spec, tContact);

  // θ(t) and roll φ(t), relative to contact, by fine trapezoidal integration.
  const integrate = (f: (t: number) => number): Float64Array => {
    const out = new Float64Array(n);
    const steps = 20;
    for (let i = 1; i < n; i++) {
      out[i] = (out[i - 1] ?? 0) + integrateFine(f, timeOf(i - 1), timeOf(i), steps);
    }
    const before = contactIndex - 1;
    const atContact = (out[before] ?? 0) + integrateFine(f, timeOf(before), tContact, steps);
    return out.map((v) => v - atContact);
  };
  const theta = integrate(rate);
  const roll = integrate(rollRate);
  /** θ and φ at any time, from the nearest earlier sample plus a fine integral. */
  const continuous =
    (values: Float64Array, f: (t: number) => number) =>
    (t: number): number => {
      let i = 0;
      while (i < n - 1 && timeOf(i + 1) <= t) i++;
      return (values[i] ?? 0) + integrateFine(f, timeOf(i), t, 20);
    };
  const thetaAt = continuous(theta, rate);
  const rollAt = continuous(roll, rollRate);

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
  const tipSeries: number[] = [];
  const faceSeries: number[] = [];
  const omegaSeries: Vec3[] = [];
  const omegaZSeries: number[] = [];

  const noiseScale = Math.sqrt(fs / 2);
  const accelNoiseG = Math.hypot(
    spec.noiseStd.accelG,
    (spec.noiseDensity?.accelUgPerRtHz ?? 0) * 1e-6 * noiseScale,
  );
  const gyroNoiseDps = Math.hypot(
    spec.noiseStd.gyroDps,
    (spec.noiseDensity?.gyroMdpsPerRtHz ?? 0) * 1e-3 * noiseScale,
  );
  const times: number[] = [];

  for (let i = 0; i < n; i++) {
    const t = timeOf(i);
    times.push(t);
    // Attitude: swing rotation about `axis`, then roll about the racket's own long axis.
    const swingRot = fromAxisAngle(axis, theta[i] ?? 0);
    const rollRot = fromAxisAngle([1, 0, 0], roll[i] ?? 0);
    const heading = turn(t);
    const turnRot = fromAxisAngle(UP, heading.angle);
    // Without the take-back turn; the turn itself is applied below.
    const toRacket = (vWorld: Vec3): Vec3 =>
      rotate(
        conjugate(rollRot),
        mulVec(contactRacketFromWorld, rotate(conjugate(swingRot), vWorld)),
      );
    const tipWorld = rotate(swingRot, xContact);
    tipSeries.push(elevationDeg(tipWorld));
    faceSeries.push(
      elevationDeg(
        rotate(swingRot, mulVec(worldFromRacketAtContact, rotate(rollRot, hitNormalRacket))),
      ),
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
    // A turn ψ about the vertical (through the centre at contact) rotates the
    // whole motion: p = Rz(ψ) s gives p'' = Rz(ψ)(s'' + 2ψ̇ ẑ×s' + ψ̈ ẑ×s + ψ̇² ẑ×(ẑ×s)).
    // Rz(ψ) itself leaves gravity unchanged and cancels in the racket frame.
    const sDot = add(scale(cross(axis, r), w), centreVelocity(t));
    const turnAccel = add(
      add(scale(cross(UP, sDot), 2 * heading.rate), scale(cross(UP, r), heading.accel)),
      scale(cross(UP, cross(UP, r)), heading.rate * heading.rate),
    );
    let specificForce = toRacket(add(add(accelWorld, turnAccel), [0, 0, STANDARD_GRAVITY]));
    // World vertical in the frame without the turn is still ẑ.
    const omega = add(
      add(toRacket(scale(axis, w)), [rollRate(t), 0, 0]),
      toRacket(scale(UP, heading.rate)),
    );
    omegaSeries.push(omega);
    omegaZSeries.push(
      rotate(
        turnRot,
        add(scale(axis, w), add(scale(tipWorld, rollRate(t)), scale(UP, heading.rate))),
      )[2],
    );

    if (spec.withImpact && afterContact(t, impactDuration)) {
      // Ball impact: a large, brief push along the hitting-face normal.
      const sign = spec.hittingFace === 'forehand' ? -1 : 1;
      specificForce = add(specificForce, [0, 0, sign * spec.impactAccelG * STANDARD_GRAVITY]);
    }
    const kick: Vec3 =
      spec.withImpact && afterContact(t, kickDuration)
        ? [spec.impactRollKickRadPerS, 0, 0]
        : [0, 0, 0];

    const fS = mulVec(sensorFromRacket, specificForce);
    const wS = add(mulVec(sensorFromRacket, add(omega, kick)), setup.mount.gyroBias);
    if (triggerIndex < 0 && norm(wS) > setup.triggerRadPerS) triggerIndex = i;

    const noisyA = fS.map(
      (v) => v + gaussian(random) * accelNoiseG * STANDARD_GRAVITY,
    ) as unknown as Vec3;
    const noisyW = wS.map(
      (v) => v + gaussian(random) * gyroNoiseDps * DEG_TO_RAD,
    ) as unknown as Vec3;
    for (let k = 0; k < 3; k++) {
      samples[i * 6 + k] = toCounts((noisyA[k] ?? 0) / accelScale);
      samples[i * 6 + 3 + k] = toCounts((noisyW[k] ?? 0) / gyroScale, gyroClip);
    }
  }

  const stamps = setup.timestamps;
  const capture: RawCapture = {
    kind: 'swing',
    sequence: sequence & 0xff,
    sampleRateHz: setup.reportedRateHz ?? fs,
    accelGPerLsb: SENSOR_ACCEL_G_PER_LSB,
    gyroDpsPerLsb: SENSOR_GYRO_DPS_PER_LSB,
    triggerIndex: Math.max(0, triggerIndex),
    samples,
    receivedAt: 0,
    ...(stamps
      ? {
          sampleTimesUs: Uint32Array.from(
            times,
            (t) =>
              (stamps.startUs + Math.round((t * 1e6) / stamps.lsbUs) * stamps.lsbUs) %
              stamps.wrapUs,
          ),
          sampleTimesWrapUs: stamps.wrapUs,
        }
      : {}),
    ...(setup.gyroRangeDps !== undefined ? { gyroRangeDps: setup.gyroRangeDps } : {}),
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
      omegaAt: (t) => {
        const swingRot = fromAxisAngle(axis, thetaAt(t));
        const rollRot = fromAxisAngle([1, 0, 0], rollAt(t));
        const toRacket = (vWorld: Vec3): Vec3 =>
          rotate(
            conjugate(rollRot),
            mulVec(contactRacketFromWorld, rotate(conjugate(swingRot), vWorld)),
          );
        return add(
          add(toRacket(scale(axis, rate(t))), [rollRate(t), 0, 0]),
          toRacket(scale(UP, turn(t).rate)),
        );
      },
      faceTiltDeg: elevationDeg(hitNormal),
      swingPathDeg: elevationDeg(sweetSpotVelocity),
      tipElevationDeg: elevationDeg(xContact),
      headSpeedMps: norm(sweetSpotVelocity),
      hittingFace: spec.hittingFace,
      racketDropDeg,
      faceAtDropDeg,
      faceClosingRateDps,
      series: {
        tipDeg: tipSeries,
        faceDeg: faceSeries,
        omegaRacket: omegaSeries,
        omegaWorldZ: omegaZSeries,
      },
      rollAngleDeg: (fromS, toS) => integrateFine(rollRate, fromS, toS, 400) * RAD_TO_DEG,
    },
  };
}

/** Heading angle ψ (rad) of the take-back turn and its first two derivatives. */
interface Heading {
  readonly angle: number;
  readonly rate: number;
  readonly accel: number;
}

/**
 * Take-back turn about the vertical: ψ goes from −turn to 0 along a quintic
 * smoothstep (continuous rate and acceleration), then stays at 0.
 */
function takebackTurn(spec: SwingSpec, tContact: number): (t: number) => Heading {
  const total = spec.takebackTurnDeg * DEG_TO_RAD;
  const t0 = tContact + spec.takebackTurnStartS;
  const d = spec.takebackTurnDurationS;
  return (t) => {
    if (total === 0) return { angle: 0, rate: 0, accel: 0 };
    const u = Math.max(0, Math.min(1, (t - t0) / d));
    const inside = u > 0 && u < 1;
    const smooth = u * u * u * (10 - 15 * u + 6 * u * u);
    const smoothDot = inside ? 30 * u * u * (1 - u) * (1 - u) : 0;
    const smoothDdot = inside ? 60 * u * (1 - u) * (1 - 2 * u) : 0;
    return {
      angle: -total * (1 - smooth),
      rate: (total * smoothDot) / d,
      accel: (total * smoothDdot) / (d * d),
    };
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
