import type { CorrectionId } from '../coaching/corrections';
import {
  BACKSWING_PAUSE_MAX_MS,
  FACE_AT_DROP_MAX_DEG,
  FACE_TILT_MAX_DEG,
  FACE_TILT_MIN_DEG,
  FOLLOW_THROUGH_MIN_DEG,
  PEAK_SPEED_MIN_OFFSET_MS,
  RACKET_DROP_MAX_DEG,
  SLICE_FACE_MIN_DEG,
  SLICE_PATH_MIN_DEG,
  SWING_PATH_MAX_DEG,
  SWING_PATH_MIN_DEG,
} from '../coaching/defaultRules';
import type {
  FeatureSigmaKey,
  ServeFeatures,
  StrokeMetrics,
  StrokeType,
  SwingSize,
  SwingStyle,
} from '../domain/types';

/**
 * `below`: a fault when the value is below the allowed band (too little);
 * `above`: a fault when it is above it (too much). Every entry is one-sided;
 * a metric with faults on both sides has two entries.
 */
export type ElementDirection = 'below' | 'above';

/** Why an element could not be judged on a stroke. */
export type NotAssessableReason =
  /** No ball contact: the metrics describe peak racket speed, not a hit. */
  | 'no-contact'
  /** Sensor data missing inside the stroke (lost samples): nothing is judged. */
  | 'signal-gap'
  /** The value is unavailable on this stroke (or the drive/slice style is unknown). */
  | 'no-value'
  /** The value exists but its uncertainty is unknown (e.g. attitude not trusted there). */
  | 'no-sigma'
  /** The value is a bound only (gyro clipped) and cannot show this fault. */
  | 'saturated'
  /** No population limit and no active personal baseline yet. */
  | 'no-baseline'
  /** The element does not apply to this stroke type, swing size or style. */
  | 'wrong-stroke';

export type ElementUnit = 'deg' | 'ms' | 'dps' | 'fraction' | 'count';

/**
 * One technique element: which number on a stroke shows the fault, how sure
 * the measurement is, where the clearly-wrong bound lies and how much a fault
 * matters. See docs/metrics.md, "Coaching engine".
 */
export interface ElementSpec {
  /** Unique entry key; equals the correction id unless one correction has several entries. */
  readonly key: string;
  readonly correctionId: CorrectionId;
  /**
   * Baseline metric id. Entries that read the same number share it (and must
   * share `sMin`), so they share one personal baseline.
   */
  readonly metric: string;
  readonly unit: ElementUnit;
  readonly strokes: readonly StrokeType[];
  readonly swingSizes: readonly SwingSize[];
  /**
   * Swing styles the element applies to; the personal baseline is kept per
   * style. Null: any style, including unknown, with one baseline for all.
   */
  readonly styles: readonly SwingStyle[] | null;
  readonly value: (m: StrokeMetrics) => number | null;
  /** 1-σ measurement uncertainty of the value; null = unknown (not assessable). */
  readonly sigma: (m: StrokeMetrics) => number | null;
  /** Stroke-specific reason the value cannot be judged although it exists. */
  readonly unavailable?: (m: StrokeMetrics) => NotAssessableReason | null;
  readonly direction: ElementDirection;
  /**
   * The clearly-wrong bound from the literature (or from the existing,
   * documented heuristic rules), on the `direction` side. Null: no such
   * bound; only the personal baseline can fire the element.
   */
  readonly populationLimit: number | null;
  /**
   * Whether `populationLimit` also applies to backhands. Published values are
   * for forehands; only the face limits are applied to backhands.
   */
  readonly backhandPopulation: boolean;
  /** Importance weight w of a fault (score = w · min(d/s, 3) · p). */
  readonly weight: number;
  /** Noise floor of the personal spread s, in the value's unit. */
  readonly sMin: number;
  /**
   * Oldest `analysisVersion` whose value may enter the personal baseline,
   * for values whose definition changed. Default: any version.
   */
  readonly minAnalysisVersion?: number;
  /** Where the population limit comes from. */
  readonly source: string;
}

