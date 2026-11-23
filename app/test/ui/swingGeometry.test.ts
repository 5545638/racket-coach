import { describe, expect, it } from 'vitest';
import type { SwingTrace } from '../../src/metrics/analyzeSwing';
import { FIGURE, SHOULDER, project, racketPose, sweetSpotPath } from '../../src/ui/swingGeometry';

const trace: SwingTrace = {
  sampleRateHz: 104,
  startIndex: 0,
  forwardStart: 1,
  contact: 2,
  // behind and low → sideways → forward and high
  tipDirection: [
    [-0.8, 0, -0.6],
    [0, 1, 0],
    [0.6, 0, 0.8],
  ],
  faceNormal: [
    [0, 1, 0],
    [1, 0, 0],
    [1, 0, 0],
  ],
  speedMps: [2, 10, 24],
};

describe('replay geometry', () => {
  it('puts the racket on a line through the shoulder, sweet spot one lever away', () => {
    const pose = racketPose(trace, 2, 1.0);
    expect(pose.sweetSpot[0]).toBeCloseTo(0.6);
    expect(pose.sweetSpot[2]).toBeCloseTo(FIGURE.shoulderHeight + 0.8);
    expect(pose.hand[0]).toBeCloseTo(0.3);
    // hand → throat → sweet spot → tip, in that order along the racket
    expect(pose.throat[0]).toBeGreaterThan(pose.hand[0]);
    expect(pose.tip[0]).toBeGreaterThan(pose.sweetSpot[0]);
  });

  it('keeps a racket pointing across the court visible (unlike a pure side view)', () => {
    const pose = racketPose(trace, 1, 1.0);
    const shoulder = project(SHOULDER);
    const sweetSpot = project(pose.sweetSpot);
    expect(Math.hypot(sweetSpot.x - shoulder.x, sweetSpot.z - shoulder.z)).toBeGreaterThan(0.5);
  });

  it('projects up as up and forwards to the right', () => {
    expect(project([0, 0, 1]).z).toBeGreaterThan(0.9);
    expect(project([1, 0, 0]).x).toBeGreaterThan(0.7);
  });

  it('traces the sweet spot from low behind to high in front', () => {
    const path = sweetSpotPath(trace, 0, 99, 1.0);
    expect(path).toHaveLength(3);
    expect(path[0]?.x).toBeLessThan(path[2]?.x ?? NaN);
    expect(path[0]?.z).toBeLessThan(path[2]?.z ?? NaN);
  });
});
