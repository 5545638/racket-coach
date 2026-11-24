import type { CorrectionId } from '../coaching/corrections';
import type { Language } from '../coaching/guidance';
import type { Mat3 } from '../math/mat3';
import type { AnalysisParams } from '../metrics/analyzeSwing';
import type { Vec3 } from '../math/vec3';

/** What the sensor was asked to record. */
export type CaptureKind = 'swing' | 'static';

/**
 * Sensor filter configuration as reported by the firmware: a free-form label
 * (e.g. "LPF1 ODR/4") or the register-level settings. Stored for provenance;
 * the analysis does not interpret it.
 */
export type SensorFilterConfig = string | Readonly<Record<string, string | number | boolean>>;

/**
 * A capture exactly as received from the sensor: integer counts plus the
 * scale factors needed to convert them. Kept verbatim so that every stored
 * stroke can be re-analysed when the algorithms improve.
 *
 * Protocol v1 fills only the required fields (uniform sampling assumed,
 * ±16 g / ±2000 dps). Protocol v2 may add the optional capture-header fields
 * below; every one of them is optional so that v1 records stay valid.
 */
export interface RawCapture {
  readonly kind: CaptureKind;
  readonly sequence: number;
  /** Nominal output data rate configured on the IMU, Hz. */
  readonly sampleRateHz: number;
  /** Accelerometer sensitivity in g per LSB (used when `accelRangeG` is absent). */
  readonly accelGPerLsb: number;
  /** Gyroscope sensitivity in degrees per second per LSB (used when `gyroRangeDps` is absent). */
  readonly gyroDpsPerLsb: number;
  /** Index of the sample at which the sensor's swing trigger fired. */
  readonly triggerIndex: number;
  /** Interleaved samples: ax, ay, az, gx, gy, gz (sensor frame, raw counts). */
  readonly samples: Int16Array;
  /** Wall-clock time (ms since epoch) at which the capture was completed. */
  readonly receivedAt: number;
  /**
   * Per-sample sensor timestamps, µs (v2). Monotonic modulo
   * `sampleTimesWrapUs`; one entry per sample. Absent: uniform sampling at
   * `sampleRateHz` is assumed (v1 behaviour).
   */
  readonly sampleTimesUs?: Uint32Array | readonly number[];
  /** Modulus at which `sampleTimesUs` wraps, µs. Default 2³² (a uint32 µs counter). */
  readonly sampleTimesWrapUs?: number;
  /** Configured gyroscope full scale, ±dps (125, 250, 500, 1000 or 2000). Default 2000. */
  readonly gyroRangeDps?: number;
  /** Configured accelerometer full scale, ±g (2, 4, 8 or 16). Default 16. */
  readonly accelRangeG?: number;
  /** IMU filter configuration (provenance only). */
  readonly filter?: SensorFilterConfig;
  /** IMU die temperature at capture start, °C. */
  readonly temperatureC?: number;
  readonly firmwareVersion?: string;
  /**
   * Samples the firmware knows were lost (e.g. FIFO overrun, packets not
   * recovered by resend). With timestamps the gaps are located from them;
   * without, a non-zero count makes every gap-sensitive metric unavailable.
   */
  readonly droppedSamples?: number;

  /*
   * Optional fields filled by protocol v2 (docs/ble-protocol.md). Captures
   * from v1 firmware, and every capture stored before v2, lack them.
   */
  /** Wire protocol the capture arrived with (2; absent for v1). */
  readonly protocolVersion?: number;
  /** Sensor IMU mode (docs/sensor-v2.md). */
  readonly mode?: SensorModeName;
  /** Frame (sample) period measured by the sensor against its IMU timer, ns. */
  readonly framePeriodNs?: number;
  /** Raw 416 Hz gyro around the peak (M416): frames startFrame … startFrame + n − 1. */
  readonly gyroHr?: GyroHighRate;
  /** IMU OUT_TEMP at the end of the capture: 256 LSB/°C, 0 = 25 °C. */
  readonly temperatureRaw?: number;
  /** BEGIN_B flags, see `CaptureFlag` in protocol/constants.ts. */
  readonly flags?: number;
  /** Sensitivities as sent by the sensor (exact integers). */
  readonly accelUgPerLsb?: number;
  readonly gyroMdpsPerLsb?: number;
}

export type SensorModeName = 'M104' | 'M416';

/**
 * High-rate gyro section of a v2 capture: `samplesPerFrame` gyro samples
 * (x, y, z raw counts) per frame; sub-sample k of frame f is at
 * time(f) + k/samplesPerFrame frame periods.
 */
