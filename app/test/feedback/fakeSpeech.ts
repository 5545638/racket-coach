import type { SpeechItem } from '../../src/feedback/speech';

/** Stand-in for SpeechSynthesisUtterance (Node has none); install with vi.stubGlobal. */
export class FakeUtterance {
  lang = '';
  voice: FakeVoice | null = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}

export interface FakeVoice {
  readonly voiceURI: string;
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
  readonly default: boolean;
}

export const voice = (lang: string, name = lang, isDefault = false): FakeVoice => ({
  voiceURI: `uri:${name}`,
  name,
  lang,
  localService: true,
  default: isDefault,
});

/**
 * Fake speechSynthesis with WebKit's behaviour: one utterance audible at a
 * time, its own FIFO queue, `onerror` for cancelled utterances, and
 * switchable quirks (never firing onstart / onend, paused engine).
 */
export class FakeSynth {
  voices: FakeVoice[] = [];
  paused = false;
  /** Quirk: speak() never fires onstart (and never ends). */
  stuckStart = false;
  /** Quirk: started utterances never fire onend. */
  noEnd = false;
  /** Fire onstart synchronously in speak() (else call `start()`). */
  autoStart = true;
  audible: FakeUtterance | null = null;
  readonly engineQueue: FakeUtterance[] = [];
  /** Texts in the order they became audible. */
  readonly heard: string[] = [];
  /** Every speak() call's text. */
  readonly spokenCalls: string[] = [];
  /** speak() calls made while another utterance was still audible (overlap attempts). */
  speakWhileAudible = 0;
  cancels = 0;
  resumes = 0;
  /** Texts cut by cancel() while audible. */
  readonly cut: string[] = [];
  private readonly listeners: (() => void)[] = [];

  get speaking(): boolean {
    return this.audible !== null;
  }
  get pending(): boolean {
    return this.engineQueue.length > 0;
  }

  getVoices(): FakeVoice[] {
    return this.voices;
  }

  addEventListener(_type: 'voiceschanged', listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Replaces the voice list and fires voiceschanged. */
  setVoices(voices: FakeVoice[]): void {
    this.voices = voices;
    for (const l of this.listeners) l();
  }

  /** Every utterance handed to speak(). */
  readonly utterances: FakeUtterance[] = [];

  speak(u: FakeUtterance): void {
    this.spokenCalls.push(u.text);
    this.utterances.push(u);
    if (u.text.trim() === '') return; // the prime utterance: silent, no events
    if (this.audible) {
      this.speakWhileAudible++;
      this.engineQueue.push(u);
      return;
    }
    this.begin(u);
  }

  private begin(u: FakeUtterance): void {
    this.audible = u;
    if (this.stuckStart) return;
    this.heard.push(u.text);
    if (this.autoStart) u.onstart?.();
  }

  /** Fires onstart of the audible utterance (with autoStart off). */
  start(): void {
    this.audible?.onstart?.();
  }

  /** The audible utterance ends normally. */
  finish(): void {
    const u = this.audible;
    if (!u) throw new Error('nothing audible');
    this.audible = null;
    if (!this.noEnd) u.onend?.();
    const next = this.engineQueue.shift();
    if (next) this.begin(next);
  }

  cancel(): void {
    this.cancels++;
    const u = this.audible;
    this.audible = null;
    const dropped = [...this.engineQueue];
    this.engineQueue.length = 0;
    if (u) {
      this.cut.push(u.text);
      u.onerror?.({ error: 'interrupted' });
    }
    for (const d of dropped) d.onerror?.({ error: 'canceled' });
  }

  resume(): void {
    this.resumes++;
    this.paused = false;
  }
}

/** Manual clock and timers. */
export class FakeClock {
  t = 0;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  readonly now = (): number => this.t;
  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  /** Moves time forward, running due timers in time order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      this.t = due.at;
      due.fn();
    }
    this.t = end;
    this.timers = this.timers.filter((x) => x.live);
  }
}

/** Records the start/drop callbacks of items. */
export class Events {
  readonly log: string[] = [];
  readonly latencies: number[] = [];
  item(
    text: string,
    category: SpeechItem['category'],
    createdAt?: number,
    lang: SpeechItem['lang'] = 'en',
  ): SpeechItem {
    return {
      text,
      lang,
      category,
      voice: {
        engine: 'natural',
        profile: 'female',
        etSpeaker: 'mari',
        lang: 'en',
        rate: 1,
        pitch: 1,
        volume: 1,
      },
      ...(createdAt === undefined ? {} : { createdAt }),
      onStart: (latency) => {
        this.log.push(`start ${text}`);
        this.latencies.push(latency);
      },
      onDrop: (reason) => {
        this.log.push(`drop ${text} ${reason}`);
      },
    };
  }
}
