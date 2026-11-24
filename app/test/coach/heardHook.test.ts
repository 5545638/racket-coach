import { describe, expect, it } from 'vitest';
import { EMPTY_BASELINE } from '../../src/coach/baseline';
import {
  type CoachState,
  INITIAL_COACH_STATE,
  type Utterance,
  coachStep,
  withCueUnheard,
} from '../../src/coach/coachEngine';
import type { StrokeMetrics } from '../../src/domain/types';
import { assessStroke } from '../../src/elements/assess';
import { GOOD_FOREHAND_V3 } from '../fixtures';

const path = (deg: number): StrokeMetrics => ({ ...GOOD_FOREHAND_V3, swingPathDeg: deg });
const step = (state: CoachState, m: StrokeMetrics, speaking = true) =>
  coachStep(state, assessStroke(m, EMPTY_BASELINE), undefined, speaking);

/** Plays strokes; `heard(i)` says whether stroke i's speech reaches the player. */
function play(strokes: readonly StrokeMetrics[], heard: (i: number) => boolean): Utterance[] {
  let state = INITIAL_COACH_STATE;
  const said: Utterance[] = [];
  strokes.forEach((m, i) => {
    const s = step(state, m, heard(i));
    state = s.state;
    if (s.speech !== null) said.push(s.utterance);
  });
  return said;
}

describe('heard tracking: never praise a cue the player did not hear', () => {
  it('with the cue heard: "Better" and the reinforce phrase follow', () => {
    expect(play([path(0), path(9)], () => true).map((u) => u.kind)).toEqual([
      'correction',
      'better',
    ]);
    expect(play([path(0), path(25), path(25)], () => true).map((u) => u.kind)).toEqual([
      'correction',
      'keep-it',
    ]);
  });

  it('with the cue suppressed (step re-run as unheard): no "Better", no reinforce', () => {
    expect(play([path(0), path(9)], (i) => i !== 0).map((u) => u.kind)).toEqual(['correction']);
    expect(play([path(0), path(25), path(25)], (i) => i !== 0)).toEqual([]);
  });

  it('withCueUnheard: forgets that the focus cue was heard, so no praise builds on it', () => {
    const first = step(INITIAL_COACH_STATE, path(0));
    const lane = 'forehand-drive';
    expect(first.state.byLane[lane].focus?.lastHeardLevel).toBe(0);
    const forgotten = withCueUnheard(first.state, lane, 'path-flat');
    expect(forgotten.byLane[lane].focus?.lastHeardLevel).toBeNull();
    expect(forgotten.byLane[lane].focus?.correctionId).toBe('path-flat');
    expect(step(forgotten, path(9)).utterance.kind).not.toBe('better');
    const ok = step(step(forgotten, path(25)).state, path(25));
    expect(ok.utterance.kind).not.toBe('keep-it');
    // Another correction or lane: unchanged.
    expect(withCueUnheard(first.state, lane, 'face-open')).toBe(first.state);
    expect(withCueUnheard(first.state, 'backhand-drive', 'path-flat')).toBe(first.state);
  });
});
