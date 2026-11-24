import { describe, expect, it } from 'vitest';
import type {
  DeviationCategory,
  SessionInfo,
  StrokeCoaching,
  StrokeRecord,
  StrokeType,
} from '../../src/domain/types';
import {
  dayMonth,
  labelIndices,
  linePoints,
  niceMax,
  slotX,
  ticks,
  valueY,
} from '../../src/ui/charts';
import { HISTORY_MAX_SESSIONS, sessionHistory } from '../../src/ui/historyModel';
import { historyView, speedRange } from '../../src/ui/historyView';
import { reportStrings } from '../../src/ui/reportStrings';
import { GOOD_FOREHAND_V3, GOOD_SERVE, strokeRecord } from '../fixtures';

const DAY = 86_400_000;
const T0 = new Date(2026, 9, 1, 18, 0).getTime();

const session = (i: number): SessionInfo => ({ id: `s${i}`, startedAt: T0 + i * DAY, label: '' });

function stroke(
  sessionIndex: number,
  n: number,
  type: StrokeType = 'forehand',
  fault: DeviationCategory = 'variation',
  speed = 25,
): StrokeRecord {
  const base = type === 'overhead' ? GOOD_SERVE : GOOD_FOREHAND_V3;
  const r = strokeRecord(
    { ...base, strokeType: type, headSpeedMps: speed + (n % 3) },
    T0 + sessionIndex * DAY + n * 1000,
  );
  const coach: StrokeCoaching = {
    utterance: 'silent',
    correctionId: null,
    focus: null,
    categories: {
      counts: {
        'technical-error': fault === 'technical-error' ? 1 : 0,
        uncertain: 0,
        variation: fault === 'variation' ? 1 : 0,
        'not-assessable': 0,
        'fatigue-related': 0,
        improvement: 0,
      },
      byElement: { 'face-open': fault },
    },
  };
  return { ...r, id: `${sessionIndex}-${n}`, sessionId: `s${sessionIndex}`, coach };
}

describe('sessionHistory', () => {
  it('returns nothing for no data and drops sessions without strokes', () => {
    expect(sessionHistory([], [])).toEqual({ sessions: [], weaknesses: [] });
    expect(sessionHistory([session(0)], []).sessions).toEqual([]);
  });

  it('groups strokes per session, oldest first, with type counts and dd.mm labels', () => {
    const strokes = [
      ...Array.from({ length: 6 }, (_, n) => stroke(1, n)),
      ...Array.from({ length: 4 }, (_, n) => stroke(1, 10 + n, 'overhead')),
      ...Array.from({ length: 5 }, (_, n) => stroke(0, n, 'backhand')),
    ];
    const h = sessionHistory([session(1), session(0)], strokes);
    expect(h.sessions.map((s) => s.id)).toEqual(['s0', 's1']);
    expect(h.sessions[0]?.byType).toEqual({ forehand: 0, backhand: 5, overhead: 0 });
    expect(h.sessions[1]).toMatchObject({
      total: 10,
      byType: { forehand: 6, backhand: 0, overhead: 4 },
      label: dayMonth(T0 + DAY),
    });
    expect(h.sessions[0]?.speed.forehand).toBeNull();
    expect(h.sessions[1]?.speed.forehand?.meanMps).toBeCloseTo(26, 0);
  });

  it('keeps the newest 20 sessions', () => {
    const sessions = Array.from({ length: 25 }, (_, i) => session(i));
    const strokes = sessions.map((_, i) => stroke(i, 0));
    const h = sessionHistory(sessions, strokes);
    expect(h.sessions).toHaveLength(HISTORY_MAX_SESSIONS);
    expect(h.sessions[0]?.id).toBe('s5');
    expect(h.sessions.at(-1)?.id).toBe('s24');
  });

  it('ranks weaknesses by fault count and gives per-session rates', () => {
    const strokes = [
      ...Array.from({ length: 10 }, (_, n) =>
        stroke(0, n, 'forehand', n < 5 ? 'technical-error' : 'variation'),
      ),
      ...Array.from({ length: 10 }, (_, n) =>
        stroke(1, n, 'forehand', n < 2 ? 'technical-error' : 'variation'),
      ),
      stroke(2, 0, 'forehand', 'technical-error'),
    ];
    const h = sessionHistory([session(0), session(1), session(2)], strokes);
    expect(h.weaknesses).toEqual(['face-open']);
    expect(h.sessions.map((s) => s.faultRates['face-open'])).toEqual([0.5, 0.2, null]);
  });

  it('is fast for 600 strokes', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => session(i));
    const strokes = sessions.flatMap((_, i) =>
      Array.from({ length: 30 }, (_, n) => stroke(i, n, n % 3 === 0 ? 'backhand' : 'forehand')),
    );
    const start = performance.now();
    const h = sessionHistory(sessions, strokes);
    expect(performance.now() - start).toBeLessThan(500);
    expect(h.sessions).toHaveLength(20);
    expect(h.sessions[0]?.consistency).not.toBeNull();
  });
});