const GROUNDSTROKES: readonly StrokeType[] = ['forehand', 'backhand'];
const SERVE: readonly StrokeType[] = ['overhead'];
const FULL: readonly SwingSize[] = ['full'];
const DRIVE: readonly SwingStyle[] = ['drive'];
const SLICE: readonly SwingStyle[] = ['slice'];
/**
 * Angle elements whose usual value differs between drives and slices: a
 * known style is needed and each style has its own baseline. Timing and
 * rotation elements use `styles: null` instead, so they still work when the
 * style is unknown (no attitude anchor) and share one baseline.
 */
const ANY_STYLE: readonly SwingStyle[] = ['drive', 'slice'];

/**
 * Noise floors s_min. Face 3° and path 3.5° are the within-player SDs of
 * advanced players (Knudson & Blackwell 2005, n = 7; face 2.8°, path 3.4°,
 * rounded up). All others are engineering choices.
 */
export const S_MIN = {
  faceDeg: 3,
  pathDeg: 3.5,
  angleDeg: 4,
  timingMs: 10,
  durationMs: 30,
  lateGain: 0.05,
  /** Engineering choice. */
  stabilityDps: 50,
  /** Engineering choice: keeps the band at median + ½, so one extra dip fires. */
  hitchCount: 0.25,
  /**
   * Roll angle, deg: the 150 deg/s roll-rate floor over the ≈ 50 ms of the
   * roll peak. Engineering choice.
   */
  rollDeg: 8,
} as const;

/**
 * Uncertainties of values that have no entry in `features.sigma`. All are
 * engineering choices, to be replaced by the scatter of recorded strokes.
 */
export const EXPLICIT_SIGMA = {
  /** Contact stability: rate differences over three samples, deg/s. */
  stabilityDps: 15,
  /** G50: ratio of two interpolated rates. */
  lateGain: 0.02,
  /** Integer dip count: half a step is taken as 2σ. */
  hitchCount: 0.25,
  /** Rotation path after contact: split sample quantisation at ≈ 1400 deg/s. */
  followThroughDeg: 4,
  /** Roll angle with the jolt samples skipped. */
  rollDeg: 3,
  /** Timing quantisation at 104 Hz when no features are present, ms. */
  timingMs: 1000 / 104 / Math.sqrt(12),
} as const;

const feature =
  (key: FeatureSigmaKey) =>
  (m: StrokeMetrics): number | null =>
    m.features?.sigma[key] ?? null;

const timingSigma = (m: StrokeMetrics): number =>
  m.features?.sigma.forwardSwingMs ?? EXPLICIT_SIGMA.timingMs;

/** σ of a duration between two sample-quantised events. */
const durationSigma = (m: StrokeMetrics): number => timingSigma(m) * Math.SQRT2;

const constant =
  (value: number) =>
  (_m: StrokeMetrics): number =>
    value;

const serve = (m: StrokeMetrics): ServeFeatures | null => m.features?.serve ?? null;

const GROUNDSTROKE_BASE = {
  strokes: GROUNDSTROKES,
  swingSizes: FULL,
  backhandPopulation: false,
} as const;

const SERVE_BASE = {
  strokes: SERVE,
  swingSizes: FULL,
  styles: null,
  populationLimit: null,
  backhandPopulation: false,
  source: 'personal baseline only: no published racket-level serve values',
} as const;

const PERSONAL = 'personal baseline only: no published reference value';

