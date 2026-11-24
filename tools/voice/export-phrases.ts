/**
 * Lists every phrase the app can speak (app/src/feedback/phraseCatalog.ts)
 * for the voice generator. Run through export-phrases.mjs (Vite's module
 * runner: the app's TypeScript is executed as is, no build).
 */
import { clipKey, spokenPhrases } from '../../app/src/feedback/phraseCatalog';

export interface PhraseExport {
  /** Bumped when the format changes. */
  readonly version: 1;
  /** Language → phrases, as the app speaks them (on-screen spelling). */
  readonly phrases: Readonly<Record<'en' | 'et', readonly { text: string; key: string }[]>>;
}

const entries = (lang: 'en' | 'et') =>
  [...spokenPhrases(lang)]
    .map((text) => ({ text, key: clipKey(text) }))
    .sort((a, b) => a.key.localeCompare(b.key, 'en'));

export const exportPhrases = (): PhraseExport => ({
  version: 1,
  phrases: { en: entries('en'), et: entries('et') },
});