describe('chart geometry', () => {
  const frame = { width: 100, height: 60, left: 10, right: 10, top: 10, bottom: 10 };

  it('places slots and values', () => {
    expect(slotX(frame, 0, 4)).toBe(20);
    expect(slotX(frame, 3, 4)).toBe(80);
    expect(valueY(frame, 0, 10)).toBe(50);
    expect(valueY(frame, 10, 10)).toBe(10);
    expect(valueY(frame, 99, 10)).toBe(10);
    expect(valueY(frame, 5, 0)).toBe(50);
  });

  it('chooses nice maxima and ticks', () => {
    expect(niceMax(0, 4)).toBe(5);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(101)).toBe(200);
    expect(ticks(100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('breaks the line at missing values', () => {
    const { points, path } = linePoints(frame, [0, 10, null, 5, 10], 10);
    expect(points[2]).toBeNull();
    expect(path).toBe('M18 50 L34 10 M66 30 L82 10');
    expect(linePoints(frame, [null, null], 10).path).toBe('');
    expect(linePoints(frame, [3], 10).path).toBe('M50 38');
  });

  it('supports a raised baseline', () => {
    const { points } = linePoints(frame, [50, 100], 100, 50);
    expect(points[0]?.y).toBe(50);
    expect(points[1]?.y).toBe(10);
  });

  it('picks at most N labels and always the last one', () => {
    expect(labelIndices(3, 6)).toEqual([0, 1, 2]);
    const idx = labelIndices(20, 6);
    expect(idx.length).toBeLessThanOrEqual(6);
    expect(idx.at(-1)).toBe(19);
  });

  it('formats dd.mm', () => {
    expect(dayMonth(new Date(2026, 10, 7).getTime())).toBe('07.11');
  });

  it('frames the speed axis in steps of 20 km/h', () => {
    expect(speedRange([])).toEqual({ min: 0, max: 100 });
    expect(speedRange([92, 108])).toEqual({ min: 80, max: 120 });
    expect(speedRange([100, 100])).toEqual({ min: 80, max: 120 });
  });
});

describe('historyView', () => {
  const strokes = [
    ...Array.from({ length: 6 }, (_, n) =>
      stroke(0, n, 'forehand', n < 3 ? 'technical-error' : 'variation'),
    ),
    ...Array.from({ length: 6 }, (_, n) => stroke(1, n, 'backhand')),
  ];
  const history = sessionHistory([session(0), session(1)], strokes);

  it('puts the numbers into aria labels and tap read-outs', () => {
    const v = historyView(history, 'et');
    expect(v.empty).toBe(false);
    expect(v.strokes.labels).toEqual(history.sessions.map((s) => s.label));
    expect(v.strokes.aria).toContain('6 lööki');
    expect(v.strokes.readout(0)).toContain('Forehand 6');
    expect(v.speed.aria).toContain('km/h');
    expect(v.consistency.aria).toContain('/ 100');
    expect(v.faults).toHaveLength(1);
    expect(v.faults[0]?.aria).toContain('50%');
    expect(v.faults[0]?.readout(1)).toContain('0%');
  });

  it('is English on request and flags a lower-bound speed', () => {
    const clipped = strokeRecord(
      {
        ...GOOD_FOREHAND_V3,
        headSpeedMps: 30,
        quality: { ...GOOD_FOREHAND_V3.quality, gyroSaturated: true },
      },
      T0 + 5,
    );
    const h = sessionHistory([session(0)], [{ ...clipped, sessionId: 's0' }]);
    const v = historyView(h, 'en');
    expect(v.strokes.title).toBe(reportStrings('en').strokesChart);
    expect(v.speed.readout(0)).toContain('≥108');
  });

  it('reports empty history', () => {
    expect(historyView(sessionHistory([], []), 'en').empty).toBe(true);
  });
});
