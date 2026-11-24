import type { SpokenLanguage } from '../domain/types';
import type { EngineHandlers, SpeechEngine, SpeechItem, VoiceInfo } from './speech';
import { pickVoice } from './speech';

/** BCP 47 tag used when no voice of the language is known. */
const DEFAULT_TAG: Readonly<Record<SpokenLanguage, string>> = { en: 'en-GB', et: 'et-EE' };

/**
 * The device voice (Web Speech API). On iOS, Safari and WKWebView browsers
 * (Bluefy) only expose the pre-installed compact voices to web pages, not the
 * downloaded Enhanced / Premium ones (WebKit bug 290497), which is why the
 * natural voice is pre-recorded (clipEngine.ts) and this engine is the
 * fallback. The engine's own queue is never used: SpeechQueue hands over one
 * utterance at a time.
 */
export class WebSpeechEngine implements SpeechEngine {
  readonly name = 'synth' as const;
  private voiceList: SpeechSynthesisVoice[] = [];
  /** Voice per "lang|voiceURI", cleared when the voice list changes. */
  private readonly voiceCache = new Map<string, SpeechSynthesisVoice | null>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly synth: SpeechSynthesis) {
    this.loadVoices();
    synth.addEventListener('voiceschanged', () => {
      this.loadVoices();
      for (const listener of this.listeners) listener();
    });
  }

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

  /** Unlocks speech (call from a user gesture); `busy`: something is speaking already. */
  prime(busy: boolean): void {
    if (this.synth.paused) this.synth.resume();
    this.loadVoices();
    if (busy) return; // something is speaking: the engine is unlocked already
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    this.synth.speak(silent);
  }

  speak(item: SpeechItem, handlers: EngineHandlers): void {
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
    utterance.onstart = () => {
      handlers.onStart();
    };
    utterance.onend = () => {
      handlers.onEnd();
    };
    utterance.onerror = () => {
      handlers.onError();
    };
    this.synth.speak(utterance);
  }

  stop(): void {
    this.synth.cancel();
  }

  reset(): void {
    this.synth.cancel();
    this.synth.resume();
  }
}
