import type { SpokenLanguage, VoiceSettings } from '../domain/types';

/**
 * Spoken feedback (docs/architecture.md, "Speech"). The controller decides
 * *what* to say; this module decides *when*: one utterance at a time, by
 * priority, never a stale cue, and robust against WebKit's Web Speech quirks
 * (iPhone Safari / Bluefy).
 */

/** Priority classes, highest first: system > correction > feedback > info. */
export type SpeechCategory = 'system' | 'correction' | 'feedback' | 'info';

export const SPEECH_PRIORITY: Readonly<Record<SpeechCategory, number>> = {
  system: 3,
  correction: 2,
  feedback: 1,
  info: 0,
};

/**
 * Why an utterance was never started:
 * - `replaced`: a newer utterance took its queue slot (newer stroke, same category);
 * - `stale`: older than `maxAgeMs` when it would have started;
 * - `stuck`: the engine never fired `onstart` (watchdog);
 * - `error`: `onerror` before `onstart`;
 * - `cancelled`: dropped by `cancel()` (disconnect, mute).
 */
export type DropReason = 'replaced' | 'stale' | 'stuck' | 'error' | 'cancelled';

export interface SpeechItem {
  readonly text: string;
  /** Language of `text` (it picks the voice; may differ from `voice.lang` after a fallback). */
  readonly lang: SpokenLanguage;
  readonly category: SpeechCategory;
  /** Rate, pitch, volume and the chosen voice. */
  readonly voice: VoiceSettings;
  /**
   * When the reason for the utterance happened, ms on the queue's clock: the
   * stroke's `capture.receivedAt` for stroke cues. Default: when enqueued.
   * Age limit and latency are measured from it.
   */
  readonly createdAt?: number;
  /** The utterance started (it is being heard); `latencyMs` = start − `createdAt`. */
  readonly onStart?: (latencyMs: number) => void;
  /** The utterance will never be spoken. */
  readonly onDrop?: (reason: DropReason) => void;
}

/**
 * What `cancel` drops: everything; every stroke utterance (non-system,
 * queued or speaking); or only stroke utterances that have not started.
 */
export type CancelScope = 'all' | 'stroke' | 'queued-stroke';

/** A voice of the device, as listed in the settings. */
export interface VoiceInfo {
  readonly voiceURI: string;
  readonly name: string;
  /** BCP 47 tag, e.g. "et-EE". */
  readonly lang: string;
  readonly localService: boolean;
  readonly isDefault: boolean;
}

/** Anything that can voice short cues. */
export interface Speaker {
  /** Queues an utterance; the speaker decides when (or whether) it is spoken. */
  say(item: SpeechItem): void;
  /**
   * Must be called from a user gesture: iOS only allows speech that a tap
   * started, and cues later arrive from Bluetooth events.
   */
  prime(): void;
  /** Drops utterances (see CancelScope; default 'all'). Optional. */
  cancel?(scope?: CancelScope): void;
  /** Voices of the device (may be empty until the browser has loaded them). */
  voices?(): readonly VoiceInfo[];
  /** Calls `listener` when the voice list changes; returns the unsubscribe function. */
  onVoicesChanged?(listener: () => void): () => void;
}

