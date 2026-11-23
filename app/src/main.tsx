import { render } from 'preact';
import { CoachController } from './app/controller';
import { SilentSpeaker, WebSpeechSpeaker } from './feedback/speech';
import { BrowserScreenLock, NO_SCREEN_LOCK } from './feedback/wakeLock';
import { IndexedDbRepository } from './storage/repository';
import { App } from './ui/App';
import './ui/styles.css';

async function bootstrap(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');

  const repository = await IndexedDbRepository.open();
  const speaker =
    'speechSynthesis' in globalThis
      ? new WebSpeechSpeaker(globalThis.speechSynthesis)
      : new SilentSpeaker();
  const screenLock = BrowserScreenLock.isSupported() ? new BrowserScreenLock() : NO_SCREEN_LOCK;
  const controller = new CoachController({ repository, speaker, screenLock });
  await controller.init();

  render(<App controller={controller} />, root);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  document.body.textContent = 'Racket Coach failed to start. Is private browsing enabled?';
});
