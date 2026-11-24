import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASELINE_CONFIG,
  EMPTY_BASELINE,
  addStrokeToBaseline,
  baselineKey,
  buildBaseline,
} from '../../src/coach/baseline';
import type { StrokeMetrics } from '../../src/domain/types';
import {
  GOOD_FOREHAND,
  GOOD_FOREHAND_V3,
  GOOD_SERVE,
  strokeRecord,
  withFeatures,
} from '../fixtures';

const PATH = baselineKey('forehand', 'drive', 'full', 'swingPathDeg');
const FACE = baselineKey('forehand', 'drive', 'full', 'faceTiltDeg');

const records = (values: readonly number[], make: (v: number) => StrokeMetrics) =>
  values.map((v, i) => strokeRecord(make(v), i + 1));

describe('personal baseline', () => {
  it('takes the median and 1.4826 · MAD as the spread', () => {
    const values = [20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 100];
    const b = buildBaseline(records(values, (v) => ({ ...GOOD_FOREHAND_V3, swingPathDeg: v })));
    const e = b.entries[PATH];
    expect(e?.n).toBe(16);
    expect(e?.median).toBe(35);
    // |v − 35| sorted: 1 1 3 3 … 13 13 65 → MAD = 8.
    expect(e?.spread).toBeCloseTo(1.4826 * 8, 12);
    expect(e?.active).toBe(true);
  });

  it('floors the spread at s_min', () => {
    const b = buildBaseline(
      records(Array(20).fill(-12), (v) => ({ ...GOOD_FOREHAND_V3, faceTiltDeg: v })),
    );
    expect(b.entries[FACE]?.spread).toBe(3);
  });

  it('becomes active from 15 values', () => {
    const make = (v: number) => ({ ...GOOD_FOREHAND_V3, swingPathDeg: v });
    expect(buildBaseline(records(Array(14).fill(25), make)).entries[PATH]?.active).toBe(false);
    expect(buildBaseline(records(Array(15).fill(25), make)).entries[PATH]?.active).toBe(true);
  });

  it('keeps the newest 60 values, newest first, whatever the input order', () => {
    const recs = records(
      Array.from({ length: 80 }, (_, i) => i),
      (v) => ({ ...GOOD_FOREHAND_V3, swingPathDeg: v }),
    ).reverse();
    const e = buildBaseline(recs).entries[PATH];
    expect(e?.n).toBe(DEFAULT_BASELINE_CONFIG.windowSize);
    expect(e?.values[0]).toBe(79);
    expect(e?.values.at(-1)).toBe(20);
  });

  it('is updated incrementally to the same result as a rebuild', () => {
    const recs = records([10, 30, 20, 25, 18], (v) => ({ ...GOOD_FOREHAND_V3, swingPathDeg: v }));
    const incremental = recs.reduce((b, r) => addStrokeToBaseline(b, r), EMPTY_BASELINE);
    expect(incremental).toEqual(buildBaseline(recs));
    expect(incremental.strokeCounts).toEqual({ forehand: 5, backhand: 0, overhead: 0 });
  });

  it('skips strokes without contact and values that cannot be assessed', () => {
    const b = buildBaseline([
      strokeRecord({ ...GOOD_FOREHAND_V3, impactDetected: false }, 1),
      strokeRecord({ ...GOOD_FOREHAND_V3, swingPathDeg: null }, 2),
    ]);
    expect(b.entries[PATH]).toBeUndefined();
    expect(b.strokeCounts.forehand).toBe(1);
  });

  it('keeps drives and slices, stroke types and swing sizes apart, but shares timing across styles', () => {
    const slice = { ...GOOD_FOREHAND_V3, swingStyle: 'slice' as const, swingPathDeg: -20 };
    const b = buildBaseline([strokeRecord(GOOD_FOREHAND_V3, 1), strokeRecord(slice, 2)]);
    expect(b.entries[PATH]?.n).toBe(1);
    expect(b.entries[baselineKey('forehand', 'slice', 'full', 'swingPathDeg')]?.n).toBe(1);
    expect(b.entries[baselineKey('forehand', 'any', 'full', 'takebackTimeMs')]?.n).toBe(2);
  });

  it('uses only the metrics old records have, and features of current ones', () => {
    const old = strokeRecord(GOOD_FOREHAND, 1, null); // before versioning, no features
    const b = buildBaseline([old]);
    expect(b.entries[PATH]?.n).toBe(1);
    expect(b.entries[baselineKey('forehand', 'any', 'full', 'takebackTimeMs')]).toBeUndefined();
  });

  it('ignores serve roll values from analysis versions before the impact-jolt fix', () => {
    const v3 = strokeRecord(GOOD_SERVE, 1, 3);
    const v4 = strokeRecord(GOOD_SERVE, 2, 4);
    const roll = baselineKey('overhead', 'any', 'full', 'serve.rollAngleDeg');
    const drop = baselineKey('overhead', 'any', 'full', 'serve.dropTipDeg');
    const b = buildBaseline([v3, v4]);
    expect(b.entries[roll]?.n).toBe(1);
    expect(b.entries[drop]?.n).toBe(2);
  });

  it('does not let a clipped roll (a lower bound) into the baseline', () => {
    const f = GOOD_SERVE.features;
    if (!f?.serve) throw new Error('fixture');
    const clipped = withFeatures(GOOD_SERVE, { serve: { ...f.serve, rollSaturated: true } });
    const roll = baselineKey('overhead', 'any', 'full', 'serve.rollAngleDeg');
    expect(buildBaseline([strokeRecord(clipped, 1)]).entries[roll]).toBeUndefined();
  });

  it('accepts a filter for future outcome tags', () => {
    const recs = records([10, 30], (v) => ({ ...GOOD_FOREHAND_V3, swingPathDeg: v }));
    const b = buildBaseline(recs, DEFAULT_BASELINE_CONFIG, (r) => r.metrics.swingPathDeg === 30);
    expect(b.entries[PATH]?.values).toEqual([30]);
  });
});
