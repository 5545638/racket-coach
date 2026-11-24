import { describe, expect, it } from 'vitest';
import { CoachController, countOf } from '../../src/app/controller';
import { COACH_LANES, laneOf } from '../../src/coach/coachEngine';
import type { FeedbackFrequency } from '../../src/domain/types';
import type {
  CancelScope,
  DropReason,
  Speaker,
  SpeechItem,
  VoiceInfo,
} from '../../src/feedback/speech';
import { SimulatedTransport } from '../../src/transport/simulatedTransport';
import { InMemoryRepository, immediateScheduler } from '../fakes';

interface Said {
  readonly item: SpeechItem;
  /** Stroke number (1-based) when it was queued; 0 before the first stroke. */
  readonly stroke: number;
  readonly lane: string | null;
  readonly heard: boolean;
}

/** Speaker that starts or drops each item at once, as `outcome` decides. */
class ScriptedSpeaker implements Speaker {
  readonly said: Said[] = [];
  cancelled = 0;
  controller: CoachController | null = null;
  constructor(
    private readonly voiceList: readonly VoiceInfo[] = [],
    private readonly outcome: (item: SpeechItem, n: number) => DropReason | number = () => 0,
  ) {}
  say(item: SpeechItem): void {
    const c = this.controller;
    const a = c?.assessment.value;
    const result = this.outcome(item, this.said.length);
    this.said.push({
      item,
      stroke: c?.strokes.value.length ?? 0,
      lane: a && item.category !== 'system' ? laneOf(a.strokeType, a.swingStyle) : null,
      heard: typeof result === 'number',
    });
    if (typeof result === 'number') item.onStart?.(result);
    else item.onDrop?.(result);
  }
  cancel(scope: CancelScope = 'all'): void {
    if (scope !== 'queued-stroke') this.cancelled++;
  }
  prime(): void {
    // nothing to unlock
  }
  voices(): readonly VoiceInfo[] {
    return this.voiceList;
  }
  stroke(): Said[] {
    return this.said.filter((s) => s.item.category !== 'system');
  }
  heard(category?: SpeechItem['category']): Said[] {
    return this.stroke().filter((s) => s.heard && (!category || s.item.category === category));
  }
}

const ET_VOICE: VoiceInfo = {
  voiceURI: 'uri:Karl',
  name: 'Karl',
  lang: 'et-EE',
  localService: true,
  isDefault: false,
};

async function setup(speaker = new ScriptedSpeaker()) {
  const clock = { t: 1_700_000_000_000 };
  const repository = new InMemoryRepository();
  let id = 0;
  const controller = new CoachController({
    repository,
    speaker,
    now: () => clock.t,
    newId: () => `id-${++id}`,
    sleep: () => Promise.resolve(),
    setTimer: () => () => undefined,
    reconnectAttempts: 1,
  });
  speaker.controller = controller;
  await controller.init();
  const transport = new SimulatedTransport(4000, immediateScheduler, 7);
  await controller.connect(transport);
  await controller.capturePose('faceUp');
  await controller.capturePose('tipUp');
  /** Plays `n` strokes `gapMs` apart. */
  const play = (n: number, gapMs = 5000) => {
    for (let i = 0; i < n; i++) {
      clock.t += gapMs;
      transport.emitSwing();
    }
  };
  return { controller, repository, speaker, transport, clock, play };
}

async function run(frequency: FeedbackFrequency, speaker = new ScriptedSpeaker()) {
  const s = await setup(speaker);
  await s.controller.updateSettings({ feedbackFrequency: frequency });
  s.play(40);
  return s;
}

