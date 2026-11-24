import { render } from 'preact';
import { CoachController } from './app/controller';
import { type AudioContextLike, ClipEngine, StaticClipSource } from './feedback/clipEngine';
import { DownloadedVoiceStore, VOICE_CACHE_NAME, etVoiceId } from './feedback/estonianVoice';
import { SilentSpeaker, SpeechQueue } from './feedback/speech';
import { BrowserScreenLock, NO_SCREEN_LOCK } from './feedback/wakeLock';
import { IndexedDbRepository } from './storage/repository';
import { App } from './ui/App';
import { strings } from './ui/strings';
import './ui/styles.css';

async function bootstrap(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');

  const repository = await IndexedDbRepository.open();
  const base = import.meta.env.BASE_URL;
  const fetchFn = globalThis.fetch.bind(globalThis);
  // Downloaded voices (Estonian) live in Cache Storage; English clips ship with the app.
  const voiceStore =
    'caches' in globalThis
      ? new DownloadedVoiceStore(() => caches.open(VOICE_CACHE_NAME), base)
      : null;
  const bundled = new StaticClipSource(fetchFn, base);
  const clips =
    'AudioContext' in globalThis
      ? new ClipEngine({
          createContext: () => new AudioContext() as unknown as AudioContextLike,
          sourceFor: (voiceId) => (voiceId.startsWith('en-') ? bundled : voiceStore),
        })
      : null;
  // iOS 17+: Web Audio is muted by the silent switch unless the page asks for playback.
  const session = (navigator as { audioSession?: { type: string } }).audioSession;
  if (session) session.type = 'playback';
  const speaker =
    'speechSynthesis' in globalThis
      ? new SpeechQueue(globalThis.speechSynthesis, clips ? { clips } : {})
      : new SilentSpeaker();
  const screenLock = BrowserScreenLock.isSupported() ? new BrowserScreenLock() : NO_SCREEN_LOCK;
  const controller = new CoachController({
    repository,
    speaker,
    screenLock,
    ...(voiceStore
      ? {
          estonianVoice: {
            fetch: fetchFn,
            store: voiceStore,
            onInstalled: (speakerName: string) => {
              clips?.forget(etVoiceId(speakerName));
            },
          },
        }
      : {}),
  });
  await controller.init();
  // Bring-up hook (docs/bring-up.md): racketCoach.runBench(test, param) in the console.
  Object.assign(globalThis, { racketCoach: controller });

  render(<App controller={controller} />, root);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  const language = navigator.language.toLowerCase().startsWith('et') ? 'et' : 'en';
  document.documentElement.lang = language;
  document.body.textContent = strings(language).startupError;
});