export const ELEMENT_CATALOG: readonly ElementSpec[] = [
  {
    ...GROUNDSTROKE_BASE,
    key: 'face-open',
    correctionId: 'face-open',
    metric: 'faceTiltDeg',
    unit: 'deg',
    styles: DRIVE,
    value: (m) => m.faceTiltDeg,
    sigma: feature('faceTiltDeg'),
    direction: 'above',
    populationLimit: FACE_TILT_MAX_DEG,
    backhandPopulation: true,
    weight: 1,
    sMin: S_MIN.faceDeg,
    source: 'Kwon et al. 2017 (tilt −20…−5°) + 5° tolerance',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'face-closed',
    correctionId: 'face-closed',
    metric: 'faceTiltDeg',
    unit: 'deg',
    styles: DRIVE,
    value: (m) => m.faceTiltDeg,
    sigma: feature('faceTiltDeg'),
    direction: 'below',
    populationLimit: FACE_TILT_MIN_DEG,
    backhandPopulation: true,
    weight: 1,
    sMin: S_MIN.faceDeg,
    source: 'Kwon et al. 2017 (lower bound −20°) + 10° tolerance',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'slice-face-closed',
    correctionId: 'slice-face-closed',
    metric: 'faceTiltDeg',
    unit: 'deg',
    styles: SLICE,
    value: (m) => m.faceTiltDeg,
    sigma: feature('faceTiltDeg'),
    direction: 'below',
    populationLimit: SLICE_FACE_MIN_DEG,
    backhandPopulation: true,
    weight: 1,
    sMin: S_MIN.faceDeg,
    source: 'Elliott & Christmass 1993 (face open on slice backhands); 0° bound heuristic',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'slice-chop',
    correctionId: 'slice-chop',
    metric: 'swingPathDeg',
    unit: 'deg',
    styles: SLICE,
    value: (m) => m.swingPathDeg,
    sigma: feature('swingPathDeg'),
    direction: 'below',
    populationLimit: SLICE_PATH_MIN_DEG,
    weight: 0.9,
    sMin: S_MIN.pathDeg,
    source: 'Elliott & Christmass 1993 (15–25° downward) + 10° tolerance',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'path-flat',
    correctionId: 'path-flat',
    metric: 'swingPathDeg',
    unit: 'deg',
    styles: DRIVE,
    value: (m) => m.swingPathDeg,
    sigma: feature('swingPathDeg'),
    direction: 'below',
    populationLimit: SWING_PATH_MIN_DEG,
    weight: 0.9,
    sMin: S_MIN.pathDeg,
    source: 'Elliott et al. 1989 (≈ 17° upward) + 5° tolerance',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'path-steep',
    correctionId: 'path-steep',
    metric: 'swingPathDeg',
    unit: 'deg',
    styles: DRIVE,
    value: (m) => m.swingPathDeg,
    sigma: feature('swingPathDeg'),
    direction: 'above',
    populationLimit: SWING_PATH_MAX_DEG,
    weight: 0.9,
    sMin: S_MIN.pathDeg,
    source: 'Elliott et al. 1989 (up to ≈ 48°) + 7° tolerance',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'unstable-contact',
    correctionId: 'unstable-contact',
    metric: 'contactStabilityDps',
    unit: 'dps',
    styles: ANY_STYLE,
    value: (m) => m.features?.contactStabilityDps ?? null,
    sigma: constant(EXPLICIT_SIGMA.stabilityDps),
    direction: 'above',
    populationLimit: null,
    weight: 1,
    sMin: S_MIN.stabilityDps,
    source: PERSONAL,
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'accelerated-early',
    correctionId: 'accelerated-early',
    metric: 'peakSpeedOffsetMs',
    unit: 'ms',
    styles: DRIVE,
    value: (m) => m.peakSpeedOffsetMs,
    sigma: feature('peakSpeedOffsetMs'),
    direction: 'below',
    populationLimit: PEAK_SPEED_MIN_OFFSET_MS,
    weight: 0.8,
    sMin: S_MIN.timingMs,
    source: 'Landlinger et al. 2010 (peak ≈ 3 ms before contact); 40 ms tolerance heuristic',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'hitch',
    correctionId: 'hitch',
    metric: 'backswingPauseMs',
    unit: 'ms',
    styles: null,
    value: (m) => m.backswingPauseMs,
    sigma: durationSigma,
    direction: 'above',
    populationLimit: BACKSWING_PAUSE_MAX_MS,
    weight: 0.8,
    sMin: S_MIN.durationMs,
    source: 'heuristic (existing rule: pause > 200 ms)',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'hitch-count',
    correctionId: 'hitch',
    metric: 'hitchCount',
    unit: 'count',
    styles: null,
    value: (m) => m.features?.hitchCount ?? null,
    sigma: constant(EXPLICIT_SIGMA.hitchCount),
    direction: 'above',
    populationLimit: null,
    weight: 0.8,
    sMin: S_MIN.hitchCount,
    source: PERSONAL,
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'stiff-arm',
    correctionId: 'stiff-arm',
    metric: 'lateGainFraction',
    unit: 'fraction',
    styles: DRIVE,
    value: (m) => m.features?.lateGainFraction ?? null,
    sigma: constant(EXPLICIT_SIGMA.lateGain),
    direction: 'below',
    populationLimit: null,
    weight: 0.5,
    sMin: S_MIN.lateGain,
    source: `${PERSONAL}; indirect proxy, not a wrist measurement`,
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'no-racket-drop',
    correctionId: 'no-racket-drop',
    metric: 'racketDropDeg',
    unit: 'deg',
    styles: DRIVE,
    value: (m) => m.racketDropDeg,
    sigma: feature('racketDropDeg'),
    direction: 'above',
    populationLimit: RACKET_DROP_MAX_DEG,
    weight: 0.7,
    sMin: S_MIN.angleDeg,
    source: 'heuristic (existing rule: drop > −15°)',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'open-takeback',
    correctionId: 'open-takeback',
    metric: 'faceAtDropDeg',
    unit: 'deg',
    styles: DRIVE,
    value: (m) => m.faceAtDropDeg,
    // Read at the same sample and attitude as the racket drop.
    sigma: feature('racketDropDeg'),
    direction: 'above',
    populationLimit: FACE_AT_DROP_MAX_DEG,
    weight: 0.6,
    sMin: S_MIN.angleDeg,
    source: 'heuristic (existing rule: face at the drop > 20°)',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'high-takeback',
    correctionId: 'high-takeback',
    metric: 'takebackTipDeg',
    unit: 'deg',
    styles: ANY_STYLE,
    value: (m) => m.features?.takebackTipDeg ?? null,
    sigma: feature('takebackTipDeg'),
    direction: 'above',
    populationLimit: null,
    weight: 0.6,
    sMin: S_MIN.angleDeg,
    source: PERSONAL,
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'late-preparation',
    correctionId: 'late-preparation',
    metric: 'takebackTimeMs',
    unit: 'ms',
    styles: null,
    value: (m) => m.features?.takebackTimeMs ?? null,
    sigma: feature('takebackTimeMs'),
    direction: 'below',
    populationLimit: null,
    weight: 0.4,
    sMin: S_MIN.durationMs,
    source: PERSONAL,
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'small-turn',
    correctionId: 'small-turn',
    metric: 'takebackTurnDeg',
    unit: 'deg',
    styles: null,
    value: (m) => m.features?.takebackTurnDeg ?? null,
    sigma: feature('takebackTurnDeg'),
    direction: 'below',
    populationLimit: null,
    weight: 0.4,
    sMin: S_MIN.angleDeg,
    source: PERSONAL,
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'short-finish',
    correctionId: 'short-finish',
    metric: 'followThroughArcDeg',
    unit: 'deg',
    styles: null,
    value: (m) => m.followThroughArcDeg,
    sigma: constant(EXPLICIT_SIGMA.followThroughDeg),
    direction: 'below',
    populationLimit: FOLLOW_THROUGH_MIN_DEG,
    weight: 0.5,
    sMin: S_MIN.angleDeg,
    source: 'heuristic (existing rule: follow-through < 120°)',
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'short-finish-braking',
    correctionId: 'short-finish',
    metric: 'brakingTimeMs',
    unit: 'ms',
    styles: null,
    value: (m) => m.features?.brakingTimeMs ?? null,
    sigma: feature('brakingTimeMs'),
    direction: 'below',
    populationLimit: null,
    weight: 0.5,
    sMin: S_MIN.durationMs,
    source: PERSONAL,
  },
  {
    ...GROUNDSTROKE_BASE,
    key: 'slow-recovery',
    correctionId: 'slow-recovery',
    metric: 'recoveryMs',
    unit: 'ms',
    styles: null,
    value: (m) => m.features?.recoveryMs ?? null,
    sigma: feature('recoveryMs'),
    direction: 'above',
    populationLimit: null,
    weight: 0.3,
    sMin: S_MIN.durationMs,
    source: PERSONAL,
  },
  {
    ...SERVE_BASE,
    key: 'serve-no-drop',
    correctionId: 'serve-no-drop',
    metric: 'serve.dropTipDeg',
    unit: 'deg',
    value: (m) => serve(m)?.dropTipDeg ?? null,
    sigma: feature('dropTipDeg'),
    direction: 'above',
    weight: 0.7,
    sMin: S_MIN.angleDeg,
  },
  {
    ...SERVE_BASE,
    key: 'serve-low-contact',
    correctionId: 'serve-low-contact',
    metric: 'serve.contactTipDeg',
    unit: 'deg',
    value: (m) => serve(m)?.contactTipDeg ?? null,
    sigma: feature('contactTipDeg'),
    // Without a reliable attitude the tip is only good enough to classify.
    unavailable: (m) => (serve(m)?.contactTipReliable === false ? 'saturated' : null),
    direction: 'below',
    weight: 0.6,
    sMin: S_MIN.angleDeg,
    // Version 4 changed the contact-tip extrapolation.
    minAnalysisVersion: 4,
  },
  {
    ...SERVE_BASE,
    key: 'serve-no-pronation',
    correctionId: 'serve-no-pronation',
    metric: 'serve.rollAngleDeg',
    unit: 'deg',
    value: (m) => {
      const angle = serve(m)?.rollAngleDeg;
      return angle === null || angle === undefined ? null : Math.abs(angle);
    },
    sigma: constant(EXPLICIT_SIGMA.rollDeg),
    // A clipped roll is a lower bound: "too little" can then never be refuted.
    unavailable: (m) => (serve(m)?.rollSaturated === true ? 'saturated' : null),
    direction: 'below',
    weight: 0.5,
    sMin: S_MIN.rollDeg,
    // Version 4 excludes the impact jolt from the roll angle.
    minAnalysisVersion: 4,
  },
  {
    ...SERVE_BASE,
    key: 'serve-accelerated-early',
    correctionId: 'serve-accelerated-early',
    metric: 'peakSpeedOffsetMs',
    unit: 'ms',
    value: (m) => m.peakSpeedOffsetMs,
    sigma: feature('peakSpeedOffsetMs'),
    direction: 'below',
    weight: 0.8,
    sMin: S_MIN.timingMs,
  },
  {
    ...SERVE_BASE,
    key: 'serve-hitch',
    correctionId: 'serve-hitch',
    metric: 'hitchCount',
    unit: 'count',
    value: (m) => m.features?.hitchCount ?? null,
    sigma: constant(EXPLICIT_SIGMA.hitchCount),
    direction: 'above',
    weight: 0.8,
    sMin: S_MIN.hitchCount,
  },
  {
    ...SERVE_BASE,
    key: 'serve-short-finish',
    correctionId: 'serve-short-finish',
    metric: 'brakingTimeMs',
    unit: 'ms',
    value: (m) => m.features?.brakingTimeMs ?? null,
    sigma: feature('brakingTimeMs'),
    direction: 'below',
    weight: 0.5,
    sMin: S_MIN.durationMs,
  },
  {
    ...SERVE_BASE,
    key: 'serve-short-finish-arc',
    correctionId: 'serve-short-finish',
    metric: 'followThroughArcDeg',
    unit: 'deg',
    value: (m) => m.followThroughArcDeg,
    sigma: constant(EXPLICIT_SIGMA.followThroughDeg),
    direction: 'below',
    weight: 0.5,
    sMin: S_MIN.angleDeg,
  },
];

/**
 * Whether `spec` applies to a stroke: 'wrong-stroke' when the stroke type,
 * swing size or a known style rules it out, 'no-value' when the element needs
 * a style and the style is unknown, null when it applies.
 */
export function applicability(
  spec: ElementSpec,
  m: Pick<StrokeMetrics, 'strokeType' | 'swingSize' | 'swingStyle'>,
): 'wrong-stroke' | 'no-value' | null {
  if (!spec.strokes.includes(m.strokeType) || !spec.swingSizes.includes(m.swingSize)) {
    return 'wrong-stroke';
  }
  if (spec.styles === null) return null;
  if (m.swingStyle === null) return 'no-value';
  return spec.styles.includes(m.swingStyle) ? null : 'wrong-stroke';
}
