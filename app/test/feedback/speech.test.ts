import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SpeechQueue,
  type SpeechQueueOptions,
  hasVoiceFor,
  minSpeakMs,
  pickVoice,
  voicesFor,
} from '../../src/feedback/speech';
import { Events, FakeClock, FakeSynth, FakeUtterance, voice } from './fakeSpeech';

beforeEach(() => {
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(options: SpeechQueueOptions = {}) {
  const synth = new FakeSynth();
  const clock = new FakeClock();
  const queue = new SpeechQueue(synth as unknown as SpeechSynthesis, {
    now: clock.now,
    setTimer: clock.setTimer,
    ...options,
  });
  return { synth, clock, queue, ev: new Events() };
}

const CUE = 'Face too open'; // 3 words: minimum 1050 ms at rate 1

describe('SpeechQueue: no overlap', () => {
  it('hands the engine one utterance at a time, the next only after onend', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item(CUE, 'correction', 0));
    clock.advance(100);
    queue.say(ev.item('Better', 'feedback', 100));
    expect(synth.heard).toEqual([CUE]);
    clock.advance(400);
    synth.finish();
    expect(synth.heard).toEqual([CUE, 'Better']);
    expect(synth.speakWhileAudible).toBe(0);
    expect(synth.cut).toEqual([]);
    expect(ev.log).toEqual([`start ${CUE}`, 'start Better']);
  });

  it('lets a short cue finish: a newer stroke cue waits for the minimum, then cuts in', () => {
    const { synth, clock, queue, ev } = setup();
    expect(minSpeakMs(CUE, 1)).toBe(1050);
    queue.say(ev.item(CUE, 'correction', 0));
    clock.advance(300);
    queue.say(ev.item('Turn more', 'correction', 300));
    clock.advance(749);
    expect(synth.heard).toEqual([CUE]);
    expect(synth.cut).toEqual([]);
    clock.advance(1);
    expect(synth.cut).toEqual([CUE]);
    expect(synth.heard).toEqual([CUE, 'Turn more']);
    // The cut cue had started: it was heard, not dropped, despite its late onerror.
    expect(ev.log).toEqual([`start ${CUE}`, 'start Turn more']);
    expect(synth.speakWhileAudible).toBe(0);
  });

  it('a new stroke utterance replaces a queued (not started) older stroke utterance', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item('Sensor connected', 'system', 0));
    clock.advance(100);
    queue.say(ev.item(CUE, 'correction', 100));
    clock.advance(100);
    queue.say(ev.item('Better', 'feedback', 200));
    expect(ev.log).toContain(`drop ${CUE} replaced`);
    clock.advance(600);
    synth.finish();
    expect(synth.heard).toEqual(['Sensor connected', 'Better']);
    expect(queue.counters.dropped.replaced).toBe(1);
  });

  it('keeps at most one queued item per category', () => {
    const { synth, queue, ev } = setup();
    queue.say(ev.item('Sensor disconnected', 'system'));
    queue.say(ev.item('Sensor connected', 'system'));
    queue.say(ev.item('Sensor lost', 'system'));
    expect(ev.log).toContain('drop Sensor connected replaced');
    synth.finish();
    expect(synth.heard).toEqual(['Sensor disconnected', 'Sensor lost']);
  });

  it('drops an utterance older than maxAgeMs when it would start', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item('Sensor disconnected', 'system', 0));
    queue.say(ev.item(CUE, 'correction', 0));
    clock.advance(2600);
    synth.finish();
    expect(ev.log).toEqual(['start Sensor disconnected', `drop ${CUE} stale`]);
    expect(synth.heard).toEqual(['Sensor disconnected']);
    expect(queue.counters.dropped.stale).toBe(1);
  });

  it('measures latency from createdAt (stroke receivedAt) to onstart', () => {
    const { synth, clock, queue, ev } = setup();
    synth.autoStart = false;
    clock.advance(200);
    queue.say(ev.item(CUE, 'correction', 0));
    clock.advance(150);
    synth.start();
    expect(ev.latencies).toEqual([350]);
  });
});

describe('SpeechQueue: priorities', () => {
  it('starts the highest-priority queued item next: system before stroke cues', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item('Sensor disconnected', 'system', 0));
    clock.advance(100);
    queue.say(ev.item(CUE, 'correction', 100));
    clock.advance(100);
    queue.say(ev.item('Sensor connected', 'system', 200));
    // A system message may cut a system message after its minimum.
    clock.advance(500);
    expect(synth.heard).toEqual(['Sensor disconnected', 'Sensor connected']);
    synth.finish();
    expect(synth.heard).toEqual(['Sensor disconnected', 'Sensor connected', CUE]);
  });

  it('never interrupts a system message for a stroke cue', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item('Sensor disconnected', 'system', 0));
    clock.advance(100);
    queue.say(ev.item(CUE, 'correction', 100));
    clock.advance(3000);
    expect(synth.cut).toEqual([]);
    expect(synth.heard).toEqual(['Sensor disconnected']);
  });

  it('a system message cuts a stroke cue only after the cue’s minimum', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item(CUE, 'correction', 0));
    clock.advance(100);
    queue.say(ev.item('Sensor disconnected', 'system', 100));
    clock.advance(900);
    expect(synth.cut).toEqual([]);
    clock.advance(50);
    expect(synth.cut).toEqual([CUE]);
    expect(synth.heard).toEqual([CUE, 'Sensor disconnected']);
  });

  it('cancel("stroke") drops stroke speech but keeps system messages', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item(CUE, 'correction', 0));
    clock.advance(100);
    queue.say(ev.item('Sensor connected', 'system', 100));
    queue.cancel('stroke');
    expect(synth.cut).toEqual([CUE]);
    expect(synth.heard).toEqual([CUE, 'Sensor connected']);
    queue.say(ev.item('Better', 'feedback', 150));
    queue.cancel('queued-stroke');
    expect(ev.log).toContain('drop Better cancelled');
    expect(synth.audible?.text).toBe('Sensor connected');
  });
});

