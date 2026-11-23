import type { RuleSet } from './rules';
import { STIFF_ACCELERATION_OFFSET_MS } from './wrist';

const GROUNDSTROKES = ['forehand', 'backhand'] as const;
const FULL = ['full'] as const;

/**
 * Default thresholds. Literature values are widened by a tolerance band so
 * that cues fire on clear faults only. Rules marked "heuristic" have no
 * published reference value and must be tuned with recorded data.
 * Rationale per metric: docs/metrics.md.
 */
export const DEFAULT_RULES: RuleSet = {
  version: 1,
  goodCue: 'Good',
  rules: [
    {
      id: 'face-open',
      metric: 'faceTiltDeg',
      above: 0,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 100,
      cue: 'Face too open',
      source:
        'Kwon et al. 2017, J Sports Sci Med 16:505 — topspin forehands at 70–85° to the ground ' +
        '(tilt −20…−5°); +5° tolerance.',
    },
    {
      id: 'face-closed',
      metric: 'faceTiltDeg',
      below: -30,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 90,
      cue: 'Face too closed',
      source: 'Kwon et al. 2017 (lower bound −20°) with 10° tolerance.',
    },
    {
      id: 'path-flat',
      metric: 'swingPathDeg',
      below: 12,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 80,
      cue: 'Swing low to high',
      source:
        'Elliott et al. 1989 — racket rises ~17° into contact on a topspin forehand; 5° tolerance.',
    },
    {
      id: 'path-steep',
      metric: 'swingPathDeg',
      above: 55,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 70,
      cue: 'Drive through the ball',
      source: 'Elliott et al. 1989 — up to ~48° for heavy topspin; 7° tolerance.',
    },
    {
      id: 'accelerated-early',
      metric: 'peakSpeedOffsetMs',
      below: -40,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 60,
      cue: 'Accelerate through contact',
      source:
        'Landlinger et al. 2010, J Sports Sci Med 9:643 — peak racket speed ~3 ms before contact ' +
        'in elite players; 40 ms tolerance is heuristic.',
    },
    {
      id: 'late-preparation',
      metric: 'preparationTimeMs',
      below: 600,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 85,
      cue: 'Prepare earlier',
      source: 'heuristic',
    },
    {
      id: 'no-racket-drop',
      metric: 'racketDropDeg',
      above: -15,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 75,
      cue: 'Drop the racket head',
      source: 'heuristic',
    },
    {
      id: 'open-takeback',
      metric: 'faceAtDropDeg',
      above: 20,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 55,
      cue: 'Face down on the take-back',
      source: 'heuristic',
    },
    {
      id: 'hitch',
      metric: 'backswingPauseMs',
      above: 200,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
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
      priority: 40,
      cue: 'Loosen the wrist',
      source: 'heuristic (indirect: the racket does not lag and whip through)',
    },
    {
      id: 'short-finish',
      metric: 'followThroughArcDeg',
      below: 120,
      strokes: GROUNDSTROKES,
      swingSizes: FULL,
      priority: 50,
      cue: 'Finish your swing',
      source: 'heuristic',
    },
  ],
};
