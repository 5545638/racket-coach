import type { ClipManifest, ClipSource } from './clipEngine';
import { parseManifest } from './clipEngine';
import { clipKey } from './phraseCatalog';

/**
 * Optional natural Estonian voice: a one-time download of every Estonian
 * phrase (phraseCatalog.spokenPhrases('et'), ~100 clips) from the public
 * TartuNLP text-to-speech API, kept in Cache Storage and then played offline
 * by the ClipEngine. Started only by the user from the speech settings —
 * never from the real-time cue loop. Any failure (offline, CORS, the service
 * down) leaves the English clips and the device voice as they are.
 */

export const TARTUNLP_TTS_URL = 'https://api.tartunlp.ai/text-to-speech/v2';

/** Speaker used until the user picks another one. */
export const DEFAULT_ET_SPEAKER = 'mari';

/** Speakers offered when the service does not list its own. */
export const FALLBACK_ET_SPEAKERS: readonly string[] = ['mari', 'tambet', 'liivika', 'kalev'];

/** Name of the Cache Storage cache holding downloaded voices. */
export const VOICE_CACHE_NAME = 'racket-coach-voice-v1';

/** Voice id of a downloaded Estonian speaker (see clipEngine.clipVoiceId). */
export const etVoiceId = (speaker: string): string => `et-${speaker}`;

/** The part of the Cache API this module uses (tests pass an in-memory one). */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
}

/**
 * Downloaded voices in a cache, as a ClipSource: `<base>voice-cache/<voiceId>/`
 * holds `manifest.json` and one WAV file per phrase.
 */
export class DownloadedVoiceStore implements ClipSource {
  constructor(
    private readonly openCache: () => Promise<CacheLike>,
    private readonly baseUrl: string,
  ) {}

  private url(voiceId: string, file: string): string {
    return `${this.baseUrl.replace(/\/?$/, '/')}voice-cache/${voiceId}/${file}`;
  }

  async manifest(voiceId: string): Promise<ClipManifest | null> {
    const cache = await this.openCache();
    const response = await cache.match(this.url(voiceId, 'manifest.json'));
    return response ? parseManifest(await response.json()) : null;
  }

  async clip(voiceId: string, file: string): Promise<ArrayBuffer> {
    const cache = await this.openCache();
    const response = await cache.match(this.url(voiceId, file));
    if (!response) throw new Error(`clip ${voiceId}/${file} not downloaded`);
    return response.arrayBuffer();
  }

  async saveClip(voiceId: string, file: string, wav: ArrayBuffer): Promise<void> {
    const cache = await this.openCache();
    await cache.put(
      this.url(voiceId, file),
      new Response(wav, { headers: { 'Content-Type': 'audio/wav' } }),
    );
  }