describe('feedback frequency', () => {
  it("'every': the scripted session has corrections and praise (baseline for the other tests)", async () => {
    const { speaker } = await run('every');
    expect(speaker.heard('correction').length).toBeGreaterThan(3);
    expect(speaker.heard('feedback').length).toBeGreaterThan(0);
  });

  it("'off': no stroke speech at all", async () => {
    const { speaker, controller } = await run('off');
    expect(speaker.stroke()).toEqual([]);
    expect(countOf(controller.speechStats.value.suppressed)).toBeGreaterThan(0);
  });

  it.each([
    ['every2', 2],
    ['every3', 3],
  ] as const)("'%s': heard corrections are at least %i strokes apart", async (frequency, n) => {
    const { speaker, controller } = await run(frequency);
    const strokes = speaker.heard('correction').map((s) => s.stroke);
    expect(strokes.length).toBeGreaterThan(1);
    for (let i = 1; i < strokes.length; i++) {
      expect((strokes[i] ?? 0) - (strokes[i - 1] ?? 0)).toBeGreaterThanOrEqual(n);
    }
    expect(controller.speechStats.value.suppressed.frequency ?? 0).toBeGreaterThan(0);
  });

  it("'changes': a lane never hears the same correction twice in a row", async () => {
    const { speaker } = await run('changes');
    const last = new Map<string, string>();
    for (const s of speaker.heard('correction')) {
      expect(last.get(s.lane ?? '')).not.toBe(s.item.text);
      last.set(s.lane ?? '', s.item.text);
    }
    expect(speaker.heard('correction').length).toBeGreaterThan(0);
  });
});

describe('heard tracking', () => {
  it('no praise when every correction is dropped by the queue; same coach state as muted', async () => {
    const dropAll = new ScriptedSpeaker([], (item) => (item.category === 'system' ? 0 : 'stale'));
    const dropped = await run('every', dropAll);
    expect(dropAll.heard()).toEqual([]);
    // Praise was never even decided: no Better / reinforce item was queued.
    expect(dropAll.stroke().filter((s) => s.item.category === 'feedback')).toEqual([]);
    for (const lane of COACH_LANES) {
      expect(
        dropped.controller.coachState.value.byLane[lane].focus?.lastHeardLevel ?? null,
      ).toBeNull();
    }
    expect(dropped.controller.speechStats.value.dropped.stale).toBeGreaterThan(0);

    const muted = await setup();
    await muted.controller.updateSettings({ speechMuted: true });
    muted.play(40);
    expect(muted.speaker.stroke()).toEqual([]);
    // Dropping after the fact gives the coach the same "heard" truth as never saying it.
    expect(dropped.controller.coachState.value).toEqual(muted.controller.coachState.value);
  });

  it('praise follows only a heard cue when only some cues get through', async () => {
    // Every second correction is dropped.
    let k = 0;
    const flaky = new ScriptedSpeaker([], (item) =>
      item.category === 'correction' ? (k++ % 2 === 0 ? 'stale' : 0) : 0,
    );
    const { speaker } = await run('every', flaky);
    const heardStrokes = speaker.heard('correction').map((s) => s.stroke);
    for (const praise of speaker.heard('feedback')) {
      expect(heardStrokes.some((n) => n < praise.stroke)).toBe(true);
    }
  });
});

