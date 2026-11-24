import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClipEngine,
  SEQUENCE_GAP_MS,
  StaticClipSource,
  clipVoiceId,
  parseManifest,
} from '../../src/feedback/clipEngine';
import { type EngineUse, SpeechQueue, type SpeechItem } from '../../src/feedback/speech';
import { Events, FakeClock, FakeSynth, FakeUtterance } from './fakeSpeech';
import { FakeAudioContext, FakeClipSource, flush } from './fakeAudio';

beforeEach(() => {
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CUE = 'Face too open';
const NEWER = 'Swing low to high';
const LEARN = 'Swinging low to high adds topspin and margin over the net.';
const SYSTEM = 'Sensor lost';

function setup(keys: readonly string[] = [CUE, NEWER, 'Better', SYSTEM, LEARN]) {
  const synth = new FakeSynth();
  const clock = new FakeClock();
  const ctx = new FakeAudioContext();
  const source = new FakeClipSource({ 'en-female': keys, 'en-male': [CUE] });
  let contexts = 0;
  const clips = new ClipEngine({
    createContext: () => {
      contexts++;
      return ctx;
    },
    sourceFor: (voiceId) => (voiceId.startsWith('en-') ? source : null),
  });
  const queue = new SpeechQueue(synth as unknown as SpeechSynthesis, {
    now: clock.now,
    setTimer: clock.setTimer,
    clips,
  });
  const ev = new Events();
  const uses: string[] = [];
  const item = (
    text: string,
    category: SpeechItem['category'],
    createdAt?: number,
    patch: Partial<SpeechItem['voice']> = {},
  ): SpeechItem => {
    const base = ev.item(text, category, createdAt);
    return {
      ...base,
      voice: { ...base.voice, ...patch },
      onEngine: (use: EngineUse) => uses.push(`${use} ${text}`),
    };
  };
  return { synth, clock, ctx, source, clips, queue, ev, uses, item, contexts: () => contexts };
}

/** Prime (tap) and prefetch, as connect() does. */
async function ready(s: ReturnType<typeof setup>) {
  s.queue.prime();
  await s.queue.prepare(s.item('', 'info').voice, 'en');
}

describe('ClipEngine: engine choice per item', () => {
  it('plays the natural clip when the active profile has one for the exact text', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(CUE, 'correction'));
    await flush();
    expect(s.ctx.playedTags()).toEqual([CUE]);
    expect(s.synth.heard).toEqual([]);
    expect(s.uses).toEqual([`clip ${CUE}`]);
    expect(s.ev.log).toEqual([`start ${CUE}`]);
    expect(s.queue.counters.engine).toEqual({ clip: 1, synth: 0, 'synth-fallback': 0 });
  });

  it('falls back to the device voice for a text without a clip (synth-fallback)', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item('Hold the finish', 'correction'));
    await flush();
    expect(s.synth.heard).toEqual(['Hold the finish']);
    expect(s.ctx.playedTags()).toEqual([]);
    expect(s.uses).toEqual(['synth-fallback Hold the finish']);
    expect(s.queue.counters.engine['synth-fallback']).toBe(1);
  });

  it("uses the device voice when the settings ask for 'system' (not a fallback)", async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(CUE, 'correction', undefined, { engine: 'system' }));
    expect(s.synth.heard).toEqual([CUE]);
    expect(s.uses).toEqual([`synth ${CUE}`]);
  });

  it('picks the clip of the chosen profile; a profile without the text falls back', async () => {
    const s = setup();
    s.queue.prime();
    await s.queue.prepare({ ...s.item('', 'info').voice, profile: 'male' }, 'en');
    s.queue.say(s.item(CUE, 'correction', undefined, { profile: 'male' }));
    await flush();
    expect(s.ctx.playedTags()).toEqual([CUE]);
    s.ctx.last().end();
    s.queue.say(s.item('Better', 'feedback', undefined, { profile: 'male' }));
    await flush();
    expect(s.synth.heard).toEqual(['Better']);
  });

  it('without a loaded clip list the first cue falls back, later ones get the clip', async () => {
    const s = setup();
    s.queue.prime();
    s.queue.say(s.item(CUE, 'correction'));
    expect(s.uses).toEqual([`synth-fallback ${CUE}`]);
    s.synth.finish();
    await flush(); // the clip list was loaded meanwhile
    s.queue.say(s.item('Better', 'feedback'));
    await flush();
    expect(s.ctx.playedTags()).toEqual(['Better']);
  });

  it('voices a learning-mode "cue. explanation" as a sequence of two clips', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(`${NEWER}. ${LEARN}`, 'correction'));
    await flush();
    expect(s.ctx.playedTags()).toEqual([NEWER, LEARN]);
    const [a, b] = s.ctx.started.filter((x) => x.startedAt !== null).slice(-2);
    expect((b?.startedAt ?? 0) - (a?.startedAt ?? 0)).toBeCloseTo(
      NEWER.length / 1000 + SEQUENCE_GAP_MS / 1000,
    );
    expect(s.ev.log).toEqual([`start ${NEWER}. ${LEARN}`]);
    a?.end(); // the first clip ending is not the end of the utterance
    s.queue.say(s.item('Better', 'feedback', 0));
    expect(s.ev.log).toHaveLength(1);
  });

  it('applies the volume through a gain node; rate and pitch are not applied to clips', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(CUE, 'correction', undefined, { volume: 0.4, rate: 1.6 }));
    await flush();
    expect(s.ctx.gains.at(-1)?.gain.value).toBe(0.4);
  });
});

