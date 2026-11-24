import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import {
  DEFAULT_FATIGUE_CONFIG,
  type FatigueState,
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
  everyMs = 20_000,
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
const FRESH = stroke(24);
const SLOW = stroke(21, 200); // −12.5 % speed, +14 % forward swing

describe('fatigue detector', () => {
  it('activates on a head-speed drop with a longer forward swing, after 40 rated strokes', () => {
    const { states } = feed([...n(34, FRESH), ...n(6, SLOW)]);
    expect(states.slice(0, 39).some((s) => isFatigued(s))).toBe(false);
    expect(isFatigued(states[39] as FatigueState, 'forehand')).toBe(true);
    expect(isFatigued(states[39] as FatigueState, 'backhand')).toBe(false);
  });

  it('waits for 40 strokes, or 30 min with at least 30', () => {
    // 30 strokes in 10 minutes: too early.
    expect(isFatigued(feed([...n(20, FRESH), ...n(10, SLOW)], 20_000).state)).toBe(false);
    // 30 strokes over 30 minutes: allowed.
    expect(isFatigued(feed([...n(20, FRESH), ...n(10, SLOW)], 63_000).state)).toBe(true);
  });

  it('needs the speed drop: a slower forward swing alone is not fatigue', () => {
    expect(isFatigued(feed([...n(34, FRESH), ...n(10, stroke(24, 220))]).state)).toBe(false);
  });

  it('a speed drop with faults on two elements, at twice the early rate, is fatigue', () => {
    const sloppy = stroke(21, 175, { faceTiltDeg: 8, followThroughArcDeg: 30 });
    const { state } = feed([...n(34, FRESH), ...n(10, sloppy)]);
    const reading = readFatigue(state.byType.forehand);
    expect(reading?.distinctFaultElements).toBe(2);
    expect(isFatigued(state)).toBe(true);
    // One element only: not enough.
    const oneFault = stroke(21, 175, { faceTiltDeg: 8 });
    expect(isFatigued(feed([...n(34, FRESH), ...n(10, oneFault)]).state)).toBe(false);
  });

  it('clears when the rolling median recovers', () => {
    const { state } = feed([...n(34, FRESH), ...n(6, SLOW)]);
    expect(isFatigued(state)).toBe(true);
    const back = feed(n(6, FRESH), 20_000, state, 40 * 20_000).state;
    expect(isFatigued(back)).toBe(false);
  });

  it('clears after a break of 3 minutes and restarts the rolling window', () => {
    const { state } = feed([...n(34, FRESH), ...n(6, SLOW)]);
    const t = 39 * 20_000 + DEFAULT_FATIGUE_CONFIG.breakMs;
    const after = updateFatigue(state, SLOW, assessStroke(SLOW, EMPTY_BASELINE), t);
    expect(isFatigued(after)).toBe(false);
    expect(after.byType.forehand.recent).toHaveLength(1);
  });

  it('ignores strokes without contact', () => {
    const miss = { ...FRESH, impactDetected: false };
    const { state } = feed(n(5, miss));
    expect(state.byType.forehand.count).toBe(0);
  });
});
