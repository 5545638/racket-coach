import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipEngine } from '../../src/feedback/clipEngine';
import {
  DownloadedVoiceStore,
  FALLBACK_ET_SPEAKERS,
  TARTUNLP_TTS_URL,
  downloadEstonianVoice,
  downloadedCount,
  etClipFile,
  etSynthesisText,
  fetchEtSpeakers,
  parseSpeakers,
  wavDurationMs,
} from '../../src/feedback/estonianVoice';
import { SpeechQueue } from '../../src/feedback/speech';
import { FakeAudioContext, FakeCache, flush, wav } from './fakeAudio';
import { Events, FakeClock, FakeSynth, FakeUtterance } from './fakeSpeech';

beforeEach(() => {
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PHRASES = ['Parem', 'Just nii', 'Nüüd liiga avatud', 'Andur kadus'];

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: { text: string; speaker: string; speed: number } | null;
}

/** Mocked TartuNLP: a WAV of 100 ms per word; `fail` decides per call. */
function mockTts(fail: (call: Call, n: number) => 'network' | number | 'html' | null = () => null) {
  const calls: Call[] = [];
  const fetchFn = vi.fn((url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Call['body']) : null,
    };
    calls.push(call);
    const outcome = fail(call, calls.length);
    if (outcome === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    if (typeof outcome === 'number')
      return Promise.resolve(new Response('busy', { status: outcome }));
    if (outcome === 'html') return Promise.resolve(new Response('<html>'));
    const words = call.body?.text.split(' ').length ?? 1;
    return Promise.resolve(
      new Response(wav(100 * words), { headers: { 'Content-Type': 'audio/wav' } }),
    );
  });
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

function store() {
  const cache = new FakeCache();
  return { cache, store: new DownloadedVoiceStore(() => Promise.resolve(cache), '/app/') };
}

describe('Estonian natural voice download', () => {
  it('POSTs every phrase to TartuNLP and caches the WAVs and a manifest', async () => {
    const tts = mockTts();
    const { cache, store: s } = store();
    const progress: string[] = [];
    const result = await downloadEstonianVoice({
      fetch: tts.fetch,
      store: s,
      speaker: 'mari',
      phrases: PHRASES,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });
    expect(result).toMatchObject({ ok: true, clips: 4, downloaded: 4 });
    expect(result.ok && result.bytes).toBeGreaterThan(4 * 44);
    expect(tts.calls.every((c) => c.url === TARTUNLP_TTS_URL && c.method === 'POST')).toBe(true);
    expect(tts.calls.map((c) => c.body)).toContainEqual({
      text: 'Nüüd liiga avatud.',
      speaker: 'mari',
      speed: 1,
    });
    expect(progress.at(0)).toBe('0/4');
    expect(progress.at(-1)).toBe('4/4');
    expect(cache.entries.has(`/app/voice-cache/et-mari/${etClipFile('Parem')}`)).toBe(true);
    const manifest = await s.manifest('et-mari');
    expect(manifest?.clips['Nüüd liiga avatud']).toEqual({
      file: etClipFile('Nüüd liiga avatud'),
      durationMs: 300,
    });
    expect(await downloadedCount(s, 'mari', PHRASES)).toBe(4);
    expect(await downloadedCount(s, 'tambet', PHRASES)).toBe(0);
  });

  it('uses the cache: a second download fetches nothing, a new phrase only itself', async () => {
    const tts = mockTts();
    const { store: s } = store();
    await downloadEstonianVoice({ fetch: tts.fetch, store: s, speaker: 'mari', phrases: PHRASES });
    expect(tts.calls).toHaveLength(4);
    const again = await downloadEstonianVoice({
      fetch: tts.fetch,
      store: s,
      speaker: 'mari',
      phrases: PHRASES,
    });
    expect(again).toMatchObject({ ok: true, clips: 4, downloaded: 0 });
    expect(tts.calls).toHaveLength(4);
    await downloadEstonianVoice({
      fetch: tts.fetch,
      store: s,
      speaker: 'mari',
      phrases: [...PHRASES, 'Hea'],
    });
    expect(tts.calls.slice(4).map((c) => c.body?.text)).toEqual(['Hea.']);
  });

  it('network / CORS failure: a clear result, what was stored is kept for the next attempt', async () => {
    const tts = mockTts((_c, n) => (n >= 3 ? 'network' : null));
    const { store: s } = store();
    const result = await downloadEstonianVoice({
      fetch: tts.fetch,
      store: s,
      speaker: 'mari',
      phrases: PHRASES,
      parallel: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'network', clips: 2 });
    expect(tts.calls).toHaveLength(3); // stops at the first failure
    expect(await downloadedCount(s, 'mari', PHRASES)).toBe(2);
  });

  it('reports HTTP errors with the status, and a non-WAV answer as a format error', async () => {
    const { store: s1 } = store();
    expect(
      await downloadEstonianVoice({
        fetch: mockTts(() => 503).fetch,
        store: s1,
        speaker: 'mari',
        phrases: PHRASES,
      }),
    ).toEqual({ ok: false, reason: 'http', status: 503, clips: 0 });
    const { store: s2 } = store();
    expect(
      await downloadEstonianVoice({
        fetch: mockTts(() => 'html').fetch,
        store: s2,
        speaker: 'mari',
        phrases: PHRASES,
      }),
    ).toMatchObject({ ok: false, reason: 'format' });
  });

  it('reports a cache that refuses to store (quota, private mode)', async () => {
    const { cache, store: s } = store();
    cache.failPut = true;
    expect(
      await downloadEstonianVoice({
        fetch: mockTts().fetch,
        store: s,
        speaker: 'mari',
        phrases: PHRASES,
      }),
    ).toMatchObject({ ok: false, reason: 'storage', clips: 0 });
  });

  it('then plays the downloaded clips offline through the ClipEngine', async () => {
    const { store: s } = store();
    await downloadEstonianVoice({
      fetch: mockTts().fetch,
      store: s,
      speaker: 'mari',
      phrases: PHRASES,
    });
    const ctx = new FakeAudioContext();
    const clips = new ClipEngine({ createContext: () => ctx, sourceFor: () => s });
    const synth = new FakeSynth();
    const clock = new FakeClock();
    const queue = new SpeechQueue(synth as unknown as SpeechSynthesis, {
      now: clock.now,
      setTimer: clock.setTimer,
      clips,
    });
    const ev = new Events();
    const item = ev.item('Parem', 'feedback', undefined, 'et');
    queue.prime();
    await queue.prepare(item.voice, 'et');
    expect(ctx.decoded).toBe(4);
    queue.say(item);
    await flush();
    expect(ev.log).toEqual(['start Parem']);
    expect(synth.heard).toEqual([]);
    expect(queue.counters.engine.clip).toBe(1);
  });
});

describe('TartuNLP speakers', () => {
  it('reads the speaker list in several shapes', () => {
    expect(parseSpeakers(['Mari', 'Tambet'])).toEqual(['mari', 'tambet']);
    expect(
      parseSpeakers({ speakers: [{ name: 'Liivika' }, { speaker: 'kalev' }, { id: 'x' }] }),
    ).toEqual(['liivika', 'kalev', 'x']);
    expect(parseSpeakers({ voices: ['Mari', 'mari'] })).toEqual(['mari']);
    expect(parseSpeakers({ nothing: true })).toEqual([]);
  });

  it('falls back to the known speakers when the service cannot be asked', async () => {
    expect(await fetchEtSpeakers(mockTts(() => 'network').fetch)).toEqual(FALLBACK_ET_SPEAKERS);
    const listing = (() =>
      Promise.resolve(Response.json({ speakers: ['Mari', 'Albert'] }))) as unknown as typeof fetch;
    expect(await fetchEtSpeakers(listing)).toEqual(['mari', 'albert']);
  });
});

describe('WAV and text helpers', () => {
  it('reads the duration of a PCM WAV and rejects other bytes', () => {
    expect(wavDurationMs(wav(1234))).toBe(1234);
    expect(wavDurationMs(new TextEncoder().encode('<html>nope</html>').buffer)).toBeNull();
  });

  it('adds a final full stop for calmer prosody', () => {
    expect(etSynthesisText('Parem')).toBe('Parem.');
    expect(etSynthesisText('Hea. Täis pööre.')).toBe('Hea. Täis pööre.');
  });
});
