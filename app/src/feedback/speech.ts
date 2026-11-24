import type { SpokenLanguage, VoiceSettings } from '../domain/types';
import { WebSpeechEngine } from './webSpeechEngine';

/**
 * Spoken feedback (docs/architecture.md, "Speech"). The controller decides
 * *what* to say; this module decides *when*: one utterance at a time, by
 * priority, never a stale cue, and robust against WebKit's Web Speech quirks
 * (iPhone Safari / Bluefy). *How* it sounds is up to an engine: pre-recorded
 * natural voice clips (clipEngine.ts) when the text has one, else the device
 * voice (webSpeechEngine.ts).
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
  /** Which engine voices it (called when it is handed to an engine, also on a retry). */
  readonly onEngine?: (use: EngineUse) => void;
}

/**
 * How an utterance is voiced: a natural voice clip; the device voice because
 * the settings ask for it; or the device voice because no clip exists for the
 * text in the active voice (`synth-fallback`, listed in the diagnostics).
 */
export type EngineUse = 'clip' | 'synth' | 'synth-fallback';

/** Events of one utterance an engine speaks; the queue ignores those of utterances it gave up on. */
export interface EngineHandlers {
  onStart(): void;
  onEnd(): void;
  onError(): void;
}

/** Voices one utterance at a time; SpeechQueue decides what and when. */
export interface SpeechEngine {
  readonly name: 'synth' | 'clip';
  /** Starts `item`; reports through `handlers`. Never called while another utterance of the engine is active. */
  speak(item: SpeechItem, handlers: EngineHandlers): void;
  /** Stops the active utterance (interruption, cancel). */
  stop(): void;
  /** Watchdog: the engine never started or ended an utterance; stop and unstick it. */
  reset(): void;
  /** Unlocks audio from a user gesture; `busy`: something is being spoken. */
  prime(busy: boolean): void;
}

/** Natural voice clips: an engine that only takes items it has a clip for. */
export interface ClipPlayer extends SpeechEngine {
  readonly name: 'clip';
  /** Length of the clip(s) for `item` in its voice, ms, or null when there is no clip (yet). */
  clipDurationMs(item: SpeechItem): number | null;
  /** Loads the clip list of the voice and decodes all its clips (session start, connect). */
  prepare(voice: VoiceSettings, lang: SpokenLanguage): Promise<void>;
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
  /**
   * Gets the natural voice of `voice` for `lang` ready (clip list loaded, all
   * clips decoded) so the first cue does not wait. Optional; never rejects.
   */
  prepare?(voice: VoiceSettings, lang: SpokenLanguage): Promise<void>;
}

/** Voices whose language is `lang` ("et" matches "et-EE", "et_EE", "ET"). */
export const voicesFor = <V extends { readonly lang: string }>(
  voices: readonly V[],
  lang: SpokenLanguage,
): V[] => voices.filter((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === lang);

/** The device has at least one voice for `lang`. */
export const hasVoiceFor = (voices: readonly VoiceInfo[], lang: SpokenLanguage): boolean =>
  voicesFor(voices, lang).length > 0;

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
  /** Natural voice clips; without, every item uses the device voice. */
  readonly clips?: ClipPlayer;
}

export const DEFAULT_MAX_AGE_MS = 2500;

interface Queued {
  readonly item: SpeechItem;
  readonly createdAt: number;
}

interface Active extends Queued {
  readonly engine: SpeechEngine;
  /** Null until `onstart`. */
  startedAt: number | null;
  /** Times this item was handed to an engine (one retry after a stuck start). */
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
  /** Utterances handed to an engine, by how they were voiced. */
  engine: Record<EngineUse, number>;
}

/**
 * Speaker with a priority queue in front of the speech engines. Rules:
 * - one utterance at a time; nothing overlaps (an engine's own queue is
 *   never used: an utterance is handed over only when the previous ended);
 * - at most one queued utterance per category; a newer one takes the slot;
 * - a new stroke utterance replaces every queued older stroke utterance;
 * - an utterance older than `maxAgeMs` when it would start is dropped;
 * - a speaking utterance is cut only after `minSpeakMs`, only by a newer
 *   stroke's utterance or a system message, and a system message only by
 *   another system message;
 * - the next utterance is the highest-priority queued one;
 * - engine per utterance: the natural voice clip when `voice.engine` is
 *   'natural' and a clip exists for the exact text, else the device voice
 *   (counted as `synth-fallback` when a clip was wanted);
 * - watchdogs: no `onstart` within `startTimeoutMs` → engine reset and one
 *   retry (a clip is retried with the device voice), then dropped as `stuck`;
 *   no `onend` within the longest plausible duration → reset, treated as
 *   ended. A paused Web Speech engine (Safari after interruptions) is resumed
 *   before speaking.
 */
