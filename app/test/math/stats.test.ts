import { describe, expect, it } from 'vitest';
import { erf, median, medianAbsoluteDeviation, normalCdf } from '../../src/math/stats';

/** erf by its Maclaurin series, exact to double precision for |x| ≤ 3. */
function erfSeries(x: number): number {
  let term = x;
  let sum = x;
  for (let n = 1; n < 200; n++) {
    term *= (-x * x) / n;
    sum += term / (2 * n + 1);
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

describe('normal distribution', () => {
  it('approximates erf within the Abramowitz–Stegun 7.1.26 bound', () => {
    for (let x = -3; x <= 3; x += 0.01) {
      expect(Math.abs(erf(x) - erfSeries(x))).toBeLessThan(1.5e-7);
    }
    expect(Math.abs(erf(0))).toBeLessThan(1.5e-7);
    expect(erf(6)).toBeCloseTo(1, 9);
    expect(erf(-6)).toBeCloseTo(-1, 9);
  });

  it('gives Φ at reference points', () => {
    const table: readonly (readonly [number, number])[] = [
      [0, 0.5],
      [1, 0.8413447461],
      [-1, 0.1586552539],
      [1.2816, 0.9],
      [0.8416, 0.8],
      [1.96, 0.9750021048],
      [3, 0.998650102],
    ];
    for (const [z, p] of table) expect(Math.abs(normalCdf(z) - p)).toBeLessThan(1e-4);
    expect(Math.abs(normalCdf(1) - 0.8413447461)).toBeLessThan(2e-7);
  });
});

describe('robust statistics', () => {
  it('computes median and MAD', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1);
  });
});
