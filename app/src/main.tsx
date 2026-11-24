import { render } from 'preact';
import { CoachController } from './app/controller';
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
  const speaker =
    'speechSynthesis' in globalThis
      ? new SpeechQueue(globalThis.speechSynthesis)
      : new SilentSpeaker();
  const screenLock = BrowserScreenLock.isSupported() ? new BrowserScreenLock() : NO_SCREEN_LOCK;
  const controller = new CoachController({ repository, speaker, screenLock });
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
