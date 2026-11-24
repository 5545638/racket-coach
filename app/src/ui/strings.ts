import type { Language } from '../coaching/guidance';
import type { StrokeType } from '../domain/types';

/** All on-screen text. Spoken cues stay English (see ADR 0004). */
export interface Strings {
  /** aria-label of the bottom tab bar. */
  readonly sections: string;
  /** Shown when the app cannot start (e.g. IndexedDB unavailable). */
  readonly startupError: string;
  /** Localised short cue title per rule id; falls back to the (English) spoken cue. */
  readonly cueTitle: Readonly<Record<string, string>>;
  readonly tabs: { readonly live: string; readonly session: string; readonly setup: string };
  readonly stroke: Record<StrokeType, string>;
  readonly compact: string;
  readonly slice: string;
  readonly connect: string;
  readonly demo: string;
  readonly disconnect: string;
  readonly connecting: string;
  readonly notConnected: string;
  readonly sensor: string;
  readonly calibrateFirst: string;
  readonly waiting: string;
  readonly connectHint: string;
  readonly meaning: string;
  readonly fix: string;
  readonly drill: string;
  readonly noContact: string;
  readonly wrist: {
    readonly verdict: string;
    readonly loose: string;
    readonly stiff: string;
    readonly unknown: string;
    readonly disclaimer: string;
    readonly looseShare: string;
  };
  readonly group: {
    readonly wrist: string;
    readonly preparation: string;
    readonly contact: string;
    readonly finish: string;
  };
  readonly metric: {
    readonly preparationTime: string;
    readonly backswing: string;
    readonly pause: string;
    readonly racketDrop: string;
    readonly faceAtDrop: string;
    readonly speed: string;
    readonly face: string;
    readonly path: string;
    readonly peakSpeed: string;
    readonly whip: string;
    readonly faceClosing: string;
    readonly forwardSwing: string;
    readonly followThrough: string;
  };
  readonly target: string;
  readonly faceGauge: { readonly open: string; readonly closed: string; readonly label: string };
  readonly session: {
    readonly title: string;
    readonly strokes: (n: number, unrated: number) => string;
    readonly spread: string;
    readonly focusTitle: string;
    readonly focusLine: (stroke: string, count: number, rated: number) => string;
    readonly noFocus: string;
    readonly good: string;
    readonly corrections: string;
    readonly exportCsv: string;
    readonly exportRaw: string;
    readonly newSession: string;
    readonly diagnostics: string;
  };
  readonly setup: {
    readonly calibration: string;
    readonly calibrated: (date: string) => string;
    readonly calibrationNeeded: string;
    readonly stepFaceUp: string;
    readonly stepTipUp: string;
    readonly capture: string;
    readonly holdStill: string;
    readonly step1Done: string;
    readonly saved: string;
    readonly feedback: string;
    readonly mode: string;
    readonly drillMode: string;
    readonly rallyMode: string;
    readonly speakGood: string;
    readonly speechRate: string;
    readonly language: string;
    readonly model: string;
    readonly lever: string;
    readonly leverHint: string;
    readonly firmware: string;
    readonly protocol: string;
  };
}