  async saveManifest(voiceId: string, manifest: ClipManifest): Promise<void> {
    const cache = await this.openCache();
    await cache.put(
      this.url(voiceId, 'manifest.json'),
      new Response(JSON.stringify({ version: 1, ...manifest }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
}

/** File name of a phrase's clip in the cache. */
export const etClipFile = (key: string): string => `${encodeURIComponent(key)}.wav`;

/** Text sent to the TTS: the phrase with a final full stop (calmer prosody). */
export const etSynthesisText = (text: string): string => {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * Speaker names from the API's GET response, whatever its exact shape:
 * a list of names, or objects with `name` / `speaker` / `id`, at the top
 * level or under `speakers` / `voices`. Empty when nothing matches.
 */
export function parseSpeakers(data: unknown): string[] {
  const record = (o: unknown): Record<string, unknown> | null =>
    typeof o === 'object' && o !== null && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null;
  const list: unknown = Array.isArray(data)
    ? data
    : (record(data)?.['speakers'] ?? record(data)?.['voices']);
  if (!Array.isArray(list)) return [];
  const names = list.map((s: unknown) => {
    if (typeof s === 'string') return s;
    const r = record(s);
    const v = r?.['name'] ?? r?.['speaker'] ?? r?.['id'];
    return typeof v === 'string' ? v : null;
  });
  return [
    ...new Set(names.filter((n): n is string => n !== null && n.trim() !== '').map(normaliseName)),
  ];
}

const normaliseName = (name: string): string => name.trim().toLowerCase();

/** The service's speakers, else the fallback list. Never rejects. */
export async function fetchEtSpeakers(fetchFn: typeof fetch): Promise<readonly string[]> {
  try {
    const response = await fetchFn(TARTUNLP_TTS_URL, { method: 'GET' });
    if (!response.ok) return FALLBACK_ET_SPEAKERS;
    const names = parseSpeakers(await response.json());
    return names.length > 0 ? names : FALLBACK_ET_SPEAKERS;
  } catch {
    return FALLBACK_ET_SPEAKERS;
  }
}

/** Length of a PCM WAV file, ms, or null when the bytes are not one. */
export function wavDurationMs(bytes: ArrayBuffer): number | null {
  const view = new DataView(bytes);
  const tag = (at: number): string =>
    at + 4 <= bytes.byteLength ? String.fromCharCode(...new Uint8Array(bytes, at, 4)) : '';
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 16 <= bytes.byteLength) byteRate = view.getUint32(at + 16, true);
    if (id === 'data') {
      if (byteRate <= 0) return null;
      // Streaming encoders may write 0 or 0xFFFFFFFF: use what is there.
      const available = bytes.byteLength - at - 8;
      const dataBytes = size === 0 || size > available ? available : size;
      return Math.round((1000 * dataBytes) / byteRate);
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

export type DownloadFailure = 'network' | 'http' | 'format' | 'storage';

export type DownloadResult =
  | {
      readonly ok: true;
      readonly clips: number;
      readonly downloaded: number;
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: DownloadFailure;
      /** HTTP status for 'http'. */
      readonly status?: number;
      /** Clips stored before the failure (kept; a new attempt fetches only the rest). */
      readonly clips: number;
    };

export interface DownloadOptions {
  readonly fetch: typeof fetch;
  readonly store: DownloadedVoiceStore;
  readonly speaker: string;
  /** Phrases to voice (spoken text as the app says it). */
  readonly phrases: readonly string[];
  readonly onProgress?: (done: number, total: number) => void;
  /** Requests at the same time. */
  readonly parallel?: number;
}

class DownloadError extends Error {
  constructor(
    readonly reason: DownloadFailure,
    readonly status?: number,
  ) {
    super(reason);
  }
}

/**
 * Downloads the phrases the cache does not hold yet for `speaker` and adds
 * them to its manifest (saved after every clip, so an interrupted download
 * keeps what it got). Never rejects.
 */
export async function downloadEstonianVoice(options: DownloadOptions): Promise<DownloadResult> {
  const { store, speaker } = options;
  const voiceId = etVoiceId(speaker);
  const clips: Record<string, { file: string; durationMs: number }> = {};
  try {
    Object.assign(clips, (await store.manifest(voiceId))?.clips ?? {});
  } catch {
    // no cache yet / unreadable: start from nothing
  }
  const keys = [...new Set(options.phrases.map(clipKey).filter((k) => k !== ''))];
  const todo = keys.filter((k) => !(k in clips));
  const total = keys.length;
  let done = total - todo.length;
  let downloaded = 0;
  let bytes = 0;
  options.onProgress?.(done, total);

  const fetchOne = async (key: string): Promise<void> => {
    let response: Response;
    try {
      response = await options.fetch(TARTUNLP_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
        body: JSON.stringify({ text: etSynthesisText(key), speaker, speed: 1 }),
      });
    } catch {
      throw new DownloadError('network'); // offline, DNS or CORS refused
    }
    if (!response.ok) throw new DownloadError('http', response.status);
    let wav: ArrayBuffer;
    try {
      wav = await response.arrayBuffer();
    } catch {
      throw new DownloadError('network');
    }
    const durationMs = wavDurationMs(wav);
    if (durationMs === null || durationMs <= 0) throw new DownloadError('format');
    const file = etClipFile(key);
    try {
      await store.saveClip(voiceId, file, wav);
      clips[key] = { file, durationMs };
      await store.saveManifest(voiceId, { clips });
    } catch {
      throw new DownloadError('storage');
    }
    downloaded++;
    bytes += wav.byteLength;
    options.onProgress?.(++done, total);
  };

  let next = 0;
  // The first failure stops every worker.
  const run: { failure: DownloadError | null } = { failure: null };
  const worker = async (): Promise<void> => {
    while (run.failure === null && next < todo.length) {
      const key = todo[next++];
      if (key === undefined) return;
      try {
        await fetchOne(key);
      } catch (error) {
        run.failure ??= error instanceof DownloadError ? error : new DownloadError('network');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.parallel ?? 3) }, worker));

  const stored = keys.filter((k) => k in clips).length;
  const f = run.failure;
  if (f !== null) {
    return f.status === undefined
      ? { ok: false, reason: f.reason, clips: stored }
      : { ok: false, reason: f.reason, status: f.status, clips: stored };
  }
  return { ok: true, clips: stored, downloaded, bytes };
}

/** How many of `phrases` the cache holds for `speaker` (0 when nothing or unreadable). */
export async function downloadedCount(
  store: DownloadedVoiceStore,
  speaker: string,
  phrases: readonly string[],
): Promise<number> {
  try {
    const manifest = await store.manifest(etVoiceId(speaker));
    if (!manifest) return 0;
    return [...new Set(phrases.map(clipKey))].filter((k) => k in manifest.clips).length;
  } catch {
    return 0;
  }
}