describe('ClipEngine: queue rules are the same as with the device voice', () => {
  it('no overlap: the next clip starts only after the previous ended', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(SYSTEM, 'system'));
    await flush();
    s.queue.say(s.item(CUE, 'correction'));
    await flush();
    expect(s.ctx.playedTags()).toEqual([SYSTEM]); // a system message is never cut by a cue
    s.clock.advance(5000);
    expect(s.ctx.playedTags()).toEqual([SYSTEM]);
    s.ctx.last().end();
    await flush();
    // The cue was queued at t=0 and is now 5 s old: dropped as stale.
    expect(s.ev.log).toEqual([`start ${SYSTEM}`, `drop ${CUE} stale`]);
  });

  it('a newer stroke cue cuts a clip only after its minimum time, stopping its source', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(CUE, 'correction', 0));
    await flush();
    const first = s.ctx.last();
    s.clock.advance(100);
    s.queue.say(s.item(NEWER, 'correction', 100));
    await flush();
    expect(first.stopped).toBe(false);
    s.clock.advance(1000); // CUE has 3 words: 1050 ms minimum
    await flush();
    expect(first.stopped).toBe(true);
    expect(s.ctx.playedTags()).toEqual([CUE, NEWER]);
    expect(s.ev.log).toEqual([`start ${CUE}`, `start ${NEWER}`]);
  });

  it('priorities: a queued system message goes before a queued cue', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item('Better', 'feedback', 0));
    await flush();
    s.queue.say(s.item(CUE, 'correction', 0));
    s.queue.say(s.item(SYSTEM, 'system', 0));
    s.clock.advance(600);
    await flush();
    s.ctx.last().end();
    await flush();
    expect(s.ctx.playedTags()[1]).toBe(SYSTEM);
  });

  it('cancel() stops the playing clip and drops the queue', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(CUE, 'correction'));
    await flush();
    s.queue.cancel('stroke');
    expect(s.ctx.last().stopped).toBe(true);
    // A late `ended` of the stopped source changes nothing.
    s.queue.say(s.item('Better', 'feedback'));
    await flush();
    expect(s.ctx.playedTags()).toEqual([CUE, 'Better']);
  });

  it('the end watchdog uses the clip length: a lost `ended` does not block the queue', async () => {
    const s = setup();
    await ready(s);
    s.queue.say(s.item(CUE, 'correction', 0));
    await flush();
    s.clock.advance(CUE.length + 2500 + 1);
    expect(s.queue.counters.recoveries).toBe(1);
    s.queue.say(s.item('Better', 'feedback'));
    await flush();
    expect(s.ctx.playedTags()).toEqual([CUE, 'Better']);
  });
});

describe('ClipEngine: iOS unlock and resume', () => {
  it('prime() creates the context once, resumes it and plays a silent buffer', () => {
    const s = setup();
    expect(s.contexts()).toBe(0);
    s.queue.prime();
    s.queue.prime();
    expect(s.contexts()).toBe(1);
    expect(s.ctx.state).toBe('running');
    expect(
      s.ctx.started.filter((x) => (x.buffer as { tag?: string }).tag === 'silent'),
    ).toHaveLength(2);
  });

  it('resumes a suspended or interrupted context before playing', async () => {
    const s = setup();
    await ready(s);
    s.ctx.setState('suspended');
    const before = s.ctx.resumes;
    s.queue.say(s.item(CUE, 'correction'));
    await flush();
    expect(s.ctx.resumes).toBe(before + 1);
    expect(s.ctx.playedTags()).toEqual([CUE]);
  });

  it("after a phone call ('interrupted') the context is resumed", async () => {
    const s = setup();
    await ready(s);
    const before = s.ctx.resumes;
    s.ctx.allowResume = false;
    s.ctx.setState('interrupted');
    expect(s.ctx.resumes).toBe(before + 1);
  });

  it('a context that stays locked: the watchdog retries the cue with the device voice', async () => {
    const s = setup();
    await s.queue.prepare(s.item('', 'info').voice, 'en'); // no tap yet
    s.ctx.allowResume = false;
    s.queue.say(s.item(CUE, 'correction'));
    await flush();
    expect(s.ctx.playedTags()).toEqual([]);
    s.clock.advance(1500);
    expect(s.synth.heard).toEqual([CUE]);
    expect(s.uses).toEqual([`clip ${CUE}`, `synth-fallback ${CUE}`]);
    expect(s.ev.log).toEqual([`start ${CUE}`]);
  });
});

