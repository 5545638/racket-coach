import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import {
  DEFAULT_FATIGUE_CONFIG,
  type FatigueBucket,
  type FatigueState,
  fatigueBucketOf,
  initialFatigue,
  isFatigued,
  readFatigue,
  updateFatigue,
} from '../../src/coach/fatigue';
import type { StrokeMetrics } from '../../src/domain/types';
import { assessStroke } from '../../src/elements/assess';
import { GOOD_FEATURES, GOOD_FOREHAND_V3 } from '../fixtures';

const stroke = (
  speed: number,
  forwardMs = 175,
  patch: Partial<StrokeMetrics> = {},
): StrokeMetrics => ({
  ...GOOD_FOREHAND_V3,
  headSpeedMps: speed,
  features: { ...GOOD_FEATURES, forwardSwingMs: forwardMs },
  ...patch,
});

/** Feeds strokes every `everyMs`; returns the state after each. */
function feed(
  strokes: readonly StrokeMetrics[],
  everyMs = 30_000,
  start = initialFatigue(0),
  t0 = 0,
) {
  let state: FatigueState = start;
  const states: FatigueState[] = [];
  strokes.forEach((m, i) => {
    state = updateFatigue(state, m, assessStroke(m, EMPTY_BASELINE), t0 + i * everyMs);
    states.push(state);
  });
  return { state, states };
}

const n = (count: number, m: StrokeMetrics): StrokeMetrics[] =>
  Array.from({ length: count }, () => m);
const bucket = (state: FatigueState, m: StrokeMetrics = FRESH): FatigueBucket | undefined =>
  state.byType[m.strokeType].buckets[fatigueBucketOf(m)];

const FRESH = stroke(24);
const SLOW = stroke(21, 200); // −12.5 % speed, +14 % forward swing, no faults
/** Slower and sloppier: −12.5 % speed, face open and short finish (two elements). */
const TIRED = stroke(21, 200, { faceTiltDeg: 8, followThroughArcDeg: 30 });

describe('fatigue detector', () => {
  it('activates on a head-speed drop with faults on two elements, after 30 strokes and 15 min', () => {
    const { states } = feed([...n(34, FRESH), ...n(10, TIRED)]);
    // Six tired strokes move the median of the last 10.
    expect(states.slice(0, 39).some((s) => isFatigued(s))).toBe(false);
    expect(isFatigued(states[39] as FatigueState, 'forehand')).toBe(true);
    expect(isFatigued(states[39] as FatigueState, 'backhand')).toBe(false);
    const reading = readFatigue(bucket(states[43] as FatigueState) as FatigueBucket);
    expect(reading?.distinctFaultElements).toBe(2);
  });

  // H3 regression: before, the speed drop with a longer forward swing was enough.
  it('a slower swing without extra faults is not fatigue', () => {
    expect(isFatigued(feed([...n(34, FRESH), ...n(10, SLOW)]).state)).toBe(false);
    // One element at fault: not enough either.
    const oneFault = stroke(21, 200, { faceTiltDeg: 8 });
    expect(isFatigued(feed([...n(34, FRESH), ...n(10, oneFault)]).state)).toBe(false);
  });

  // H3 regression: a deliberate control drill at lower speed must not trigger.
  it('a control drill at lower speed for 380 strokes never counts as fatigue', () => {
    // Slower on purpose, so the forward swing is longer too (175 ms × 30 / 26).
    const { states } = feed([...n(20, stroke(30)), ...n(380, stroke(26, 202))], 10_000);
    expect(states.some((s) => isFatigued(s))).toBe(false);
  });

  // H3 regression: before, 40 strokes were enough at any pace.
  it('needs 15 minutes of play since the session start', () => {
    const strokes = [...n(34, FRESH), ...n(10, TIRED)];
    // 44 strokes in 14 minutes: too early.
    expect(feed(strokes, 19_000).states.some((s) => isFatigued(s))).toBe(false);
    // The same strokes over 21 minutes: allowed.
    expect(isFatigued(feed(strokes, 30_000).state)).toBe(true);
  });

  // H3 regression: before, slices were compared with the drives' reference.
  it('compares like with like: slower, sloppier slices are not tired drives', () => {
    const slice = (speed: number): StrokeMetrics =>
      stroke(speed, 200, { swingStyle: 'slice', faceTiltDeg: -10, swingPathDeg: -50 });
    const { state } = feed([...n(30, FRESH), ...n(30, slice(20))]);
    expect(isFatigued(state)).toBe(false);
    expect(bucket(state, slice(20))?.count).toBe(30);
    expect(bucket(state)?.count).toBe(30);
  });

  it('clears when the rolling median recovers', () => {
    const { state } = feed([...n(34, FRESH), ...n(6, TIRED)]);
    expect(isFatigued(state)).toBe(true);
    const back = feed(n(6, FRESH), 30_000, state, 40 * 30_000).state;
    expect(isFatigued(back)).toBe(false);
  });

  it('clears after a break of 3 minutes and restarts every reference', () => {
    const { state } = feed([...n(34, FRESH), ...n(6, TIRED)]);
    const t = 39 * 30_000 + DEFAULT_FATIGUE_CONFIG.breakMs;
    const after = updateFatigue(state, TIRED, assessStroke(TIRED, EMPTY_BASELINE), t);
    expect(isFatigued(after)).toBe(false);
    expect(bucket(after)).toMatchObject({ count: 1 });
    expect(bucket(after)?.early).toHaveLength(1);
    expect(after.windowStart).toBe(t);
  });

  // H3 regression: before, the early reference survived the break, so the
  // slow, sloppy re-warm-up after it looked like fatigue.
  it('a re-warm-up after a break is not fatigue', () => {
    const { state } = feed(n(40, FRESH));
    const resume = 39 * 30_000 + 4 * 60_000;
    const { states } = feed(n(20, TIRED), 30_000, state, resume);
    expect(states.some((s) => isFatigued(s))).toBe(false);
  });

  it('ignores strokes without contact', () => {
    const miss = { ...FRESH, impactDetected: false };
    const { state } = feed(n(5, miss));
    expect(bucket(state)).toBeUndefined();
  });
});