export interface GyroHighRate {
  readonly startFrame: number;
  readonly samplesPerFrame: number;
  /** Interleaved gx, gy, gz; length = frames × samplesPerFrame × 3. */
  readonly data: Int16Array;
}

/** A capture converted to SI units, still in the sensor frame. */
export interface ImuSeries {
  /** Nominal sample rate, Hz. */
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
  /** Sensor timestamps as received (µs, may wrap); absent for uniform v1 captures. */
  readonly sampleTimesUs?: readonly number[];
  /** Wrap modulus of `sampleTimesUs`, µs (default 2³²). */
  readonly sampleTimesWrapUs?: number;
  /**
   * Per-axis gyro clip threshold, rad/s (sensor frame): an axis at or beyond
   * it is clipped. Enables clipping reconstruction; absent = not attempted.
   */
  readonly gyroClipRadPerS?: number;
  /** Samples the firmware reported as lost (see RawCapture.droppedSamples). */
  readonly droppedSamples?: number;
  /**
   * Gyro samples that may have clipped although their values do not show it
   * (v2 flag b1: an M416 frame mean near full scale, or clipping the
   * samples cannot locate). Treated as clipped and not reconstructable.
   */
  readonly gyroSuspect?: readonly boolean[];
  /** Data was lost right before the first sample (v2 flags b3 + b0: FIFO reset). */
  readonly lostBeforeStart?: boolean;
  /** IMU temperature of the capture, °C (v2). */
  readonly temperatureC?: number;
  /**
   * High-rate splice (M416, processing/highRate.ts): true where the gyro /
   * accelerometer value was measured at this sample's time, false where it
   * was interpolated from the 104 Hz section. Absent: every sample measured.
   */
  readonly gyroMeasured?: readonly boolean[];
  readonly accelMeasured?: readonly boolean[];
  /** Rate of the interpolated (104 Hz) section of a spliced series, Hz (nominal). */
  readonly baseRateHz?: number;
}

/**
 * Timing quality of a capture (signal path v2, docs/metrics.md). Without
 * timestamps the nominal rate is assumed and every field is trivial.
 */
export interface TimebaseQuality {
  /** True when per-sample timestamps were available. */
  readonly timestamped: boolean;
  /** Sample rate estimated from the timestamps (median interval), Hz; the nominal rate without. */
  readonly measuredRateHz: number;
  /** Largest number of consecutive missing samples. */
  readonly maxGapSamples: number;
  /** RMS deviation of the regular (non-gap) intervals from the median interval, µs. */
  readonly jitterUs: number;
  /** Output samples synthesised by interpolation across short gaps. */
  readonly interpolatedSamples: number;
  /** Output samples inside long gaps (not interpolated: marked as missing). */
  readonly gapSamples: number;
  /** Samples the firmware reported lost (`RawCapture.droppedSamples`), 0 when absent. */
  readonly droppedSamples: number;
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
  /**
   * IMU temperature during calibration, °C (v2 sensors: the static captures'
   * OUT_TEMP, else the latest STATUS2). Absent for v1 sensors and older
   * calibrations. The gyro zero-rate level drifts with temperature.
   */
  readonly temperatureC?: number;
}

export type StrokeType = 'forehand' | 'backhand' | 'overhead';

/**
 * `drive`: the racket travels level or upwards into contact (flat, topspin).
 * `slice`: it travels clearly downwards. Null when the swing path is unknown.
 */
export type SwingStyle = 'drive' | 'slice';

/** `compact` swings are short and slow: volleys, blocks, touch shots. */
export type SwingSize = 'full' | 'compact';