describe('mute and rally', () => {
  it('toggleMute: persisted, drops stroke speech, system messages still spoken', async () => {
    const { controller, repository, speaker, transport, play } = await setup();
    expect(controller.speechMuted.value).toBe(false);
    await controller.toggleMute();
    expect(controller.speechMuted.value).toBe(true);
    expect(repository.settings?.speechMuted).toBe(true);
    expect(speaker.cancelled).toBe(1);
    play(10);
    expect(speaker.stroke()).toEqual([]);
    expect(controller.speechStats.value.suppressed.muted ?? 0).toBeGreaterThan(0);
    transport.simulateLinkLoss();
    expect(speaker.said.at(-1)?.item).toMatchObject({
      text: 'Sensor disconnected',
      category: 'system',
    });
    await controller.toggleMute();
    expect(controller.speechMuted.value).toBe(false);
  });

  it('autoRallyMute: quiet from the 3rd stroke < 3.5 s apart until a ≥ 6 s pause', async () => {
    const { controller, speaker, play } = await setup();
    await controller.updateSettings({ autoRallyMute: true });
    play(2, 10_000);
    const before = speaker.stroke().length;
    play(12, 2000);
    expect(controller.rallyActive.value).toBe(true);
    // Strokes 3..14 of the rally: nothing per stroke.
    expect(speaker.stroke().filter((s) => s.stroke >= 4)).toEqual([]);
    expect(speaker.stroke().length).toBeLessThanOrEqual(before + 1);
    expect(controller.speechStats.value.suppressed.rally ?? 0).toBeGreaterThan(0);
    play(10, 7000);
    expect(controller.rallyActive.value).toBe(false);
    expect(speaker.stroke().some((s) => s.stroke > 14)).toBe(true);
  });

  it('without autoRallyMute, fast strokes are still coached', async () => {
    const { speaker, play } = await setup();
    play(20, 2000);
    expect(speaker.stroke().some((s) => s.stroke >= 4)).toBe(true);
  });
});

describe('spoken language', () => {
  it('Estonian without an Estonian voice: English is spoken and the UI is told', async () => {
    const { controller, speaker, transport } = await setup(new ScriptedSpeaker([]));
    await controller.updateSettings({ voice: { ...controller.settings.value.voice, lang: 'et' } });
    expect(controller.spokenLanguage.value).toBe('en');
    expect(controller.estonianVoiceMissing.value).toBe(true);
    transport.simulateLinkLoss();
    expect(speaker.said.at(-1)?.item).toMatchObject({ text: 'Sensor disconnected', lang: 'en' });
  });

  it('Estonian with an Estonian voice: system messages in Estonian', async () => {
    const { controller, speaker, transport } = await setup(new ScriptedSpeaker([ET_VOICE]));
    await controller.updateSettings({ voice: { ...controller.settings.value.voice, lang: 'et' } });
    expect(controller.spokenLanguage.value).toBe('et');
    expect(controller.estonianVoiceMissing.value).toBe(false);
    transport.simulateLinkLoss();
    expect(speaker.said.at(-1)?.item).toMatchObject({ text: 'Anduri ühendus katkes', lang: 'et' });
    controller.testSpeech();
    expect(speaker.said.at(-1)?.item).toMatchObject({ lang: 'et', category: 'info' });
  });

  it('passes the voice profile with every item', async () => {
    const { controller, speaker, play } = await setup();
    const voice = { lang: 'en', rate: 1.4, pitch: 0.8, volume: 0.6 } as const;
    await controller.updateSettings({ voice });
    play(10);
    expect(speaker.stroke().length).toBeGreaterThan(0);
    for (const s of speaker.stroke()) expect(s.item.voice).toEqual(voice);
  });
});

describe('latency diagnostics', () => {
  it('keeps p50 / p95 of stroke-to-onstart latency for the session', async () => {
    let n = 0;
    const speaker = new ScriptedSpeaker([], (item) => (item.category === 'system' ? 0 : 100 * ++n));
    const { controller, play } = await setup(speaker);
    play(40);
    const stats = controller.speechStats.value;
    const k = stats.latenciesMs.length;
    expect(k).toBe(speaker.heard().length);
    expect(k).toBeGreaterThan(3);
    expect(stats.latenciesMs).toEqual(Array.from({ length: k }, (_, i) => 100 * (i + 1)));
    expect(stats.p50Ms).toBeCloseTo((100 * (k + 1)) / 2);
    expect(stats.p95Ms).toBeCloseTo(100 + 100 * (k - 1) * 0.95);
    // Each stroke cue carries the stroke's receivedAt.
    for (const s of speaker.stroke()) expect(s.item.createdAt).toBeGreaterThan(0);
    await controller.startSession();
    expect(controller.speechStats.value.latenciesMs).toEqual([]);
  });
});