describe('ClipEngine: prefetch', () => {
  it('prepare() loads the clip list once and decodes every clip of the voice', async () => {
    const s = setup();
    await s.clips.prepare(s.item('', 'info').voice, 'en');
    expect(s.source.manifestCalls).toBe(1);
    expect(s.ctx.decoded).toBe(5);
    await s.clips.prepare(s.item('', 'info').voice, 'en');
    expect(s.source.manifestCalls).toBe(1);
    expect(s.ctx.decoded).toBe(5);
    s.queue.prime();
    s.queue.say(s.item(CUE, 'correction'));
    await flush();
    expect(s.source.clipCalls).toBe(5); // played from the decoded buffer
  });

  it('decodes lazily when a cue comes before the prefetch', async () => {
    const s = setup();
    s.queue.prime();
    s.queue.say(s.item(CUE, 'correction')); // list not loaded: device voice
    s.synth.finish();
    await flush();
    s.queue.say(s.item('Better', 'feedback'));
    await flush();
    expect(s.ctx.decoded).toBe(1);
    expect(s.ctx.playedTags()).toEqual(['Better']);
  });

  it('a clip that cannot be fetched is an error: the queue moves on', async () => {
    const s = setup();
    s.queue.prime();
    s.source.failClips = true;
    await s.queue.prepare(s.item('', 'info').voice, 'en');
    s.queue.say(s.item(CUE, 'correction'));
    await flush();
    expect(s.ev.log).toEqual([`drop ${CUE} error`]);
    s.queue.say(s.item('Hold the finish', 'correction'));
    expect(s.synth.heard).toEqual(['Hold the finish']);
  });

  it('forget() makes the engine reload a voice (new download)', async () => {
    const s = setup();
    await s.clips.prepare(s.item('', 'info').voice, 'en');
    expect(s.clips.clipCount('en-female')).toBe(5);
    s.clips.forget('en-female');
    expect(s.clips.clipCount('en-female')).toBeNull();
    await s.clips.prepare(s.item('', 'info').voice, 'en');
    expect(s.source.manifestCalls).toBe(2);
  });
});

describe('clip manifests', () => {
  it('maps the settings to a voice id', () => {
    const v = setup().item('', 'info').voice;
    expect(clipVoiceId(v, 'en')).toBe('en-female');
    expect(clipVoiceId({ ...v, profile: 'male' }, 'en')).toBe('en-male');
    expect(clipVoiceId({ ...v, etSpeaker: 'tambet' }, 'et')).toBe('et-tambet');
  });

  it('parses a manifest, normalising keys and skipping malformed entries', () => {
    expect(
      parseManifest({
        clips: {
          ' Better. ': { file: 'a.m4a', durationMs: 600 },
          Bad: { file: 3, durationMs: 1 },
          Zero: { file: 'z.m4a', durationMs: 0 },
        },
      }),
    ).toEqual({ clips: { Better: { file: 'a.m4a', durationMs: 600 } } });
    expect(parseManifest('nope')).toBeNull();
  });

  it('StaticClipSource fetches from <base>voice/<voiceId>/', async () => {
    const urls: string[] = [];
    const fetchFn = ((url: string) => {
      urls.push(url);
      return Promise.resolve(
        url.endsWith('manifest.json')
          ? Response.json({ clips: { Better: { file: 'b.m4a', durationMs: 500 } } })
          : new Response(new Uint8Array([1, 2, 3])),
      );
    }) as unknown as typeof fetch;
    const source = new StaticClipSource(fetchFn, '/racket-coach/');
    expect(await source.manifest('en-male')).toEqual({
      clips: { Better: { file: 'b.m4a', durationMs: 500 } },
    });
    expect((await source.clip('en-male', 'b.m4a')).byteLength).toBe(3);
    expect(urls).toEqual([
      '/racket-coach/voice/en-male/manifest.json',
      '/racket-coach/voice/en-male/b.m4a',
    ]);
  });
});