describe('SpeechQueue: WebKit recovery', () => {
  it('resets a stuck engine (no onstart): cancel + resume, one retry, then drops as stuck', () => {
    const { synth, clock, queue, ev } = setup();
    synth.stuckStart = true;
    queue.say(ev.item(CUE, 'correction', 0));
    clock.advance(1500);
    expect(queue.counters.recoveries).toBe(1);
    expect(synth.cancels).toBeGreaterThanOrEqual(1);
    expect(synth.resumes).toBeGreaterThanOrEqual(1);
    expect(synth.spokenCalls).toEqual([CUE, CUE]);
    clock.advance(1500);
    expect(ev.log).toEqual([`drop ${CUE} stuck`]);
    // The engine works again: the next cue is spoken.
    synth.stuckStart = false;
    queue.say(ev.item('Turn more', 'correction', clock.t));
    expect(synth.heard).toEqual(['Turn more']);
  });

  it('a retry after a stuck start can still succeed', () => {
    const { synth, clock, queue, ev } = setup();
    synth.stuckStart = true;
    queue.say(ev.item(CUE, 'correction', 0));
    synth.stuckStart = false;
    clock.advance(1500);
    expect(ev.log).toEqual([`start ${CUE}`]);
    expect(ev.latencies).toEqual([1500]);
  });

  it('recovers when onend never fires (watchdog), then speaks the next item', () => {
    const { synth, clock, queue, ev } = setup({ maxAgeMs: 10_000 });
    synth.noEnd = true;
    queue.say(ev.item('Sensor disconnected', 'system', 0));
    clock.advance(500);
    synth.finish(); // audio ended, but no onend
    queue.say(ev.item(CUE, 'correction', 600));
    clock.advance(3000);
    expect(synth.heard).toEqual(['Sensor disconnected']);
    clock.advance(2000);
    expect(queue.counters.recoveries).toBe(1);
    expect(synth.heard).toEqual(['Sensor disconnected', CUE]);
  });

  it('resumes a paused engine before speaking', () => {
    const { synth, queue, ev } = setup();
    synth.paused = true;
    queue.say(ev.item(CUE, 'correction'));
    expect(synth.resumes).toBeGreaterThanOrEqual(1);
    expect(synth.heard).toEqual([CUE]);
  });

  it('ignores late events of an utterance it gave up on', () => {
    const { synth, clock, queue, ev } = setup();
    queue.say(ev.item(CUE, 'correction', 0));
    const first = synth.utterances[0];
    clock.advance(1100);
    queue.say(ev.item('Turn more', 'correction', 1100));
    clock.advance(1100);
    queue.say(ev.item('Better', 'feedback', 2200));
    expect(synth.audible?.text).toBe('Better');
    first?.onend?.(); // a stale onend must not end "Better"
    queue.say(ev.item('Prepare earlier', 'correction', 2300));
    expect(synth.audible?.text).toBe('Better');
  });

  it('primes only when idle', () => {
    const { synth, queue, ev } = setup();
    queue.prime();
    expect(synth.spokenCalls).toEqual([' ']);
    queue.say(ev.item(CUE, 'correction'));
    queue.prime();
    expect(synth.spokenCalls).toEqual([' ', CUE]);
  });
});

describe('voices', () => {
  it('lists voices, follows voiceschanged and caches the chosen voice', () => {
    const { synth, queue, ev } = setup();
    expect(queue.voices()).toEqual([]);
    const changed = vi.fn();
    queue.onVoicesChanged(changed);
    synth.setVoices([
      voice('en-US', 'Samantha', true),
      voice('en-GB', 'Daniel'),
      voice('et-EE', 'Karl'),
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(queue.voices().map((v) => v.name)).toEqual(['Samantha', 'Daniel', 'Karl']);
    expect(hasVoiceFor(queue.voices(), 'et')).toBe(true);

    queue.say({
      ...ev.item('Tere', 'info', undefined, 'et'),
      voice: { lang: 'et', voiceURI: 'uri:Karl', rate: 1.2, pitch: 0.9, volume: 0.5 },
    });
    const u = synth.utterances.at(-1);
    expect(u?.voice?.name).toBe('Karl');
    expect(u?.lang).toBe('et-EE');
    expect([u?.rate, u?.pitch, u?.volume]).toEqual([1.2, 0.9, 0.5]);
    synth.finish();

    // An English fallback while Estonian is chosen: the Estonian voice is not used.
    queue.say({
      ...ev.item('Better', 'feedback'),
      voice: { lang: 'et', voiceURI: 'uri:Karl', rate: 1, pitch: 1, volume: 1 },
    });
    expect(synth.utterances.at(-1)?.voice?.name).toBe('Samantha'); // the browser default
  });

  it('picks the chosen voice, else the default, else British English, else the first', () => {
    const vs = [voice('en-US', 'A'), voice('en-GB', 'B'), voice('et_EE', 'C')];
    expect(pickVoice(vs, 'en', 'uri:A')?.name).toBe('A');
    expect(pickVoice(vs, 'en')?.name).toBe('B');
    expect(pickVoice(vs, 'en', 'uri:C')?.name).toBe('B');
    expect(pickVoice(vs, 'et')?.name).toBe('C');
    expect(pickVoice([voice('en-US', 'A')], 'et')).toBeNull();
    expect(voicesFor(vs, 'et').map((v) => v.name)).toEqual(['C']);
  });
});
