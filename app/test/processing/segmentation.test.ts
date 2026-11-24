import { describe, expect, it } from 'vitest';
import { contactReference } from '../../src/processing/segmentation';

describe('contactReference', () => {
  it('reads kinematics before the impact sample and times contact half a sample earlier', () => {
    expect(contactReference(94, 93)).toEqual({ sampleIndex: 93, time: 93.5 });
  });

  it('uses the peak of racket rate when no impact was found', () => {
    expect(contactReference(null, 90)).toEqual({ sampleIndex: 90, time: 90 });
  });

  it('never points before the first sample', () => {
    expect(contactReference(0, 3).sampleIndex).toBe(0);
  });
});
