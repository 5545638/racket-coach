import { describe, expect, it } from 'vitest';
import {
  batteryLevel,
  bannerModels,
  detailsModel,
  guidanceDisplay,
  sessionStripModel,
  shortDeviceName,
  statusBarModel,
  strokeCardModel,
  verdictOf,
} from '../../src/ui/trainingViewModel';
import type { Headline } from '../../src/ui/viewModel';
import { GOOD_FOREHAND_V3, GOOD_SERVE, strokeRecord } from '../fixtures';

const headline = (over: Partial<Headline>): Headline => ({
  kind: 'good',
  tone: 'good',
  title: 'Hea',
  spoken: null,
  detail: null,
  correctionId: null,
  ...over,
});

describe('status bar', () => {
  it('colours the battery by level', () => {
    expect(batteryLevel(50)).toBe('ok');
    expect(batteryLevel(20)).toBe('ok');
    expect(batteryLevel(19)).toBe('low');
    expect(batteryLevel(10)).toBe('low');
    expect(batteryLevel(9)).toBe('critical');
  });

  it('shortens long device names and falls back', () => {
    expect(shortDeviceName('RacketCoach-A1B2C3D4', 'Sensor')).toBe('RacketCoach-A…');
    expect(shortDeviceName('  ', 'Sensor')).toBe('Sensor');
    expect(shortDeviceName(null, 'Sensor')).toBe('Sensor');
  });

  it('builds the model with mode, battery and optional mute', () => {
    const m = statusBarModel({
      deviceName: 'RC',
      fallbackName: 'Andur',
      batteryPercent: 15,
      mode: 'match',
      muted: true,
      language: 'et',
    });
    expect(m.modeLabel).toBe('Mäng');
    expect(m.battery?.level).toBe('low');
    expect(m.battery?.text).toBe('15%');
    expect(m.modes.filter((x) => x.selected).map((x) => x.id)).toEqual(['match']);
    expect(m.mute).toEqual({ muted: true, label: 'Lülita hääl sisse' });
    const none = statusBarModel({
      deviceName: null,
      fallbackName: 'Andur',
      batteryPercent: null,
      mode: 'training',
      muted: undefined,
      language: 'en',
    });
    expect(none.battery).toBeNull();
    expect(none.mute).toBeNull();
    expect(none.deviceName).toBe('Andur');
  });
});

describe('stroke card', () => {
  it('maps headlines to verdicts', () => {
    expect(verdictOf(headline({ kind: 'better' }), null)).toBe('good');
    expect(verdictOf(headline({ kind: 'correction', tone: 'fix' }), null)).toBe('correction');
    expect(verdictOf(headline({ kind: 'silent', tone: 'none' }), null)).toBe('notRated');
  });

  it('is empty before the first stroke', () => {
    const c = strokeCardModel({
      metrics: null,
      count: 0,
      headline: null,
      assessment: null,
      language: 'et',
    });
    expect(c).toMatchObject({ kind: 'empty', title: 'Löö esimene pall' });
  });

  it('shows stroke type, title and the spoken cue only when it differs', () => {
    const c = strokeCardModel({
      metrics: GOOD_SERVE,
      count: 3,
      headline: headline({
        kind: 'correction',
        tone: 'fix',
        title: 'Paranda',
        spoken: 'Fix it',
      }),
      assessment: null,
      language: 'et',
    });
    expect(c).toMatchObject({
      kind: 'stroke',
      strokeType: 'SERV',
      verdict: 'correction',
      spoken: 'Fix it',
      positive: false,
      count: 3,
    });
    const same = strokeCardModel({
      metrics: GOOD_FOREHAND_V3,
      count: 1,
      headline: headline({ spoken: 'Hea' }),
      assessment: null,
      language: 'et',
    });
    expect(same).toMatchObject({ strokeType: 'FOREHAND', spoken: null, positive: true });
  });

  it('chooses the guidance display by mode', () => {
    expect(guidanceDisplay('learning')).toBe('open');
    expect(guidanceDisplay('training')).toBe('collapsible');
    expect(guidanceDisplay('match')).toBe('none');
  });
});

describe('session strip', () => {
  it('is empty-safe', () => {
    const s = sessionStripModel([]);
    expect(s).toMatchObject({ last: '—', average: '—', goodShare: '—', goodPercent: null });
  });

  it('counts, averages speed and good share', () => {
    const fh = { ...GOOD_FOREHAND_V3, impactDetected: true, headSpeedMps: 20 };
    const sv = { ...GOOD_SERVE, impactDetected: true, headSpeedMps: 30 };
    const bad = {
      ...strokeRecord(fh, 3),
      cue: { ruleId: 'x', severity: 'fix', text: 'x' },
    } as const;
    const s = sessionStripModel([strokeRecord(fh, 1), strokeRecord(sv, 2), bad]);
    expect(s.counts).toEqual({ forehand: 2, backhand: 0, overhead: 1 });
    expect(s.last).toBe('≈ 72 km/h');
    expect(s.average).toBe(`≈ ${Math.round(((20 + 30 + 20) / 3) * 3.6)} km/h`);
    expect(s.goodShare).toBe('67%');
  });
});

describe('details and banners', () => {
  it('shows the no-baseline caption once', () => {
    const caption = 'Võrdlust veel pole: isiklik baas alles koguneb';
    const d = detailsModel(
      [
        {
          id: 'contact',
          title: 'T',
          rows: [
            { id: 'a', label: 'A', value: '1', status: 'not-assessable', note: caption },
            { id: 'b', label: 'B', value: '2', status: 'fault', note: 'Piir ≥ 3' },
          ],
        },
      ],
      'et',
    );
    expect(d.baselineNote).toBe(caption);
    expect(d.groups[0]?.rows[0]?.note).toBeNull();
    expect(d.groups[0]?.rows[1]?.note).toBe('Piir ≥ 3');
    expect(detailsModel([], 'et').baselineNote).toBeNull();
  });

  it('lists calibration and temperature banners', () => {
    expect(
      bannerModels({
        connected: true,
        calibrated: false,
        temperatureWarning: true,
        language: 'et',
      }).map((b) => b.kind),
    ).toEqual(['calibrate', 'temperature']);
    expect(
      bannerModels({
        connected: false,
        calibrated: false,
        temperatureWarning: false,
        language: 'et',
      }),
    ).toEqual([]);
  });
});
