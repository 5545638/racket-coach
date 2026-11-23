import type { Mat3 } from '../math/mat3';
import type { Vec3 } from '../math/vec3';

/** What the sensor was asked to record. */
export type CaptureKind = 'swing' | 'static';

/**
 * A capture exactly as received from the sensor: integer counts plus the
 * scale factors needed to convert them. Kept verbatim so that every stored
 * stroke can be re-analysed when the algorithms improve.
 */
export interface RawCapture {
  readonly kind: CaptureKind;
  readonly sequence: number;
  readonly sampleRateHz: number;
  /** Accelerometer sensitivity in g per LSB. */
  readonly accelGPerLsb: number;
  /** Gyroscope sensitivity in degrees per second per LSB. */
  readonly gyroDpsPerLsb: number;
  /** Index of the sample at which the sensor's swing trigger fired. */
  readonly triggerIndex: number;
  /** Interleaved samples: ax, ay, az, gx, gy, gz (sensor frame, raw counts). */
  readonly samples: Int16Array;
  /** Wall-clock time (ms since epoch) at which the capture was completed. */
  readonly receivedAt: number;
}

/** A capture converted to SI units, still in the sensor frame. */
export interface ImuSeries {
  readonly sampleRateHz: number;
  /** Specific force in m/s² (what an accelerometer measures: a − g). */
  readonly accel: readonly Vec3[];
  /** Angular rate in rad/s. */
  readonly gyro: readonly Vec3[];
  /** True where any accelerometer axis hit full scale. */
  readonly accelSaturated: readonly boolean[];
  /** True where any gyroscope axis hit full scale. */
  readonly gyroSaturated: readonly boolean[];
  readonly triggerIndex: number;
}

/**
 * How the sensor is mounted on the racket, from the two-pose calibration.
 *
 * Racket frame R (see docs/metrics.md):
 *  - x: along the long axis, from handle towards tip
 *  - z: string-bed normal, pointing out of the face used for forehands
 *  - y: z × x
 */
export interface MountCalibration {
  readonly version: 1;
  /** Rotation taking sensor-frame vectors into the racket frame. */
  readonly racketFromSensor: Mat3;
  /** Gyroscope zero-rate offset in rad/s, sensor frame. */
  readonly gyroBias: Vec3;
  readonly createdAt: string;
}

export type StrokeType = 'forehand' | 'backhand' | 'overhead';

/** `compact` swings are short and slow: volleys, blocks, touch shots. */
export type SwingSize = 'full' | 'compact';

export interface MetricQuality {
  /** True when the attitude anchor was close enough to static to trust angles. */
  readonly attitudeReliable: boolean;
  /** |‖a‖ − g| at the attitude anchor in g (lower is better); null when no anchor exists. */
  readonly anchorErrorG: number | null;
  /** Gyro clipped between forward-swing start and contact: speed is a lower bound. */
  readonly gyroSaturated: boolean;
}

/**
 * Per-stroke metrics. Angles that need absolute attitude are `null` when the
 * attitude estimate is not reliable, rather than silently wrong.
 */
export interface StrokeMetrics {
  readonly strokeType: StrokeType;
  readonly swingSize: SwingSize;
  readonly impactDetected: boolean;
  /** Sample index of ball contact, or of peak racket speed when no contact was found. */
  readonly referenceIndex: number;
  /** Estimated sweet-spot speed at contact, m/s. */
  readonly headSpeedMps: number;
  /** Elevation of the hitting-face normal at contact. Negative = closed, positive = open. */
  readonly faceTiltDeg: number | null;
  /** Elevation of the sweet-spot velocity at contact. Positive = low-to-high. */
  readonly swingPathDeg: number | null;
  /** Elevation of the racket long axis (tip direction) at contact. */
  readonly tipElevationDeg: number | null;
  /** Time of peak racket speed relative to contact, ms. Negative = peaked before contact. */
  readonly peakSpeedOffsetMs: number;
  /** Rotation of the racket from forward-swing start to contact, degrees. */
  readonly forwardSwingArcDeg: number;
  /** Rotation of the racket from contact to end of follow-through, degrees. */
  readonly followThroughArcDeg: number;
  readonly quality: MetricQuality;
}

export type CueSeverity = 'good' | 'fix';

export interface Cue {
  readonly ruleId: string;
  readonly severity: CueSeverity;
  /** Short spoken phrase. */
  readonly text: string;
}

export interface SensorStatus {
  readonly protocolVersion: number;
  readonly batteryPercent: number;
  readonly temperatureC: number;
  readonly firmwareVersion: string;
}

export interface StrokeRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly capture: RawCapture;
  readonly metrics: StrokeMetrics;
  readonly cue: Cue;
}

export interface SessionInfo {
  readonly id: string;
  readonly startedAt: number;
  readonly label: string;
}