export interface MetricQuality {
  /** True when the attitude anchor was close enough to static to trust angles. */
  readonly attitudeReliable: boolean;
  /** |‖a‖ − g| at the attitude anchor in g (lower is better); null when no anchor exists. */
  readonly anchorErrorG: number | null;
  /**
   * Gyro clipped between forward-swing start and contact and was NOT
   * reconstructed: speed is a lower bound. (Before analysis version 5 any
   * clipping set it.)
   */
  readonly gyroSaturated: boolean;
  /** Clipped gyro samples between the attitude anchor and contact (reconstructed or not). */
  readonly saturatedSamples: number;
  /**
   * Clipped gyro samples between forward-swing start and contact were
   * reconstructed (processing/declip.ts): speed and timing use the
   * reconstruction and carry a larger σ. Analysis version 5 and later.
   */
  readonly gyroReconstructed?: boolean;
  /** Reconstructed gyro samples between the attitude anchor and contact (version 5+). */
  readonly reconstructedSamples?: number;
  /** Timing quality of the capture (version 5+). */
  readonly timebase?: TimebaseQuality;
  /**
   * A long gap (missing samples that could not be interpolated, or lost
   * samples that cannot be located) lies inside the stroke: the stroke is not
   * rated and its σ are not assessable (version 5+).
   */
  readonly signalGap?: boolean;
  /**
   * Residual gyro bias removed for this capture, deg/s (re-estimated on the
   * attitude anchor's still window); 0 when the calibration bias was kept
   * (version 6+).
   */
  readonly gyroBiasCorrectionDps?: number;
  /**
   * IMU temperature of the capture minus that of the calibration, °C; absent
   * when either is unknown (version 6+).
   */
  readonly temperatureDeltaC?: number;
  /** |temperatureDeltaC| exceeds `temperatureWarnC`: recalibrating is advised (version 6+). */
  readonly temperatureWarning?: boolean;
  /**
   * M416 high-rate splice (version 6+): the analysis ran at 416 Hz with the
   * raw gyro around the peak; `contactMeasured` is true when the gyro was
   * measured (not interpolated) where contact is read.
   */
  readonly highRate?: {
    readonly measuredGyroSamples: number;
    readonly contactMeasured: boolean;
  };
}

/**
 * Per-stroke metrics. Angles that need absolute attitude are `null` when the
 * attitude estimate is not reliable, rather than silently wrong.
 */
export interface StrokeMetrics {
  readonly strokeType: StrokeType;
  readonly swingSize: SwingSize;
  readonly swingStyle: SwingStyle | null;
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
  /**
   * Time of peak racket speed relative to contact, ms. Negative = peaked before
   * contact. Null when the gyro clipped during the forward swing.
   */
  readonly peakSpeedOffsetMs: number | null;
  /** Time from the start of the preparation to contact, ms; null when it began before the capture. */
  readonly preparationTimeMs: number | null;
  /** Rotation of the racket from the start of the preparation to the start of the forward swing, deg. */
  readonly backswingArcDeg: number;
  /** Longest standstill between the start of the preparation and the forward swing, ms. */
  readonly backswingPauseMs: number;
  /**
   * Lowest tip elevation between preparation and contact, deg. Clearly
   * negative = the racket head dropped below the hand before swinging up.
   */
  readonly racketDropDeg: number | null;
  /** Elevation of the hitting-face normal at the lowest point of the racket drop, deg. */
  readonly faceAtDropDeg: number | null;
  /**
   * Time of peak angular acceleration relative to contact, ms (negative =
   * before). Close to contact = the racket lags and whips through, which
   * suggests a relaxed wrist; an indirect hint, not a wrist measurement.
   * Null when the gyro clipped during the forward swing.
   */
  readonly peakAccelerationOffsetMs: number | null;
  /** Rate at which the hitting face is closing at contact, deg/s (negative = opening). */
  readonly faceClosingRateDps: number | null;
  /** Rotation of the racket from forward-swing start to contact, degrees. */
  readonly forwardSwingArcDeg: number;
  /** Rotation of the racket from contact to end of follow-through, degrees. */
  readonly followThroughArcDeg: number;
  readonly quality: MetricQuality;
  /**
   * Coaching features (phase timeline, per-element features and their 1-σ
   * uncertainty), analysis version 3 and later. Optional because records
   * analysed by earlier versions lack it. See docs/metrics.md, "Coaching features".
   */
  readonly features?: StrokeFeatures;
}

/** Named stroke phases, in time order (signal path v2). */
export type StrokePhaseName =
  'preparation' | 'backswing' | 'forwardAcceleration' | 'contact' | 'followThrough';

/** One labelled phase, ms from the first capture sample. */
export interface StrokePhase {
  readonly name: StrokePhaseName;
  readonly startMs: number;
  readonly endMs: number;
  /** The phase began before the capture: `startMs` is the capture start, not the true start. */
  readonly truncatedStart: boolean;
  /** The phase ended after the capture: `endMs` is the capture end, not the true end. */
  readonly truncatedEnd: boolean;
}

/**
 * Phase timeline of one stroke. Times are ms from the first sample of the
 * capture (sample index / sample rate); null when the event lies outside the
 * capture or the capture never shows it.
 */
