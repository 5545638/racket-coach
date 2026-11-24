import type { Language } from '../coaching/guidance';
import type { FeedbackFrequency, SpokenLanguage, VoiceEngine, VoiceProfile } from '../domain/types';
import type { DownloadFailure } from './estonianVoice';

/** Spoken system messages (connection, battery), in both spoken languages. */
export type SystemPhrase = 'connected' | 'disconnected' | 'lost' | 'batteryLow';

export const SYSTEM_PHRASES: Readonly<
  Record<SpokenLanguage, Readonly<Record<SystemPhrase, string>>>
> = {
  en: {
    connected: 'Sensor connected',
    disconnected: 'Sensor disconnected',
    lost: 'Sensor lost',
    batteryLow: 'Sensor battery low',
  },
  et: {
    connected: 'Andur ühendatud',
    disconnected: 'Anduri ühendus katkes',
    lost: 'Andur kadus',
    batteryLow: 'Anduri aku on tühjenemas',
  },
};

/** Phrase of the "test voice" button. */
export const TEST_PHRASES: Readonly<Record<SpokenLanguage, string>> = {
  en: 'Swing low to high',
  et: 'See on minu hääl',
};

export interface SpeechStrings {
  readonly heading: string;
  readonly mute: string;
  readonly muteHint: string;
  readonly frequency: string;
  readonly frequencyOption: Readonly<Record<FeedbackFrequency, string>>;
  readonly autoRally: string;
  readonly autoRallyHint: string;
  readonly spokenLanguage: string;
  readonly languageName: Readonly<Record<SpokenLanguage, string>>;
  readonly noEstonianVoice: string;
  readonly voice: string;
  readonly defaultVoice: string;
  readonly noVoices: string;
  readonly rate: string;
  readonly pitch: string;
  readonly volume: string;
  readonly test: string;
  readonly diagnostics: string;
  readonly latency: (p50: number, p95: number, n: number) => string;
  readonly noLatency: string;
  readonly dropped: (n: number) => string;
  readonly suppressed: (n: number) => string;
  readonly rallyNow: string;
  readonly engine: string;
  readonly engineOption: Readonly<Record<VoiceEngine, string>>;
  readonly naturalHint: string;
  readonly profile: string;
  readonly profileOption: Readonly<Record<VoiceProfile, string>>;
  readonly systemVoice: string;
  readonly systemOnlyHint: string;
  readonly etNatural: string;
  readonly etSpeaker: string;
  readonly etDownload: string;
  readonly etChecking: string;
  readonly etMissing: string;
  readonly etReady: (clips: number) => string;
  readonly etPartial: (clips: number, total: number) => string;
  readonly etDownloading: (done: number, total: number) => string;
  readonly etFailed: (reason: DownloadFailure, status?: number) => string;
  readonly etCredit: string;
  readonly engines: (clips: number, synth: number, fallback: number) => string;
  readonly fallbackTexts: string;
}

const ET: SpeechStrings = {
  heading: 'Kõne',
  mute: 'Vaigista kõne',
  muteHint: 'Löögi vihjeid ei öelda; anduri teated kõlavad edasi.',
  frequency: 'Kui tihti rääkida',
  frequencyOption: {
    every: 'Iga löögi järel',
    changes: 'Ainult kui vihje muutub',
    every2: 'Kõige rohkem iga 2. löögi järel',
    every3: 'Kõige rohkem iga 3. löögi järel',
    off: 'Välja',
  },
  autoRally: 'Vaiki ralli ajal automaatselt',
  autoRallyHint:
    'Kui vähemalt 3 lööki tulevad alla 3,5 s vahega, vihjeid ei öelda kuni 6 s pausini.',
  spokenLanguage: 'Kõne keel',
  languageName: { et: 'Eesti', en: 'English' },
  noEstonianVoice: 'Eestikeelset häält pole selles seadmes — kasutan inglise keelt',
  voice: 'Hääl',
  defaultVoice: 'Vaikimisi',
  noVoices: 'Seade pole hääli veel andnud.',
  rate: 'Kiirus',
  pitch: 'Kõrgus',
  volume: 'Valjus',
  test: 'Proovi',
  diagnostics: 'Kõne diagnostika',
  latency: (p50, p95, n) => `Viivitus löögist kõneni: p50 ${p50} ms, p95 ${p95} ms (${n} vihjet)`,
  noLatency: 'Selles sessioonis pole veel vihjeid öeldud.',
  dropped: (n) => `Ära jäetud (aegunud / asendatud / kinni jäänud): ${n}`,
  suppressed: (n) => `Vaigistatud (sagedus / ralli / vaigistus): ${n}`,
  rallyNow: 'Ralli käib: vihjed ootavad pausi.',
  engine: 'Hääle tüüp',
  engineOption: {
    natural: 'Loomulik hääl (salvestatud treeneri hääl)',
    system: 'Seadme hääl',
  },
  naturalHint:
    'Loomulik hääl mängib ette salvestatud lauseid ja töötab ilma võrguta; lause, mida pole salvestatud, ütleb seadme hääl.',
  profile: 'Inglise treeneri hääl',
  profileOption: { female: 'Naishääl', male: 'Meeshääl' },
  systemVoice: 'Seadme hääl',
  systemOnlyHint: 'Kiirus ja kõrgus kehtivad ainult seadme häälele.',
  etNatural: 'Loomulik eestikeelne hääl',
  etSpeaker: 'Kõneleja',
  etDownload: 'Laadi loomulik eestikeelne hääl',
  etChecking: 'Kontrollin allalaaditud häält…',
  etMissing:
    'Pole alla laaditud. Laadimine vajab korra võrku (umbes 100 lauset), siis töötab ilma võrguta.',
  etReady: (clips) => `Alla laaditud (${clips} lauset), töötab ilma võrguta.`,
  etPartial: (clips, total) =>
    `Osaliselt alla laaditud: ${clips}/${total} lauset. Laadi ülejäänud.`,
  etDownloading: (done, total) => `Laadin… ${done}/${total}`,
  etFailed: (reason, status) =>
    reason === 'network'
      ? 'Allalaadimine ebaõnnestus: võrk pole kättesaadav või teenus ei luba päringut (CORS). Inglise loomulik hääl ja seadme hääl töötavad edasi.'
      : reason === 'http'
        ? `Allalaadimine ebaõnnestus: teenus vastas veaga${status === undefined ? '' : ` ${status}`}. Proovi hiljem või vali teine kõneleja.`
        : reason === 'storage'
          ? 'Allalaadimine ebaõnnestus: brauser ei lubanud häält salvestada (vaba ruum või privaatrežiim).'
          : 'Allalaadimine ebaõnnestus: teenus saatis tundmatu vormingu.',
  etCredit: 'Eesti hääl: TartuNLP (Tartu Ülikool) neurokõnesüntees.',
  engines: (clips, synth, fallback) =>
    `Loomulik hääl: ${clips} · seadme hääl: ${synth} · seadme hääl salvestuse puudumisel: ${fallback}`,
  fallbackTexts: 'Salvestuseta laused',
};

