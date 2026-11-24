import type { RuleSet } from './rules';
import { STIFF_ACCELERATION_OFFSET_MS } from './wrist';

const GROUNDSTROKES = ['forehand', 'backhand'] as const;
const FULL = ['full'] as const;
const DRIVE = ['drive'] as const;
const SLICE = ['slice'] as const;
const ANY_STYLE = ['drive', 'slice'] as const;

/**
 * Rule limits, exported as the single source of truth: the rules below fire
 * outside these bounds and the UI derives its displayed target bands from them.
 */
export const FACE_TILT_MAX_DEG = 0;
export const FACE_TILT_MIN_DEG = -30;
export const SWING_PATH_MIN_DEG = 12;
export const SWING_PATH_MAX_DEG = 55;
export const PEAK_SPEED_MIN_OFFSET_MS = -40;
/** Slice: face below this is closed (Elliott & Christmass 1993; the 0° bound is heuristic). */
export const SLICE_FACE_MIN_DEG = 0;
/** Slice: path below this is a chop (Elliott & Christmass 1993 + 10° tolerance). */
export const SLICE_PATH_MIN_DEG = -35;
/** Heuristic: the lowest tip elevation of the take-back must be below this. */
export const RACKET_DROP_MAX_DEG = -15;
/** Heuristic: face elevation at the racket drop above this is an open take-back. */
export const FACE_AT_DROP_MAX_DEG = 20;
/** Heuristic: a standstill longer than this in the take-back is a hitch, ms. */
export const BACKSWING_PAUSE_MAX_MS = 200;
/** Heuristic: rotation after contact below this is a short finish, deg. */
export const FOLLOW_THROUGH_MIN_DEG = 120;

/** Target bands for topspin/flat drives, derived from the rule limits. */
export const TARGET_BANDS = {
  face: { min: FACE_TILT_MIN_DEG, max: FACE_TILT_MAX_DEG },
  path: { min: SWING_PATH_MIN_DEG, max: SWING_PATH_MAX_DEG },
  peakSpeedOffsetMs: { min: PEAK_SPEED_MIN_OFFSET_MS, max: null },
} as const;

/**
 * Default thresholds. Only full-swing forehands and backhands are judged:
 * serves, smashes and volleys have no usable published racket-level reference
 * values (docs/research), so they are counted but not rated. Preparation time
 * is shown but has no rule: skilled players prepare in under 0.6 s when the
 * ball is fast, so a fixed limit would mislabel them.
 * Literature values are widened by a tolerance band so
 * that cues fire on clear faults only. Rules marked "heuristic" have no
 * published reference value and must be tuned with recorded data.
 * Rationale per metric: docs/metrics.md.
 */
export const DEFAULT_RULES: RuleSet = {
  version: 1,
  goodCue: 'Good',
  rules: [
    {
      id: 'slice-face-closed',
      metric: 'faceTiltDeg',
      below: SLICE_FACE_MIN_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: SLICE,
      priority: 100,
      cue: 'Open the face for the slice',
      source:
        'Elliott & Christmass 1993 (ISBS) — racket face open at impact on slice backhands; ' +
        'the 0° bound is heuristic.',
    },
    {
      id: 'slice-chop',
      metric: 'swingPathDeg',
      below: SLICE_PATH_MIN_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: SLICE,
      priority: 80,
      cue: 'Slice through the ball, not down',
      source:
        'Elliott & Christmass 1993 — racket travels 15–25° downward into contact; 10° tolerance.',
    },
    {
      id: 'face-open',
      metric: 'faceTiltDeg',
      above: FACE_TILT_MAX_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 100,
      cue: 'Face too open',
      source:
        'Kwon et al. 2017, J Sports Sci Med 16:505 — topspin forehands at 70–85° to the ground ' +
        '(tilt −20…−5°); +5° tolerance.',
    },
    {
      id: 'face-closed',
      metric: 'faceTiltDeg',
      below: FACE_TILT_MIN_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 90,
      cue: 'Face too closed',
      source: 'Kwon et al. 2017 (lower bound −20°) with 10° tolerance.',
    },
    {
      id: 'path-flat',
      metric: 'swingPathDeg',
      below: SWING_PATH_MIN_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 80,
      cue: 'Swing low to high',
      source:
        'Elliott et al. 1989 — racket rises ~17° into contact on a topspin forehand; 5° tolerance.',
    },
    {
      id: 'path-steep',
      metric: 'swingPathDeg',
      above: SWING_PATH_MAX_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 70,
      cue: 'Drive through the ball',
      source: 'Elliott et al. 1989 — up to ~48° for heavy topspin; 7° tolerance.',
    },
    {
      id: 'accelerated-early',
      metric: 'peakSpeedOffsetMs',
      below: PEAK_SPEED_MIN_OFFSET_MS,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 60,
      cue: 'Accelerate through contact',
      source:
        'Landlinger et al. 2010, J Sports Sci Med 9:643 — peak racket speed ~3 ms before contact ' +
        'in elite players; 40 ms tolerance is heuristic.',
    },
    {
      id: 'no-racket-drop',
      metric: 'racketDropDeg',
      above: RACKET_DROP_MAX_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 75,
      cue: 'Drop the racket head',
      source: 'heuristic',
    },
    {
      id: 'open-takeback',
      metric: 'faceAtDropDeg',
      above: FACE_AT_DROP_MAX_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 55,
      cue: 'Face down on the take-back',
      source: 'heuristic',
    },
    {
      id: 'hitch',
      metric: 'backswingPauseMs',
      above: BACKSWING_PAUSE_MAX_MS,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: ANY_STYLE,
      priority: 45,
      cue: 'Keep the swing flowing',
      source: 'heuristic',
    },
    {
      id: 'stiff-arm',
      metric: 'peakAccelerationOffsetMs',
      below: STIFF_ACCELERATION_OFFSET_MS,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: DRIVE,
      priority: 40,
      cue: 'Loosen the wrist',
      source: 'heuristic (indirect: the racket does not lag and whip through)',
    },
    {
      id: 'short-finish',
      metric: 'followThroughArcDeg',
      below: FOLLOW_THROUGH_MIN_DEG,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      styles: ANY_STYLE,
      priority: 50,
      cue: 'Finish your swing',
      source: 'heuristic',
    },
  ],
};