export interface StrokePhases {
  /** End of the ready position: first sample after the last ≥ 0.3 s standstill before the forward swing. */
  readonly readyEndMs: number | null;
  /**
   * Start of the backswing: first sample after the ready end (or the capture
   * start) at which ‖ω‖ reaches `backswingStartFraction` of the largest ‖ω‖
   * before the forward swing (version 5+; absent in older records). Null when
   * the racket already turned that fast at the first sample.
   */
  readonly backswingStartMs?: number | null;
  /** Start of the forward swing (start of the active phase). */
  readonly forwardStartMs: number;
  /** Estimated contact time (impact sample − ½ sample; the peak sample without an impact). */
  readonly contactMs: number;
  /** Last pre-impact sample, from which contact kinematics are read. */
  readonly contactSample: number;
  /** First sample after contact at which ω⊥ has fallen below 30 % of its pre-impact value. */
  readonly followEndMs: number | null;
  /** Start of the first ≥ 0.2 s standstill (‖ω‖ < 0.5 rad/s) after the follow-through. */
  readonly recoveryEndMs: number | null;
  /**
   * Labelled phases tiling the stroke: preparation, backswing, forward
   * acceleration, contact (±1 sample around the contact time) and follow-through
   * (version 5+). A phase of zero length is omitted; see docs/metrics.md.
   */
  readonly list?: readonly StrokePhase[];
}

/** Serve / overhead features; present only when `strokeType === 'overhead'`. */
export interface ServeFeatures {
  /** Tip elevation at the slowest moment (min ‖ω‖) in the 0.8 s before the racket drop, deg. */
  readonly trophyTipDeg: number | null;
  /** Lowest tip elevation between the ready position and contact (back-scratch), deg. */
  readonly dropTipDeg: number | null;
  /** Time from that lowest point to contact, ms. */
  readonly dropToContactMs: number | null;
  /**
   * Roll rate ωx of largest magnitude within contact ± 50 ms, skipping the
   * impact sample and the next (impact jolt), signed, deg/s. A lower bound
   * when `rollSaturated`.
   */
  readonly rollPeakDps: number;
  /** Time of that roll peak relative to contact, ms (positive = after). */
  readonly rollPeakOffsetMs: number;
  /**
   * ∫ωx dt from the second sample after the impact (past the jolt) to contact
   * + 100 ms, deg; from contact when no impact was detected. Null when the
   * capture ends sooner.
   */
  readonly rollAngleDeg: number | null;
  /** Gyro clipped within contact − 50 ms … contact + 100 ms: the roll values are lower bounds. */
  readonly rollSaturated: boolean;
  /**
   * Tip elevation at contact from the classification attitude, deg. Given even
   * when the displayed angles are withheld; then `contactTipReliable` is false
   * and its σ is null (not assessable).
   */
  readonly contactTipDeg: number | null;
  readonly contactTipReliable: boolean;
}

/** Features that carry a 1-σ uncertainty in `StrokeFeatures.sigma`. */
export type FeatureSigmaKey =
  | 'faceTiltDeg'
  | 'swingPathDeg'
  | 'tipElevationDeg'
  | 'brushAngleDeg'
  | 'racketDropDeg'
  | 'takebackTurnDeg'
  | 'takebackTipDeg'
  | 'takebackFaceDeg'
  | 'finishTipDeg'
  | 'trophyTipDeg'
  | 'dropTipDeg'
  | 'contactTipDeg'
  | 'headSpeedMps'
  | 'peakSpeedOffsetMs'
  | 'takebackTimeMs'
  | 'forwardSwingMs'
  | 'brakingTimeMs'
  | 'recoveryMs'
  | 'dropToContactMs'
  | 'rollPeakOffsetMs';

/**
 * Per-element coaching features. Angles in degrees, times in ms. A null
 * value means "not measurable for this capture" (see each definition in
 * docs/metrics.md).
 */
export interface StrokeFeatures {
  readonly phases: StrokePhases;
  /** |rotation about world vertical| from the end of the ready position to forward-swing start, deg. */
  readonly takebackTurnDeg: number | null;
  /** Contact time minus end of the ready position, ms. */
  readonly takebackTimeMs: number | null;
  /** Tip elevation at forward-swing start, deg. */
  readonly takebackTipDeg: number | null;
  /** Hitting-face normal elevation at forward-swing start, deg. */
  readonly takebackFaceDeg: number | null;
  /** G50 = 1 − ω⊥(contact − 50 ms) / ω⊥(pre-impact): share of racket rate gained in the last 50 ms. */
  readonly lateGainFraction: number | null;
  /** Contact time minus forward-swing start, ms. */
  readonly forwardSwingMs: number;
  /** Dips of ω⊥ in the forward swing deeper than 15 % of the running maximum. */
  readonly hitchCount: number;
  /** Mean of |dφ/dt| + |ωx| over the three pre-impact samples, deg/s (lower = steadier face). */
  readonly contactStabilityDps: number | null;
  /** Swing path minus face tilt at contact, deg. */
  readonly brushAngleDeg: number | null;
  /** Follow-through end minus contact, ms. */
  readonly brakingTimeMs: number | null;
  /** Tip elevation at the follow-through end, deg. */
  readonly finishTipDeg: number | null;
  /** Recovery end minus contact, ms. */
  readonly recoveryMs: number | null;
  readonly serve: ServeFeatures | null;
  /**
   * 1-σ uncertainty per feature: degrees for angles, ms for times, m/s for
   * head speed. Null = not assessable (the feature is unavailable, or the
   * gyro clipped too often between the attitude anchor and the event).
   */
  readonly sigma: Readonly<Record<FeatureSigmaKey, number | null>>;
}

