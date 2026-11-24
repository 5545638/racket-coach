import type {
  AudioBufferLike,
  AudioContextLike,
  AudioSourceLike,
  ClipManifest,
  ClipSource,
  GainLike,
} from '../../src/feedback/clipEngine';
import type { CacheLike } from '../../src/feedback/estonianVoice';

/** Decoded clip: remembers its bytes' first byte (the fake "file" tag). */
export class FakeBuffer implements AudioBufferLike {
  constructor(
    readonly duration: number,
    readonly tag = '',
  ) {}
}

export class FakeSource implements AudioSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connected = false;
  constructor(private readonly ctx: FakeAudioContext) {}
  connect(): unknown {
    this.connected = true;
    return undefined;
  }
  disconnect(): void {
    this.connected = false;
  }
  start(when = 0): void {
    this.startedAt = when;
    this.ctx.started.push(this);
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Web Audio fires `ended` after stop() too.
    this.onended?.();
  }
  /** The buffer played to its end. */
  end(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onended?.();
  }
}

/**
 * Fake AudioContext: starts 'suspended' (as on iOS), `resume()` runs only
 * when `allowResume` (a user gesture) and resolves on the next microtask.
 */
export class FakeAudioContext implements AudioContextLike {
  state = 'suspended';
  currentTime = 0;
  readonly destination = {};
  onstatechange: (() => void) | null = null;
  /** resume() succeeds (false: the context stays suspended, as outside a gesture). */
  allowResume = true;
  resumes = 0;
  decoded = 0;
  readonly started: FakeSource[] = [];
  readonly gains: { gain: { value: number } }[] = [];
  /** Clip length per decoded byte length (s per byte); the fake "files" set their own length. */
  durationOf: (bytes: ArrayBuffer) => number = (bytes) => bytes.byteLength / 1000;

  resume(): Promise<void> {
    this.resumes++;
    if (this.allowResume && this.state !== 'closed') this.setState('running');
    return Promise.resolve();
  }
  setState(state: string): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.();
  }
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    this.decoded++;
    const tag = new TextDecoder().decode(data);
    return Promise.resolve(new FakeBuffer(this.durationOf(data), tag));
  }
  createBufferSource(): FakeSource {
    return new FakeSource(this);
  }
  createGain(): GainLike {
    const g = {
      gain: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
    };
    this.gains.push(g);
    return g;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
    return new FakeBuffer(length / sampleRate, 'silent');
  }
  /** Texts (fake file contents) of the sources started, in order, without the unlock buffer. */
  playedTags(): string[] {
    return this.started
      .map((s) => (s.buffer instanceof FakeBuffer ? s.buffer.tag : ''))
      .filter((t) => t !== 'silent');
  }
  /** The last started (non-silent) source. */
  last(): FakeSource {
    const s = this.started.filter((x) => (x.buffer as FakeBuffer | null)?.tag !== 'silent').at(-1);
    if (!s) throw new Error('nothing started');
    return s;
  }
}

/**
 * In-memory clip source: each clip's bytes are its key's text (so the fake
 * context's buffers carry it as `tag`), its length 1 ms per character.
 */
export class FakeClipSource implements ClipSource {
  manifestCalls = 0;
  clipCalls = 0;
  failClips = false;
  constructor(readonly voices: Record<string, readonly string[]>) {}
  manifest(voiceId: string): Promise<ClipManifest | null> {
    this.manifestCalls++;
    const keys = this.voices[voiceId];
    if (!keys) return Promise.resolve(null);
    const clips: Record<string, { file: string; durationMs: number }> = {};
    for (const k of keys) clips[k] = { file: `${encodeURIComponent(k)}.m4a`, durationMs: k.length };
    return Promise.resolve({ clips });
  }
  clip(_voiceId: string, file: string): Promise<ArrayBuffer> {
    this.clipCalls++;
    if (this.failClips) return Promise.reject(new Error('offline'));
    const text = decodeURIComponent(file.replace(/\.m4a$/, ''));
    return Promise.resolve(new TextEncoder().encode(text).buffer);
  }
}

/** Cache API stand-in (bodies stored as bytes). */
export class FakeCache implements CacheLike {
  readonly entries = new Map<string, { body: ArrayBuffer; type: string }>();
  failPut = false;
  async match(request: string): Promise<Response | undefined> {
    const e = this.entries.get(request);
    return Promise.resolve(
      e ? new Response(e.body.slice(0), { headers: { 'Content-Type': e.type } }) : undefined,
    );
  }
  async put(request: string, response: Response): Promise<void> {
    if (this.failPut) throw new Error('QuotaExceededError');
    this.entries.set(request, {
      body: await response.arrayBuffer(),
      type: response.headers.get('Content-Type') ?? '',
    });
  }
  delete(request: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(request));
  }
}

/** A PCM WAV file of `ms` milliseconds (16-bit mono, 22.05 kHz). */
export function wav(ms: number, sampleRate = 22_050): ArrayBuffer {
  const samples = Math.round((ms / 1000) * sampleRate);
  const buf = new ArrayBuffer(44 + 2 * samples);
  const v = new DataView(buf);
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + 2 * samples, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, 2 * samples, true);
  return buf;
}

/** Lets pending promise callbacks run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
