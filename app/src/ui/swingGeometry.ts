import { type Vec3, add, cross, scale } from '../math/vec3';
import type { SwingTrace } from '../metrics/analyzeSwing';

/** A point on the drawing, metres: x to the right, z up. */
export interface Point {
  readonly x: number;
  readonly z: number;
}

/** Real racket proportions, metres from the butt cap (27 in frame, ~100 sq in head). */
export const RACKET = {
  throat: 0.36,
  headCentre: 0.52,
  headHalfLength: 0.165,
  headHalfWidth: 0.125,
  length: 0.685,
} as const;

const ELEVATION = (18 * Math.PI) / 180;

/**
 * Orthographic projection of a display-frame point (x towards the target,
 * z up) for a camera `azimuthRad` round from the side and slightly above.
 */
export function project(p: Vec3, azimuthRad: number): Point {
  const right = p[0] * Math.cos(azimuthRad) - p[1] * Math.sin(azimuthRad);
  const depth = p[0] * Math.sin(azimuthRad) + p[1] * Math.cos(azimuthRad);
  return { x: right, z: p[2] * Math.cos(ELEVATION) + depth * Math.sin(ELEVATION) };
}

export interface RacketShape {
  /** Butt cap; always the origin (see {@link racketShape}). */
  readonly butt: Vec3;
  readonly throat: Vec3;
  readonly tip: Vec3;
  /** Outline of the head, a closed loop in the plane of the strings. */
  readonly head: readonly Vec3[];
}

/**
 * The racket at one frame, drawn with its butt cap at the origin.
 *
 * Only orientation is measured, so only orientation is drawn: every point
 * here follows from the measured long axis and face normal plus fixed racket
 * dimensions. Where the racket was in space, and the player's body, are not
 * known to a racket-mounted sensor and are deliberately not shown.
 */
export function racketShape(trace: SwingTrace, frame: number, segments = 24): RacketShape {
  const axis = trace.tipDirection[frame] ?? [1, 0, 0];
  const normal = trace.faceNormal[frame] ?? [0, 0, 1];
  const across = cross(normal, axis); // in the string plane, perpendicular to the long axis
  const centre = scale(axis, RACKET.headCentre);
  const head: Vec3[] = [];
  for (let k = 0; k < segments; k++) {
    const a = (2 * Math.PI * k) / segments;
    head.push(
      add(
        centre,
        add(
          scale(axis, RACKET.headHalfLength * Math.cos(a)),
          scale(across, RACKET.headHalfWidth * Math.sin(a)),
        ),
      ),
    );
  }
  return {
    butt: [0, 0, 0],
    throat: scale(axis, RACKET.throat),
    tip: scale(axis, RACKET.length),
    head,
  };
}

/** Path of the racket tip over a range of frames (inclusive), projected. */
export function tipPath(trace: SwingTrace, from: number, to: number, azimuthRad: number): Point[] {
  const points: Point[] = [];
  for (let i = Math.max(0, from); i <= Math.min(to, trace.tipDirection.length - 1); i++) {
    points.push(project(scale(trace.tipDirection[i] ?? [0, 0, 0], RACKET.length), azimuthRad));
  }
  return points;
}
