import { type Vec3, add, scale } from '../math/vec3';
import type { SwingTrace } from '../metrics/analyzeSwing';

/** A point on the drawing, metres: x to the right, z up. */
export interface Point {
  readonly x: number;
  readonly z: number;
}

/** Proportions of the illustrative figure, metres. Not measured from the player. */
export const FIGURE = {
  shoulderHeight: 1.4,
  /** Sweet spot to the end of the handle, along the racket. */
  sweetSpotToHand: 0.5,
  /** Half the length of the racket head, centred on the sweet spot. */
  headHalfLength: 0.16,
} as const;

/**
 * Camera for the three-quarter view. A pure side view would not do: at
 * contact the racket points across the court, straight at a side-on viewer.
 */
const AZIMUTH = (40 * Math.PI) / 180;
const ELEVATION = (18 * Math.PI) / 180;

/** Orthographic projection of a display-frame point (x forwards, z up) onto the drawing. */
export function project(p: Vec3): Point {
  const right = p[0] * Math.cos(AZIMUTH) - p[1] * Math.sin(AZIMUTH);
  const depth = p[0] * Math.sin(AZIMUTH) + p[1] * Math.cos(AZIMUTH);
  return { x: right, z: p[2] * Math.cos(ELEVATION) + depth * Math.sin(ELEVATION) };
}

export const SHOULDER: Vec3 = [0, 0, FIGURE.shoulderHeight];

export interface RacketPose {
  readonly hand: Vec3;
  readonly throat: Vec3;
  readonly sweetSpot: Vec3;
  readonly tip: Vec3;
}

/**
 * Arm and racket for one frame, using the same rigid-lever model as the speed
 * estimate: the racket lies on a line through the shoulder, with the sweet
 * spot `leverM` away from it. Orientation is measured; the position along
 * that line, and the body, are assumptions.
 */
export function racketPose(trace: SwingTrace, frame: number, leverM: number): RacketPose {
  const d = trace.tipDirection[frame] ?? [0, 0, 0];
  const at = (r: number): Vec3 => add(SHOULDER, scale(d, r));
  return {
    hand: at(leverM - FIGURE.sweetSpotToHand),
    throat: at(leverM - FIGURE.headHalfLength),
    sweetSpot: at(leverM),
    tip: at(leverM + FIGURE.headHalfLength),
  };
}

/** Sweet-spot path over a range of frames (inclusive), projected. */
export function sweetSpotPath(
  trace: SwingTrace,
  from: number,
  to: number,
  leverM: number,
): Point[] {
  const points: Point[] = [];
  for (let i = Math.max(0, from); i <= Math.min(to, trace.tipDirection.length - 1); i++) {
    points.push(project(racketPose(trace, i, leverM).sweetSpot));
  }
  return points;
}
