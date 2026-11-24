import { describe, expect, it } from 'vitest';
import { FeedbackGate, RallyDetector, categoryOf, quantile } from '../../src/feedback/speechPolicy';

describe('categoryOf', () => {
  it('maps utterance kinds to queue categories', () => {
    expect(categoryOf('correction')).toBe('correction');
    expect(categoryOf('stuck')).toBe('correction');
    expect(categoryOf('overcorrected')).toBe('correction');
    expect(categoryOf('better')).toBe('feedback');
    expect(categoryOf('keep-it')).toBe('feedback');
    expect(categoryOf('good')).toBe('feedback');
    expect(categoryOf('fatigue')).toBe('info');
  });
});

describe('FeedbackGate', () => {
  const lane = 'forehand-drive';

  it("'every' lets everything through and 'off' nothing", () => {
    const gate = new FeedbackGate();
    gate.nextStroke();
    gate.heard('correction', lane, 'Turn more', 1);
    gate.nextStroke();
    expect(gate.allows('every', 'correction', lane, 'Turn more')).toBeNull();
    expect(gate.allows('off', 'better', lane, 'Better')).toBe('off');
    expect(gate.allows('off', 'correction', lane, 'Turn more')).toBe('off');
  });

  it("'changes': a correction only when its text changed in the lane; feedback always", () => {
    const gate = new FeedbackGate();
    gate.nextStroke();
    expect(gate.allows('changes', 'correction', lane, 'Turn more')).toBeNull();
    gate.heard('correction', lane, 'Turn more', 1);
    gate.nextStroke();
    expect(gate.allows('changes', 'correction', lane, 'Turn more')).toBe('unchanged');
    expect(gate.allows('changes', 'correction', 'backhand-drive', 'Turn more')).toBeNull();
    expect(gate.allows('changes', 'correction', lane, 'Turn the shoulders')).toBeNull();
    expect(gate.allows('changes', 'better', lane, 'Better')).toBeNull();
    expect(gate.allows('changes', 'keep-it', lane, "That's it")).toBeNull();
  });

  it("'changes' only counts heard cues: a suppressed or dropped cue is not 'last spoken'", () => {
    const gate = new FeedbackGate();
    gate.nextStroke();
    expect(gate.allows('changes', 'correction', lane, 'Turn more')).toBeNull();
    // never heard (dropped by the queue)
    gate.nextStroke();
    expect(gate.allows('changes', 'correction', lane, 'Turn more')).toBeNull();
  });

  it.each([
    ['every2', 2],
    ['every3', 3],
  ] as const)("'%s': at most one correction per %i strokes, Better/reinforce always", (mode, n) => {
    const gate = new FeedbackGate();
    const spoken: number[] = [];
    for (let i = 0; i < 9; i++) {
      const stroke = gate.nextStroke();
      expect(gate.allows(mode, 'better', lane, 'Better')).toBeNull();
      if (gate.allows(mode, 'correction', lane, `cue ${String(i)}`) === null) {
        gate.heard('correction', lane, `cue ${String(i)}`, stroke);
        spoken.push(stroke);
      }
    }
    expect(spoken).toEqual(n === 2 ? [1, 3, 5, 7, 9] : [1, 4, 7]);
  });
});

describe('RallyDetector', () => {
  it('starts a rally at the 3rd stroke < 3.5 s apart and ends it after a ≥ 6 s gap', () => {
    const rally = new RallyDetector();
    expect(rally.observe(0)).toBe(false);
    expect(rally.observe(2000)).toBe(false);
    expect(rally.observe(4000)).toBe(true);
    expect(rally.observe(8000)).toBe(true); // 4 s: rally goes on
    expect(rally.isActive(10_000)).toBe(true);
    expect(rally.isActive(14_000)).toBe(false);
    expect(rally.observe(14_000)).toBe(false); // 6 s pause
    expect(rally.observe(16_000)).toBe(false);
    expect(rally.observe(18_000)).toBe(true);
  });

  it('a 3.5–6 s gap before a rally restarts the count', () => {
    const rally = new RallyDetector();
    rally.observe(0);
    rally.observe(3000);
    expect(rally.observe(7000)).toBe(false);
    expect(rally.observe(9000)).toBe(false);
    expect(rally.observe(11_000)).toBe(true);
    rally.reset();
    expect(rally.observe(12_000)).toBe(false);
  });
});

describe('quantile', () => {
  it('interpolates linearly; null when empty', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([300, 100, 200], 0.5)).toBe(200);
    expect(quantile([0, 100], 0.95)).toBe(95);
  });
});
