import type { SpokenLanguage, VoiceSettings } from '../domain/types';
import { clipKey, clipSequence } from './phraseCatalog';
import type { ClipPlayer, EngineHandlers, SpeechItem } from './speech';

/**
 * Natural voice: pre-recorded clips played with Web Audio. English clips ship
 * with the app (public/voice/en-<profile>/, made by tools/voice); Estonian
 * clips are downloaded once on request (estonianVoice.ts). A clip is found by
 * its text (phraseCatalog.clipKey); a learning-mode "cue. explanation" text
 * plays as a sequence of sentence clips.
 *
 * iOS: one AudioContext, created on first use and resumed in `prime()`, which
 * must run in a user gesture; a context left 'suspended' or 'interrupted'
 * (phone call, Siri) is resumed again before playing.
 */

/* Minimal Web Audio surface, so tests can use fakes. */

export interface AudioBufferLike {
  /** Seconds. */
  readonly duration: number;
}

export interface AudioNodeLike {
  connect(destination: never): unknown;
  disconnect(): void;
}

export interface AudioSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike extends AudioNodeLike {
  readonly gain: { value: number };
}

export interface AudioContextLike {
  /** 'suspended' | 'running' | 'closed', and on iOS 'interrupted'. */
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  onstatechange: (() => void) | null;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource(): AudioSourceLike;
  createGain(): GainLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
}

/** One voice's clip list: key (clipKey of the text) → file and length. */
export interface ClipManifest {
  readonly clips: Readonly<Record<string, { readonly file: string; readonly durationMs: number }>>;
}

/** Where a voice's manifest and clips come from (the app's files, or the download cache). */
export interface ClipSource {
  /** The voice's clip list, or null when it has none. */
  manifest(voiceId: string): Promise<ClipManifest | null>;
  /** Bytes of one clip file. */
  clip(voiceId: string, file: string): Promise<ArrayBuffer>;
}

/** Clips shipped in public/voice/<voiceId>/ (`baseUrl` = Vite's BASE_URL). */
export class StaticClipSource implements ClipSource {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly baseUrl: string,
  ) {}

  private url(voiceId: string, file: string): string {
    return `${this.baseUrl.replace(/\/?$/, '/')}voice/${voiceId}/${file}`;
  }

  async manifest(voiceId: string): Promise<ClipManifest | null> {
    const response = await this.fetchFn(this.url(voiceId, 'manifest.json'));
    if (!response.ok) return null;
    return parseManifest(await response.json());
  }

  async clip(voiceId: string, file: string): Promise<ArrayBuffer> {
    const response = await this.fetchFn(this.url(voiceId, file));
    if (!response.ok) throw new Error(`clip ${voiceId}/${file}: HTTP ${response.status}`);
    return response.arrayBuffer();
  }
}

/** A manifest object, validated (malformed entries are left out). */
export function parseManifest(data: unknown): ClipManifest | null {
  const clips: unknown =
    typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['clips'] : null;
  if (typeof clips !== 'object' || clips === null) return null;
  const out: Record<string, { file: string; durationMs: number }> = {};
  for (const [text, entry] of Object.entries(clips)) {
    const e = entry as Partial<Record<string, unknown>> | null;
    const file = e?.['file'];
    const durationMs = e?.['durationMs'];
    if (typeof file !== 'string' || typeof durationMs !== 'number' || !(durationMs > 0)) continue;
    // Keys are normalised again: a hand-edited manifest still matches.
    out[clipKey(text)] = { file, durationMs };
  }
  return { clips: out };
}

/** Voice whose clips voice `lang` for these settings: "en-female", "en-male", "et-mari", … */
export const clipVoiceId = (voice: VoiceSettings, lang: SpokenLanguage): string =>
  lang === 'en' ? `en-${voice.profile}` : `et-${voice.etSpeaker}`;

/** Pause between the clips of one sequence (cue, then its explanation), ms. */
export const SEQUENCE_GAP_MS = 150;

/** Clips decoded at the same time while prefetching. */
const PREFETCH_PARALLEL = 4;

interface VoiceClips {
  /** Null while loading or when the voice has no clips. */
  manifest: Map<string, { file: string; durationMs: number }> | null;
  loading: Promise<void> | null;
  readonly buffers: Map<string, Promise<AudioBufferLike>>;
}

export interface ClipEngineOptions {
  /** Creates the AudioContext (once, on first use). */
  readonly createContext: () => AudioContextLike;
  /** The source of a voice's clips, or null for a voice that cannot have any. */
  readonly sourceFor: (voiceId: string) => ClipSource | null;
}

export class ClipEngine implements ClipPlayer {
  readonly name = 'clip' as const;
  private context: AudioContextLike | null = null;
  private readonly voices = new Map<string, VoiceClips>();
  /** Bumped by stop(): a speak() still decoding gives up. */
  private generation = 0;
  private playing: { sources: AudioSourceLike[]; gain: GainLike } | null = null;

  constructor(private readonly options: ClipEngineOptions) {}

  /* -------------------------------------------------------------- context */

  private ctx(): AudioContextLike {
    if (!this.context) {
      const ctx = this.options.createContext();
      ctx.onstatechange = () => {
        // iOS: after a call or Siri the context is 'interrupted'; a resume()
        // issued now completes when the interruption ends.
        if (ctx.state === 'interrupted') void ctx.resume().catch(() => undefined);
      };
      this.context = ctx;
    }
    return this.context;
  }

  /** State of the AudioContext ('none' before first use). */
  contextState(): string {
    return this.context?.state ?? 'none';
  }

