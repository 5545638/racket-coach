import { describe, expect, it } from 'vitest';
import { dot, norm, sub } from '../../src/math/vec3';
import type { SwingTrace } from '../../src/metrics/analyzeSwing';
import { RACKET, project, racketShape, tipPath } from '../../src/ui/swingGeometry';

const trace: SwingTrace = {
  sampleRateHz: 104,
  startIndex: 0,
  forwardStart: 0,
  contact: 1,
  // Frame 1: racket pointing across the court (+y), strings facing the target (+x).
  tipDirection: [
    [-0.8, 0, -0.6],
    [0, 1, 0],
  ],
  faceNormal: [
    [0, 1, 0],
    [1, 0, 0],
  ],
  speedMps: [2, 24],
};

describe('replay geometry', () => {
  it('draws the racket from measured orientation and real dimensions only', () => {
    const shape = racketShape(trace, 1);
    expect(shape.butt).toEqual([0, 0, 0]);
    expect(shape.tip[1]).toBeCloseTo(RACKET.length);
    // Every head point lies in the string plane (perpendicular to the face normal)…
    for (const p of shape.head) expect(dot(p, [1, 0, 0])).toBeCloseTo(0, 9);
    // …on an ellipse of the right size around the head centre.
    const centre = [0, RACKET.headCentre, 0] as const;
    const radii = shape.head.map((p) => norm(sub(p, centre)));
    expect(Math.max(...radii)).toBeCloseTo(RACKET.headHalfLength);
    expect(Math.min(...radii)).toBeCloseTo(RACKET.headHalfWidth);
  });

  it('shows the string bed edge-on when the camera looks along the strings', () => {
    // Camera at azimuth 0 looks along +y… the face normal (+x) lies in the picture plane.
    const flat = racketShape(trace, 1).head.map((p) => project(p, 0));
    const width = Math.max(...flat.map((p) => p.x)) - Math.min(...flat.map((p) => p.x));
    expect(width).toBeCloseTo(0, 9);
  });

  it('projects up as up and the target to the right in the default view', () => {
    expect(project([0, 0, 1], 0.7).z).toBeGreaterThan(0.9);
    expect(project([1, 0, 0], 0.7).x).toBeGreaterThan(0.7);
  });

  it('follows the tip through the frames', () => {
    const path = tipPath(trace, 0, 99, 0.7);
    expect(path).toHaveLength(2);
    expect(path[0]?.z).toBeLessThan(path[1]?.z ?? NaN);
  });
});
