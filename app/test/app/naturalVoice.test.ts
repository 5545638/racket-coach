import { describe, expect, it, vi } from 'vitest';
import { CoachController } from '../../src/app/controller';
import type { SpokenLanguage, VoiceSettings } from '../../src/domain/types';
import { DownloadedVoiceStore } from '../../src/feedback/estonianVoice';
import { spokenPhrases } from '../../src/feedback/phraseCatalog';
import type { EngineUse, Speaker, SpeechItem } from '../../src/feedback/speech';
import { InMemoryRepository } from '../fakes';
import { FakeCache, wav } from '../feedback/fakeAudio';

/** Speaker that reports `use` for each item and records prepare() calls. */
class NaturalSpeaker implements Speaker {
  readonly items: SpeechItem[] = [];
  readonly prepared: string[] = [];
  primes = 0;
  constructor(private readonly use: (item: SpeechItem) => EngineUse = () => 'clip') {}
  say(item: SpeechItem): void {
    this.items.push(item);
    item.onEngine?.(this.use(item));
    item.onStart?.(0);
  }
  prime(): void {
    this.primes++;
  }
  prepare(voice: VoiceSettings, lang: SpokenLanguage): Promise<void> {
    this.prepared.push(`${voice.engine}:${voice.profile}:${voice.etSpeaker}:${lang}`);
    return Promise.resolve();
  }
}

const ttsOk = vi.fn(() =>
  Promise.resolve(new Response(wav(500), { headers: { 'Content-Type': 'audio/wav' } })),
) as unknown as typeof fetch;
const ttsDown = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;

async function setup(fetchFn: typeof fetch = ttsOk, speaker = new NaturalSpeaker()) {
  const cache = new FakeCache();
  const store = new DownloadedVoiceStore(() => Promise.resolve(cache), '/');
  const installed: string[] = [];
  const controller = new CoachController({
    repository: new InMemoryRepository(),
    speaker,
    now: () => 1_700_000_000_000,
    newId: () => 'id',
    sleep: () => Promise.resolve(),
    setTimer: () => () => undefined,
    estonianVoice: { fetch: fetchFn, store, onInstalled: (s) => installed.push(s) },
  });
  await controller.init();
  return { controller, speaker, store, cache, installed };
}

describe('natural voice in the controller', () => {
  it('prefetches the natural voice at start-up and when the voice changes', async () => {
    const { controller, speaker } = await setup();
    expect(speaker.prepared).toEqual(['natural:female:mari:en']);
    await controller.updateSettings({
      voice: { ...controller.settings.value.voice, profile: 'male' },
    });
    expect(speaker.prepared.at(-1)).toBe('natural:male:mari:en');
    await controller.startSession();
    expect(speaker.prepared.at(-1)).toBe('natural:male:mari:en');
  });

  it('"Proovi" plays the sample with the chosen profile and unlocks audio first', async () => {
    const { controller, speaker } = await setup();
    controller.testSpeech('male');
    expect(speaker.primes).toBe(1);
    expect(speaker.items.at(-1)).toMatchObject({
      text: 'Swing low to high',
      lang: 'en',
      voice: { engine: 'natural', profile: 'male' },
    });
    // The settings are not changed by trying a profile.
    expect(controller.settings.value.voice.profile).toBe('female');
  });

  it('counts how utterances were voiced and lists texts that fell back to the device voice', async () => {
    const speaker = new NaturalSpeaker((item) =>
      item.voice.profile === 'male' ? 'synth-fallback' : 'clip',
    );
    const { controller } = await setup(ttsOk, speaker);
    controller.testSpeech();
    controller.testSpeech('female');
    controller.testSpeech('male');
    expect(controller.speechStats.value.engines).toEqual({ clip: 2, 'synth-fallback': 1 });
    expect(controller.speechStats.value.fallbackTexts).toEqual(['Swing low to high']);
    await controller.startSession();
    expect(controller.speechStats.value.engines).toEqual({});
  });
});

describe('Estonian natural voice download (controller)', () => {
  it('without an Estonian device voice, a downloaded natural voice makes Estonian spoken', async () => {
    const { controller, speaker, installed } = await setup();
    await controller.updateSettings({ voice: { ...controller.settings.value.voice, lang: 'et' } });
    expect(controller.estonianVoice.value).toMatchObject({ state: 'missing', clips: 0 });
    expect(controller.spokenLanguage.value).toBe('en');
    expect(controller.estonianVoiceMissing.value).toBe(true);

    await controller.downloadEstonianVoice();
    const total = new Set(spokenPhrases('et')).size;
    expect(controller.estonianVoice.value).toEqual({ state: 'ready', clips: total, total });
    expect(installed).toEqual(['mari']);
    expect(controller.spokenLanguage.value).toBe('et');
    expect(controller.estonianVoiceMissing.value).toBe(false);
    expect(speaker.prepared.at(-1)).toBe('natural:female:mari:et');
    controller.testSpeech();
    expect(speaker.items.at(-1)).toMatchObject({ text: 'See on minu hääl', lang: 'et' });

    // The device voice engine does not use the downloaded voice.
    await controller.updateSettings({
      voice: { ...controller.settings.value.voice, engine: 'system' },
    });
    expect(controller.spokenLanguage.value).toBe('en');
  });

  it('a network / CORS failure is shown and English stays', async () => {
    const { controller } = await setup(ttsDown);
    await controller.updateSettings({ voice: { ...controller.settings.value.voice, lang: 'et' } });
    await controller.downloadEstonianVoice();
    expect(controller.estonianVoice.value).toMatchObject({
      state: 'failed',
      reason: 'network',
      clips: 0,
    });
    expect(controller.spokenLanguage.value).toBe('en');
    expect(controller.log.value[0]?.text).toContain('Estonian voice download failed: network');
  });

  it('a voice already in the cache is found at start-up; another speaker is missing', async () => {
    const first = await setup();
    await first.controller.downloadEstonianVoice();
    // A new controller on the same cache (app restart).
    const controller = new CoachController({
      repository: new InMemoryRepository(),
      speaker: new NaturalSpeaker(),
      estonianVoice: { fetch: ttsDown, store: first.store },
    });
    await controller.init();
    expect(controller.estonianVoice.value.state).toBe('ready');
    await controller.updateSettings({
      voice: { ...controller.settings.value.voice, etSpeaker: 'tambet' },
    });
    await vi.waitFor(() => {
      expect(controller.estonianVoice.value.state).toBe('missing');
    });
  });

  it('without Cache Storage the download is not offered', async () => {
    const controller = new CoachController({
      repository: new InMemoryRepository(),
      speaker: new NaturalSpeaker(),
    });
    await controller.init();
    expect(controller.estonianVoice.value).toEqual({ state: 'unavailable' });
    await controller.downloadEstonianVoice();
    expect(controller.estonianVoice.value).toEqual({ state: 'unavailable' });
  });
});