const en: Strings = {
  sections: 'Sections',
  startupError: 'Racket Coach failed to start. Is private browsing enabled?',
  cueTitle: {
    'slice-face-closed': 'Open the face for the slice',
    'slice-chop': 'Slice through the ball, not down',
    'face-open': 'Face too open',
    'face-closed': 'Face too closed',
    'path-flat': 'Swing low to high',
    'path-steep': 'Drive through the ball',
    'accelerated-early': 'Accelerate through contact',
    'no-racket-drop': 'Drop the racket head',
    'open-takeback': 'Face down on the take-back',
    hitch: 'Keep the swing flowing',
    'stiff-arm': 'Loosen the wrist',
    'short-finish': 'Finish your swing',
    good: 'Good',
    'not-rated': 'Counted',
    'no-reading': 'No reading',
  },
  tabs: { live: 'Live', session: 'Session', setup: 'Setup' },
  stroke: { forehand: 'Forehand', backhand: 'Backhand', overhead: 'Overhead' },
  compact: 'compact',
  slice: 'slice',
  connect: 'Connect',
  demo: 'Demo',
  disconnect: 'Disconnect',
  connecting: 'Connecting…',
  notConnected: 'Not connected',
  sensor: 'Sensor',
  calibrateFirst: 'Calibrate the sensor in Setup before hitting.',
  waiting: 'Waiting for the first stroke…',
  connectHint: 'Connect the sensor, or try Demo.',
  meaning: 'What it means',
  fix: 'What to do',
  drill: 'Drill',
  noContact: 'No ball contact detected.',
  wrist: {
    verdict: 'Wrist',
    loose: 'Loose: the racket lags behind the hand and whips through',
    stiff: 'Tight: the racket moves together with the arm',
    unknown: 'Not assessed for this stroke',
    disclaimer:
      'Estimated from racket lag. The sensor cannot see the wrist angle or grip pressure.',
    looseShare: 'Loose wrist',
  },
  group: {
    wrist: 'Wrist (indirect estimate)',
    preparation: 'Preparation',
    contact: 'Contact',
    finish: 'Finish',
  },
  metric: {
    preparationTime: 'Preparation time',
    backswing: 'Take-back',
    pause: 'Pause before swing',
    racketDrop: 'Racket drop',
    faceAtDrop: 'Face at the drop',
    speed: 'Racket speed',
    face: 'Face at contact',
    path: 'Swing path',
    peakSpeed: 'Peak speed',
    whip: 'Peak acceleration before contact',
    faceClosing: 'Face closing',
    forwardSwing: 'Forward swing',
    followThrough: 'Follow-through',
  },
  target: 'target',
  faceGauge: {
    open: 'open',
    closed: 'closed',
    label: 'Racket face at contact, seen from the side',
  },
  session: {
    title: 'Session',
    strokes: (n, unrated) => `${n} strokes${unrated ? `, ${unrated} without a reading` : ''}.`,
    spread:
      '“±” is the spread: smaller means more consistent. Slices are left out of the averages.',
    focusTitle: 'Focus for next time',
    focusLine: (stroke, count, rated) => `${stroke}: ${count} of ${rated} strokes`,
    noFocus: 'No single fault stands out yet. Hit at least 20 balls per stroke for a verdict.',
    good: 'Good',
    corrections: 'Corrections',
    exportCsv: 'Export CSV',
    exportRaw: 'Export raw data',
    newSession: 'New session',
    diagnostics: 'Diagnostics',
  },
  setup: {
    calibration: 'Calibration',
    calibrated: (date) => `Calibrated ${date}. Repeat after moving the sensor.`,
    calibrationNeeded: 'Needed once per sensor position. Takes 10 seconds.',
    stepFaceUp:
      'Lay the racket flat with the face you hit forehands with facing up. Keep it still.',
    stepTipUp: 'Stand the racket on its butt cap, tip up. Keep it still.',
    capture: 'Capture',
    holdStill: 'Hold still…',
    step1Done: 'Step 1 done. Now step 2.',
    saved: 'Calibration saved.',
    feedback: 'Feedback',
    mode: 'Mode',
    drillMode: 'Drill: spoken cue after every stroke',
    rallyMode: 'Rally: silent, review afterwards',
    speakGood: 'Say “Good” when there is nothing to fix',
    speechRate: 'Speech rate',
    language: 'Language of explanations (voice is English)',
    model: 'Model',
    lever: 'Swing lever (shoulder to sweet spot)',
    leverHint: 'Scales racket speed only. Angles do not depend on it.',
    firmware: 'Firmware',
    protocol: 'protocol',
  },
};