export class SpeechQueue implements Speaker {
  readonly counters: SpeechQueueCounters = {
    started: 0,
    dropped: { replaced: 0, stale: 0, stuck: 0, error: 0, cancelled: 0 },
    recoveries: 0,
    engine: { clip: 0, synth: 0, 'synth-fallback': 0 },
  };
  private current: Active | null = null;
  private queued: Queued[] = [];
  private cancelPreempt: (() => void) | null = null;
  private readonly synth: WebSpeechEngine;
  private readonly clips: ClipPlayer | null;
  private readonly maxAgeMs: number;
  private readonly startTimeoutMs: number;
  private readonly endSlackMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;

  constructor(synth: SpeechSynthesis, options: SpeechQueueOptions = {}) {
    this.synth = new WebSpeechEngine(synth);
    this.clips = options.clips ?? null;
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
  }

  /* --------------------------------------------------------------- voices */

  voices(): readonly VoiceInfo[] {
    return this.synth.voices();
  }

  onVoicesChanged(listener: () => void): () => void {
    return this.synth.onVoicesChanged(listener);
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
      current.engine.stop();
    }
    if (!this.current) {
      this.cancelPreempt?.();
      this.cancelPreempt = null;
    }
    this.pump();
  }

  async prepare(voice: VoiceSettings, lang: SpokenLanguage): Promise<void> {
    if (voice.engine === 'system' || !this.clips) return;
    try {
      await this.clips.prepare(voice, lang);
    } catch (error) {
      // Without clips every cue uses the device voice (counted as synth-fallback).
      console.warn('Natural voice unavailable', error);
    }
  }

  prime(): void {
    const busy = this.current !== null;
    this.synth.prime(busy);
    this.clips?.prime(busy);
  }

  /** Rate the utterance is spoken at: clips keep their recorded pace. */
  private rateOf(active: Active): number {
    return active.engine.name === 'clip' ? 1 : active.item.voice.rate;
  }

  /** Starts, or lets preempt, the next queued utterance when the rules allow. */
  private pump(): void {
    const current = this.current;
    if (current) {
      if (current.startedAt === null) return; // in flight: wait for onstart or the watchdog
      const next = this.peek();
      if (!next || !this.mayPreempt(current, next)) return;
      const left =
        minSpeakMs(current.item.text, this.rateOf(current)) - (this.now() - current.startedAt);
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
      current.engine.stop();
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
      this.speakNow(next, 0, false);
      return;
    }
  }

  /** The engine for `item`, how it is voiced, and the clip length (null for the device voice). */
  private engineFor(
    item: SpeechItem,
    noClip: boolean,
  ): { engine: SpeechEngine; use: EngineUse; clipMs: number | null } {
    if (item.voice.engine === 'system') return { engine: this.synth, use: 'synth', clipMs: null };
    const clipMs = noClip || !this.clips ? null : this.clips.clipDurationMs(item);
    return this.clips && clipMs !== null
      ? { engine: this.clips, use: 'clip', clipMs }
      : { engine: this.synth, use: 'synth-fallback', clipMs: null };
  }

  private speakNow(entry: Queued, attempt: number, noClip: boolean): void {
    const { item } = entry;
    const { engine, use, clipMs } = this.engineFor(item, noClip);
    this.counters.engine[use]++;
    item.onEngine?.(use);
    const active: Active = {
      ...entry,
      engine,
      startedAt: null,
      attempt,
      cancelWatchdog: () => undefined,
    };
    this.current = active;
    const endWatchdogMs =
      clipMs !== null
        ? clipMs + this.endSlackMs
        : maxSpeakMs(item.text, item.voice.rate, this.endSlackMs);
    const handlers: EngineHandlers = {
      onStart: () => {
        if (this.current !== active || active.startedAt !== null) return;
        active.startedAt = this.now();
        active.cancelWatchdog();
        active.cancelWatchdog = this.setTimer(() => {
          this.recover(active);
        }, endWatchdogMs);
        this.counters.started++;
        item.onStart?.(active.startedAt - active.createdAt);
        this.pump(); // a newer utterance may be waiting to cut in
      },
      onEnd: () => {
        if (this.current !== active) return;
        if (active.startedAt === null) {
          // WebKit sometimes skips onstart for very short phrases: it was spoken.
          active.startedAt = this.now();
          this.counters.started++;
          item.onStart?.(active.startedAt - active.createdAt);
        }
        this.release(active);
        this.pump();
      },
      onError: () => {
        if (this.current !== active) return;
        this.release(active);
        if (active.startedAt === null) this.dropped(item, 'error');
        this.pump();
      },
    };
    active.cancelWatchdog = this.setTimer(() => {
      this.recover(active);
    }, this.startTimeoutMs);
    engine.speak(item, handlers);
  }

  /** Watchdog: the engine never started or never ended `active`. */
  private recover(active: Active): void {
    if (this.current !== active) return;
    this.counters.recoveries++;
    this.release(active);
    active.engine.reset();
    if (active.startedAt === null) {
      const fresh = this.now() - active.createdAt <= this.maxAgeMs;
      if (active.attempt === 0 && fresh) {
        // A clip that did not start (audio still locked or decoding) gets the device voice.
        this.speakNow(active, 1, active.engine.name === 'clip');
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