/** `none`: the metrics a rule needs were unavailable, so the stroke is not rated. */
export type CueSeverity = 'good' | 'fix' | 'none';

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

/** Sensor diagnostics from a v2 STATUS2 message. */
export interface SensorDiagnostics {
  readonly protocolVersion: number;
  readonly firmwareVersion: string;
  readonly batteryPercent: number;
  readonly mode: SensorModeName;
  /** DATA payload bytes per block (48 at MTU 53, 18 at MTU 23). */
  readonly payloadBytes: number;
  readonly temperatureC: number;
  readonly fifoOverruns: number;
  readonly droppedCaptures: number;
  readonly freeVars: number;
  readonly errors: number;
}

/** What the live coach did after a stroke (see coach/coachEngine.ts). */
export type UtteranceKind = 'correction' | 'better' | 'keep-it' | 'good' | 'silent';

/** The coaching outcome kept with a stroke for history. */
export interface StrokeCoaching {
  readonly utterance: UtteranceKind;
  /** The correction spoken, or the focus still at fault ('better', silenced repeat). */
  readonly correctionId: CorrectionId | null;
  /** Focus of this stroke type after the stroke. */
  readonly focus: CorrectionId | null;
}

/**
 * A stored stroke: the raw capture plus everything needed to reproduce its
 * metrics exactly (`capture` + `calibration` + `analysisParams`, analysed by
 * `analysisVersion` of the algorithm).
 *
 * The three provenance fields are optional only because records written
 * before they existed lack them; every newly saved stroke carries all three.
 * A missing `analysisVersion` means "analysed before versioning was introduced".
 */
export interface StrokeRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly capture: RawCapture;
  readonly metrics: StrokeMetrics;
  readonly cue: Cue;
  /** `ANALYSIS_VERSION` of the algorithm that produced `metrics`. */
  readonly analysisVersion?: number;
  /** The parameters actually used (including the lever radius from settings). */
  readonly analysisParams?: AnalysisParams;
  /**
   * Snapshot of the mount calibration in force when the stroke was recorded.
   * Embedded (about a dozen numbers) so that later recalibration, which
   * overwrites the per-device calibration, cannot orphan old strokes.
   */
  readonly calibration?: MountCalibration;
  /** Live-coaching outcome; absent on strokes recorded before the coaching engine. */
  readonly coach?: StrokeCoaching;
}

export interface SessionInfo {
  readonly id: string;
  readonly startedAt: number;
  readonly label: string;
}

/**
 * `drill`: spoken cue after every stroke (feeding, ball machine).
 * `rally`: silent during play; review the session afterwards.
 */
export type FeedbackMode = 'drill' | 'rally';

/** User-adjustable settings. Defaults and validation live in `app/settings.ts`. */
export interface Settings {
  /** Schema version of the stored settings (see app/settings.ts SETTINGS_VERSION). */
  readonly version: number;
  readonly mode: FeedbackMode;
  /** Language of the on-screen explanations. Spoken cues are always English. */
  readonly language: Language;
  /** Also say "Good" when no rule fires. */
  readonly speakGood: boolean;
  /** Speech rate multiplier, 0.5–2. */
  readonly speechRate: number;
  /**
   * See AnalysisParams.leverRadiusM. Head speed is a model estimate that
   * scales with this lever; best used as a personal trend.
   */
  readonly leverRadiusM: number;
  /**
   * Time (ms since epoch) of the last "reset personal baseline"; strokes
   * received before it no longer enter the personal baseline. 0 = never reset.
   */
  readonly baselineResetAt: number;
  /**
   * Ask v2 firmware for mode M416 (416 Hz gyro around the peak). Experimental
   * until bench test T1 confirms the I2C budget (docs/bring-up.md).
   */
  readonly experimentalM416: boolean;
}