  /** Unlocks audio: resume() and a silent buffer, inside the user gesture (iOS). */
  prime(busy: boolean): void {
    const ctx = this.ctx();
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    if (busy) return;
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, 22_050);
    source.connect(ctx.destination as never);
    source.start(0);
  }

  /* ---------------------------------------------------------------- clips */

  private voice(voiceId: string): VoiceClips {
    let v = this.voices.get(voiceId);
    if (!v) {
      v = { manifest: null, loading: null, buffers: new Map() };
      this.voices.set(voiceId, v);
    }
    return v;
  }

  /** Loads the manifest of `voiceId` once (again after `forget`). */
  private load(voiceId: string): Promise<void> {
    const v = this.voice(voiceId);
    if (v.manifest) return Promise.resolve();
    if (v.loading) return v.loading;
    const source = this.options.sourceFor(voiceId);
    if (!source) return Promise.resolve();
    v.loading = source
      .manifest(voiceId)
      .then((manifest) => {
        if (this.voices.get(voiceId) !== v) return;
        v.manifest = manifest
          ? new Map(Object.entries(manifest.clips).map(([text, e]) => [clipKey(text), e]))
          : null;
      })
      .finally(() => {
        v.loading = null;
      });
    return v.loading;
  }

  /** Drops what is known about `voiceId` (its clips changed, e.g. after a download). */
  forget(voiceId: string): void {
    this.voices.delete(voiceId);
  }

  /** Has `voiceId` a clip list (loaded)? Number of clips, or null when not loaded / none. */
  clipCount(voiceId: string): number | null {
    return this.voices.get(voiceId)?.manifest?.size ?? null;
  }

  private buffer(voiceId: string, key: string): Promise<AudioBufferLike> {
    const v = this.voice(voiceId);
    const cached = v.buffers.get(key);
    if (cached) return cached;
    const entry = v.manifest?.get(key);
    const source = this.options.sourceFor(voiceId);
    if (!entry || !source) return Promise.reject(new Error(`no clip for "${key}"`));
    const decoded = source
      .clip(voiceId, entry.file)
      .then((bytes) => this.ctx().decodeAudioData(bytes));
    v.buffers.set(key, decoded);
    // A failed clip may be fetched again later.
    decoded.catch(() => {
      if (v.buffers.get(key) === decoded) v.buffers.delete(key);
    });
    return decoded;
  }

  /** The clip keys voicing `item`, or null (no clip, or the voice not loaded yet). */
  private plan(item: SpeechItem): { voiceId: string; keys: string[]; durationMs: number } | null {
    const voiceId = clipVoiceId(item.voice, item.lang);
    const manifest = this.voices.get(voiceId)?.manifest;
    if (!manifest) {
      void this.load(voiceId).catch(() => undefined); // ready for the next cue
      return null;
    }
    const keys = clipSequence(item.text, (k) => manifest.has(k));
    if (!keys) return null;
    const durationMs = keys.reduce(
      (sum, k, i) => sum + (manifest.get(k)?.durationMs ?? 0) + (i > 0 ? SEQUENCE_GAP_MS : 0),
      0,
    );
    return { voiceId, keys, durationMs };
  }

  clipDurationMs(item: SpeechItem): number | null {
    return this.plan(item)?.durationMs ?? null;
  }

  /** Loads the clip list of the voice for `lang` and decodes every clip. */
  async prepare(voice: VoiceSettings, lang: SpokenLanguage): Promise<void> {
    const voiceId = clipVoiceId(voice, lang);
    await this.load(voiceId);
    const keys = [...(this.voices.get(voiceId)?.manifest?.keys() ?? [])];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < keys.length) {
        const key = keys[next++];
        if (key !== undefined) await this.buffer(voiceId, key).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: PREFETCH_PARALLEL }, worker));
  }

  /* ------------------------------------------------------------- playback */

  speak(item: SpeechItem, handlers: EngineHandlers): void {
    const plan = this.plan(item);
    if (!plan) {
      handlers.onError();
      return;
    }
    const generation = ++this.generation;
    const ctx = this.ctx();
    const running =
      ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => undefined);
    void Promise.all([running, ...plan.keys.map((k) => this.buffer(plan.voiceId, k))]).then(
      ([, ...buffers]) => {
        if (generation !== this.generation) return; // stopped meanwhile
        if (ctx.state !== 'running') return; // still locked: the queue's watchdog takes over
        this.play(ctx, buffers, item.voice.volume, handlers);
      },
      () => {
        if (generation === this.generation) handlers.onError();
      },
    );
  }

  private play(
    ctx: AudioContextLike,
    buffers: AudioBufferLike[],
    volume: number,
    handlers: EngineHandlers,
  ): void {
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination as never);
    let at = ctx.currentTime;
    const sources = buffers.map((buffer, i) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain as never);
      source.start(at);
      at += buffer.duration + SEQUENCE_GAP_MS / 1000;
      if (i === buffers.length - 1) {
        source.onended = () => {
          if (this.playing?.sources !== sources) return;
          this.disconnect();
          handlers.onEnd();
        };
      }
      return source;
    });
    this.playing = { sources, gain };
    handlers.onStart();
  }

  private disconnect(): void {
    const playing = this.playing;
    this.playing = null;
    if (!playing) return;
    for (const s of playing.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
      s.disconnect();
    }
    playing.gain.disconnect();
  }

  stop(): void {
    this.generation++;
    this.disconnect();
  }

  reset(): void {
    this.stop();
    const ctx = this.context;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
      void ctx.resume().catch(() => undefined);
    }
  }
}
