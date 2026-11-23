/** Anything that can voice a short cue. */
export interface Speaker {
  say(text: string, rate: number): void;
  /**
   * Must be called from a user gesture: iOS only allows speech that a tap
   * started, and cues later arrive from Bluetooth events.
   */
  prime(): void;
}

/**
 * Web Speech API speaker. Always speaks the latest cue only: a stale cue about
 * the previous shot is worse than none.
 */
export class WebSpeechSpeaker implements Speaker {
  private voice: SpeechSynthesisVoice | null = null;

  constructor(private readonly synth: SpeechSynthesis) {
    const pick = (): void => {
      this.voice = synth.getVoices().find((v) => v.lang.startsWith('en')) ?? null;
    };
    pick();
    synth.addEventListener('voiceschanged', pick);
  }

  say(text: string, rate: number): void {
    this.synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-GB';
    utterance.rate = rate;
    if (this.voice) utterance.voice = this.voice;
    this.synth.speak(utterance);
  }

  prime(): void {
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    this.synth.speak(silent);
  }
}

/** Used in tests and when speech is unavailable. */
export class SilentSpeaker implements Speaker {
  readonly spoken: string[] = [];
  say(text: string): void {
    this.spoken.push(text);
  }

  prime(): void {
    // Nothing to unlock.
  }
}