const et: Strings = {
  sections: 'Jaotised',
  startupError: 'Racket Coach ei käivitunud. Kas privaatne sirvimine on sisse lülitatud?',
  cueTitle: {
    'slice-face-closed': 'Ava pinda slice’i jaoks',
    'slice-chop': 'Slice’i löö läbi palli, mitte alla',
    'face-open': 'Pind liiga avatud',
    'face-closed': 'Pind liiga suletud',
    'path-flat': 'Löö alt üles',
    'path-steep': 'Löö palli läbi',
    'accelerated-early': 'Kiirenda läbi tabamuse',
    'no-racket-drop': 'Lase reketi pea langeda',
    'open-takeback': 'Pind alla tagahoos',
    hitch: 'Hoia hoog voolavana',
    'stiff-arm': 'Lõdvesta ranne',
    'short-finish': 'Vii löök lõpuni',
    good: 'Korras',
    'not-rated': 'Loetud',
    'no-reading': 'Näit puudub',
  },
  tabs: { live: 'Löök', session: 'Trenn', setup: 'Seaded' },
  stroke: { forehand: 'Forehand', backhand: 'Backhand', overhead: 'Ülaltlöök' },
  compact: 'lühike',
  slice: 'slice',
  connect: 'Ühenda',
  demo: 'Demo',
  disconnect: 'Katkesta',
  connecting: 'Ühendan…',
  notConnected: 'Ühendus puudub',
  sensor: 'Andur',
  calibrateFirst: 'Enne löömist kalibreeri andur seadetes.',
  waiting: 'Ootan esimest lööki…',
  connectHint: 'Ühenda andur või proovi demot.',
  meaning: 'Mida see tähendab',
  fix: 'Mida teha',
  drill: 'Harjutus',
  noContact: 'Palli tabamust ei tuvastatud.',
  wrist: {
    verdict: 'Ranne',
    loose: 'Lõtv: reket jääb käest maha ja tuleb piitsana läbi',
    stiff: 'Pinges: reket liigub käega koos',
    unknown: 'Selle löögi puhul ei hinnata',
    disclaimer:
      'Hinnang põhineb reketi mahajäämisel. Andur ei näe randme nurka ega haarde tugevust ning see on vaid kaudne näitaja.',
    looseShare: 'Lõtv ranne',
  },
  group: {
    wrist: 'Ranne (kaudne hinnang)',
    preparation: 'Ettevalmistus',
    contact: 'Tabamus',
    finish: 'Lõpetus',
  },
  metric: {
    preparationTime: 'Ettevalmistuse aeg',
    backswing: 'Tahaviimine',
    pause: 'Paus enne lööki',
    racketDrop: 'Reketi langetus',
    faceAtDrop: 'Pind langetusel',
    speed: 'Reketi kiirus',
    face: 'Pind tabamusel',
    path: 'Löögi trajektoor',
    peakSpeed: 'Tippkiirus',
    whip: 'Suurim kiirendus enne tabamust',
    faceClosing: 'Pinna sulgumine',
    forwardSwing: 'Ettelöök',
    followThrough: 'Lõpetus',
  },
  target: 'siht',
  faceGauge: { open: 'avatud', closed: 'suletud', label: 'Reketipind tabamusel, küljelt vaadates' },
  session: {
    title: 'Trenn',
    strokes: (n, unrated) => `${n} lööki${unrated ? `, neist ${unrated} ilma mõõtmiseta` : ''}.`,
    spread:
      '„±“ on hajuvus: mida väiksem, seda ühtlasemad löögid. Slice’id on keskmistest välja jäetud.',
    focusTitle: 'Järgmise trenni fookus',
    focusLine: (stroke, count, rated) => `${stroke}: ${count} löögil ${rated}-st`,
    noFocus: 'Ükski viga ei eristu veel. Hinnangu jaoks löö iga löögiliigiga vähemalt 20 palli.',
    good: 'Korras',
    corrections: 'Parandused',
    exportCsv: 'Ekspordi CSV',
    exportRaw: 'Ekspordi toorandmed',
    newSession: 'Uus trenn',
    diagnostics: 'Diagnostika',
  },
  setup: {
    calibration: 'Kalibreerimine',
    calibrated: (date) => `Kalibreeritud ${date}. Korda pärast anduri liigutamist.`,
    calibrationNeeded: 'Tuleb teha üks kord iga anduri asendi kohta. Võtab 10 sekundit.',
    stepFaceUp: 'Pane reket pikali nii, et forehandi löömise pool oleks üleval. Hoia paigal.',
    stepTipUp: 'Pane reket otsakorgile püsti, tipp üleval. Hoia paigal.',
    capture: 'Mõõda',
    holdStill: 'Hoia paigal…',
    step1Done: '1. samm tehtud. Nüüd 2. samm.',
    saved: 'Kalibreerimine salvestatud.',
    feedback: 'Tagasiside',
    mode: 'Režiim',
    drillMode: 'Harjutus: hääl pärast iga lööki',
    rallyMode: 'Rally: vaikne, vaata hiljem üle',
    speakGood: 'Ütle „Good“, kui parandada pole midagi',
    speechRate: 'Kõne kiirus',
    language: 'Selgituste keel (hääl on inglise keeles)',
    model: 'Mudel',
    lever: 'Hoova pikkus (õlast reketi tabamispunktini)',
    leverHint: 'Mõjutab ainult reketi kiirust. Nurgad sellest ei sõltu.',
    firmware: 'Püsivara',
    protocol: 'protokoll',
  },
};

const STRINGS: Record<Language, Strings> = { en, et };

export const strings = (language: Language): Strings => STRINGS[language];

/** Localised cue title for a rule id, falling back to the English spoken cue text. */
export const cueLabel = (t: Strings, ruleId: string, fallback: string): string =>
  t.cueTitle[ruleId] ?? fallback;