const EN: SpeechStrings = {
  heading: 'Speech',
  mute: 'Mute speech',
  muteHint: 'Stroke cues are not spoken; sensor messages still are.',
  frequency: 'How often to speak',
  frequencyOption: {
    every: 'After every stroke',
    changes: 'Only when the cue changes',
    every2: 'At most every 2nd stroke',
    every3: 'At most every 3rd stroke',
    off: 'Off',
  },
  autoRally: 'Stay quiet during rallies automatically',
  autoRallyHint: 'When 3 or more strokes come less than 3.5 s apart, cues wait for a pause of 6 s.',
  spokenLanguage: 'Spoken language',
  languageName: { et: 'Eesti', en: 'English' },
  noEstonianVoice: 'No Estonian voice on this device — speaking English',
  voice: 'Voice',
  defaultVoice: 'Default',
  noVoices: 'The device has not listed any voices yet.',
  rate: 'Rate',
  pitch: 'Pitch',
  volume: 'Volume',
  test: 'Test',
  diagnostics: 'Speech diagnostics',
  latency: (p50, p95, n) => `Stroke-to-speech latency: p50 ${p50} ms, p95 ${p95} ms (${n} cues)`,
  noLatency: 'No cue spoken in this session yet.',
  dropped: (n) => `Dropped (stale / replaced / stuck): ${n}`,
  suppressed: (n) => `Silenced (frequency / rally / mute): ${n}`,
  rallyNow: 'Rally in progress: cues wait for a pause.',
  engine: 'Voice type',
  engineOption: {
    natural: 'Natural voice (recorded coach voice)',
    system: 'Device voice',
  },
  naturalHint:
    'The natural voice plays recorded phrases and works offline; a phrase without a recording is spoken by the device voice.',
  profile: 'English coach voice',
  profileOption: { female: 'Female voice', male: 'Male voice' },
  systemVoice: 'Device voice',
  systemOnlyHint: 'Rate and pitch apply to the device voice only.',
  etNatural: 'Natural Estonian voice',
  etSpeaker: 'Speaker',
  etDownload: 'Download natural Estonian voice',
  etChecking: 'Checking the downloaded voice…',
  etMissing:
    'Not downloaded. The download needs the network once (about 100 phrases), then works offline.',
  etReady: (clips) => `Downloaded (${clips} phrases), works offline.`,
  etPartial: (clips, total) => `Partly downloaded: ${clips}/${total} phrases. Download the rest.`,
  etDownloading: (done, total) => `Downloading… ${done}/${total}`,
  etFailed: (reason, status) =>
    reason === 'network'
      ? 'Download failed: no network, or the service does not allow the request (CORS). The English natural voice and the device voice keep working.'
      : reason === 'http'
        ? `Download failed: the service answered with an error${status === undefined ? '' : ` ${status}`}. Try later or pick another speaker.`
        : reason === 'storage'
          ? 'Download failed: the browser did not allow storing the voice (free space or private mode).'
          : 'Download failed: the service sent an unknown format.',
  etCredit: 'Estonian voice: TartuNLP (University of Tartu) neural speech synthesis.',
  engines: (clips, synth, fallback) =>
    `Natural voice: ${clips} · device voice: ${synth} · device voice for lack of a recording: ${fallback}`,
  fallbackTexts: 'Phrases without a recording',
};

export const speechStrings = (language: Language): SpeechStrings => (language === 'et' ? ET : EN);