/** Voices whose language is `lang` ("et" matches "et-EE", "et_EE", "ET"). */
export const voicesFor = <V extends { readonly lang: string }>(
  voices: readonly V[],
  lang: SpokenLanguage,
): V[] => voices.filter((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === lang);

/** The device has at least one voice for `lang`. */
export const hasVoiceFor = (voices: readonly VoiceInfo[], lang: SpokenLanguage): boolean =>
  voicesFor(voices, lang).length > 0;

/** BCP 47 tag used when no voice of the language is known. */
const DEFAULT_TAG: Readonly<Record<SpokenLanguage, string>> = { en: 'en-GB', et: 'et-EE' };

/**
 * The voice to use for `lang`: the chosen one if it speaks `lang`, else the
 * browser default of that language, else British then American English (for
 * English), else the first one. Null when the device has none.
 */
export function pickVoice<V extends { readonly lang: string; readonly voiceURI: string }>(
  voices: readonly V[],
  lang: SpokenLanguage,
  voiceURI?: string,
  isDefault: (v: V) => boolean = () => false,
): V | null {
  const own = voicesFor(voices, lang);
  const tag = (v: V) => v.lang.toLowerCase().replace('_', '-');
  return (
    own.find((v) => voiceURI !== undefined && v.voiceURI === voiceURI) ??
    own.find(isDefault) ??
    (lang === 'en'
      ? (own.find((v) => tag(v) === 'en-gb') ?? own.find((v) => tag(v) === 'en-us'))
      : undefined) ??
    own[0] ??
    null
  );
}

/** Words of a phrase. */
const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * How long an utterance must be allowed to speak before a newer one may cut
 * it: about the time a short cue takes (a 3-word cue finishes), capped so a
 * long learning sentence can still give way to the next stroke's cue.
 */
export function minSpeakMs(text: string, rate: number): number {
  return Math.min(2000, Math.max(500, (words(text) * 350) / Math.max(rate, 0.1)));
}

/** Generous upper bound of an utterance's duration, for the `onend` watchdog. */
export function maxSpeakMs(text: string, rate: number, slackMs: number): number {
  return (2 * (words(text) * 450 + 300)) / Math.max(rate, 0.1) + slackMs;
}

export interface SpeechQueueOptions {
  /** Utterances older than this when they would start are dropped, ms. */
  readonly maxAgeMs?: number;
  /** `onstart` must follow `speak()` within this time, else the engine is reset, ms. */
  readonly startTimeoutMs?: number;
  /** Added to the longest plausible duration before `onend` is given up on, ms. */
  readonly endSlackMs?: number;
  /** Clock of `createdAt` (default Date.now, the clock of `capture.receivedAt`). */
  readonly now?: () => number;
  /** Starts a timer and returns its cancel function. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

export const DEFAULT_MAX_AGE_MS = 2500;

interface Queued {
  readonly item: SpeechItem;
  readonly createdAt: number;
}

interface Active extends Queued {
  readonly utterance: SpeechSynthesisUtterance;
  /** Null until `onstart`. */
  startedAt: number | null;
  /** Times this item was handed to the engine (one retry after a stuck start). */
  attempt: number;
  cancelWatchdog: () => void;
}

const isStroke = (q: Queued): boolean => q.item.category !== 'system';

/** Counters of the queue's lifetime, for diagnostics. */
export interface SpeechQueueCounters {
  started: number;
  dropped: Record<DropReason, number>;
  /** Engine resets by the watchdog (stuck start or missing `onend`). */
  recoveries: number;
}

/**
 * Web Speech speaker with a priority queue. Rules:
 * - one utterance at a time; nothing overlaps (the engine's own queue is
 *   never used: an utterance is handed over only when the previous ended);
 * - at most one queued utterance per category; a newer one takes the slot;
 * - a new stroke utterance replaces every queued older stroke utterance;
 * - an utterance older than `maxAgeMs` when it would start is dropped;
 * - a speaking utterance is cut only after `minSpeakMs`, only by a newer
 *   stroke's utterance or a system message, and a system message only by
 *   another system message;
 * - the next utterance is the highest-priority queued one;
 * - watchdogs: no `onstart` within `startTimeoutMs` → cancel + resume and one
 *   retry, then dropped as `stuck`; no `onend` within `maxSpeakMs` → cancel +
 *   resume, treated as ended. A paused engine (Safari after interruptions) is
 *   resumed before speaking.
 */
export class SpeechQueue implements Speaker {
  readonly counters: SpeechQueueCounters = {
    started: 0,
    dropped: { replaced: 0, stale: 0, stuck: 0, error: 0, cancelled: 0 },
    recoveries: 0,
  };
  private current: Active | null = null;
  private queued: Queued[] = [];
  private cancelPreempt: (() => void) | null = null;
  private voiceList: SpeechSynthesisVoice[] = [];
  /** Voice per "lang|voiceURI", cleared when the voice list changes. */
  private readonly voiceCache = new Map<string, SpeechSynthesisVoice | null>();
  private readonly listeners = new Set<() => void>();
  private readonly maxAgeMs: number;
  private readonly startTimeoutMs: number;
  private readonly endSlackMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly synth: SpeechSynthesis,
    options: SpeechQueueOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? 1500;
    this.endSlackMs = options.endSlackMs ?? 2500;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => {
          clearTimeout(id);
        };
      });
    this.loadVoices();
    synth.addEventListener('voiceschanged', () => {
      this.loadVoices();
      for (const listener of this.listeners) listener();
    });
  }

  /* --------------------------------------------------------------- voices */

  private loadVoices(): void {
    this.voiceList = this.synth.getVoices();
    this.voiceCache.clear();
  }

  voices(): readonly VoiceInfo[] {
    // iOS fills the list lazily and does not always fire voiceschanged.
    if (this.voiceList.length === 0) this.loadVoices();
    return this.voiceList.map((v) => ({
      voiceURI: v.voiceURI,
      name: v.name,
      lang: v.lang,
      localService: v.localService,
      isDefault: v.default,
    }));
  }

  onVoicesChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Cached voice object: looking it up per cue costs time on iOS. */
  private voiceFor(lang: SpokenLanguage, voiceURI?: string): SpeechSynthesisVoice | null {
    const key = `${lang}|${voiceURI ?? ''}`;
    const cached = this.voiceCache.get(key);
    if (cached !== undefined) return cached;
    if (this.voiceList.length === 0) this.loadVoices();
    const voice = pickVoice(this.voiceList, lang, voiceURI, (v) => v.default);
    if (this.voiceList.length > 0) this.voiceCache.set(key, voice);
    return voice;
  }

  /* ---------------------------------------------------------------- queue */

  say(item: SpeechItem): void {
    const entry: Queued = { item, createdAt: item.createdAt ?? this.now() };
    for (const q of [...this.queued]) {
      const sameSlot = q.item.category === item.category;
      const olderStroke = isStroke(entry) && isStroke(q) && q.createdAt <= entry.createdAt;
      if (sameSlot || olderStroke) this.drop(q, 'replaced');
    }
    this.queued.push(entry);
    this.pump();
  }

  cancel(scope: CancelScope = 'all'): void {
    const matches = (q: Queued) => scope === 'all' || isStroke(q);
    for (const q of [...this.queued]) if (matches(q)) this.drop(q, 'cancelled');
    const current = this.current;
    if (current && scope !== 'queued-stroke' && matches(current)) {
      this.release(current);
      if (current.startedAt === null) this.dropped(current.item, 'cancelled');
      this.synth.cancel();
    }
    if (!this.current) {
      this.cancelPreempt?.();
      this.cancelPreempt = null;
    }
    this.pump();
  }

  prime(): void {
    if (this.synth.paused) this.synth.resume();
    this.loadVoices();
    if (this.current) return; // something is speaking: the engine is unlocked already
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    this.synth.speak(silent);
  }

  /** Starts, or lets preempt, the next queued utterance when the rules allow. */
  private pump(): void {
    const current = this.current;
    if (current) {
      if (current.startedAt === null) return; // in flight: wait for onstart or the watchdog
      const next = this.peek();
      if (!next || !this.mayPreempt(current, next)) return;
      const left =
        minSpeakMs(current.item.text, current.item.voice.rate) - (this.now() - current.startedAt);
      if (left > 0) {
        this.cancelPreempt?.();
        this.cancelPreempt = this.setTimer(() => {
          this.cancelPreempt = null;
          this.pump();
        }, left);
        return;
      }
      // Heard long enough: it counts as heard, the newer utterance goes first.
      this.release(current);
      this.synth.cancel();
    }
    this.startNext();
  }

  private mayPreempt(current: Queued, next: Queued): boolean {
    if (current.item.category === 'system') return next.item.category === 'system';
    return next.item.category === 'system' || next.createdAt > current.createdAt;
  }

  /** The highest-priority queued utterance (at most one per category). */
  private peek(): Queued | null {
    let best: Queued | null = null;
    for (const q of this.queued) {
      if (!best || SPEECH_PRIORITY[q.item.category] > SPEECH_PRIORITY[best.item.category]) {
        best = q;
      }
    }
    return best;
  }

  private startNext(): void {
    for (;;) {
      const next = this.peek();
      if (!next) return;
      this.queued = this.queued.filter((q) => q !== next);
      if (this.now() - next.createdAt > this.maxAgeMs) {
        this.dropped(next.item, 'stale');
        continue;
      }
      this.speakNow(next, 0);
      return;
    }
  }

  private speakNow(entry: Queued, attempt: number): void {
    const { item } = entry;
    // Safari: a paused engine swallows speak(); leftovers mean it is stuck.
    if (this.synth.paused) this.synth.resume();
    if (this.synth.speaking || this.synth.pending) this.synth.cancel();
    const utterance = new SpeechSynthesisUtterance(item.text);
    const voice = this.voiceFor(
      item.lang,
      item.voice.lang === item.lang ? item.voice.voiceURI : undefined,
    );
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? DEFAULT_TAG[item.lang];
    utterance.rate = item.voice.rate;
    utterance.pitch = item.voice.pitch;
    utterance.volume = item.voice.volume;
    const active: Active = {
      ...entry,
      utterance,
      startedAt: null,
      attempt,
      cancelWatchdog: () => undefined,
    };
    this.current = active;
    utterance.onstart = () => {
      if (this.current !== active || active.startedAt !== null) return;
      active.startedAt = this.now();
      active.cancelWatchdog();
      active.cancelWatchdog = this.setTimer(
        () => {
          this.recover(active);
        },
        maxSpeakMs(item.text, item.voice.rate, this.endSlackMs),
      );
      this.counters.started++;
      item.onStart?.(active.startedAt - active.createdAt);
      this.pump(); // a newer utterance may be waiting to cut in
    };
    utterance.onend = () => {
      if (this.current !== active) return;
      if (active.startedAt === null) {
        // WebKit sometimes skips onstart for very short phrases: it was spoken.
        active.startedAt = this.now();
        this.counters.started++;
        item.onStart?.(active.startedAt - active.createdAt);
      }
      this.release(active);
      this.pump();
    };
    utterance.onerror = () => {
      if (this.current !== active) return;
      this.release(active);
      if (active.startedAt === null) this.dropped(item, 'error');
      this.pump();
    };
    active.cancelWatchdog = this.setTimer(() => {
      this.recover(active);
    }, this.startTimeoutMs);
    this.synth.speak(utterance);
  }

  /** Watchdog: the engine never started or never ended `active`. */
  private recover(active: Active): void {
    if (this.current !== active) return;
    this.counters.recoveries++;
    this.release(active);
    this.synth.cancel();
    this.synth.resume();
    if (active.startedAt === null) {
      const fresh = this.now() - active.createdAt <= this.maxAgeMs;
      if (active.attempt === 0 && fresh) {
        this.speakNow(active, 1);
        return;
      }
      this.dropped(active.item, 'stuck');
    }
    this.pump();
  }

  /** Forgets the current utterance (its late events are ignored). */
  private release(active: Active): void {
    active.cancelWatchdog();
    if (this.current === active) this.current = null;
  }

  private drop(q: Queued, reason: DropReason): void {
    this.queued = this.queued.filter((x) => x !== q);
    this.dropped(q.item, reason);
  }

  private dropped(item: SpeechItem, reason: DropReason): void {
    this.counters.dropped[reason]++;
    item.onDrop?.(reason);
  }
}

/** Used in tests and when speech is unavailable: "speaks" at once. */
export class SilentSpeaker implements Speaker {
  readonly spoken: string[] = [];
  readonly items: SpeechItem[] = [];
  /** How often speech was cancelled ('all' or 'stroke'). */
  cancelled = 0;

  constructor(private readonly voiceList: readonly VoiceInfo[] = []) {}

  say(item: SpeechItem): void {
    this.spoken.push(item.text);
    this.items.push(item);
    item.onStart?.(0);
  }

  cancel(scope: CancelScope = 'all'): void {
    if (scope !== 'queued-stroke') this.cancelled++;
  }

  prime(): void {
    // Nothing to unlock.
  }

  voices(): readonly VoiceInfo[] {
    return this.voiceList;
  }
}
