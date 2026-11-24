import type { UtteranceReason } from '../coach/coachEngine';
import { CORRECTIONS } from '../coaching/corrections';
import type { Language } from '../coaching/guidance';
import type { DeviationCategory, SensorDiagnostics, StrokeType } from '../domain/types';
import type { NotAssessableReason } from '../elements/catalog';

/** All on-screen text. Spoken cues stay English (see ADR 0004). */
export interface Strings {
  /** aria-label of the bottom tab bar. */
  readonly sections: string;
  /** Shown when the app cannot start (e.g. IndexedDB unavailable). */
  readonly startupError: string;
  /** Localised short title per correction id (from CORRECTIONS) and legacy cue id; falls back to the spoken cue. */
  readonly cueTitle: Readonly<Record<string, string>>;
  readonly tabs: {
    readonly live: string;
    readonly session: string;
    readonly profile: string;
    readonly setup: string;
  };
  /** Short names of the deviation categories (per-stroke summary). */
  readonly category: Record<DeviationCategory, string>;
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
  readonly group: {
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
    readonly faceClosing: string;
    readonly takebackTurn: string;
    readonly takebackTip: string;
    readonly takebackFace: string;
    readonly takebackTime: string;
    readonly hitchCount: string;
    readonly brushAngle: string;
    readonly contactStability: string;
    readonly lateAcceleration: string;
    readonly brakingTime: string;
    readonly recovery: string;
    readonly serveDrop: string;
    readonly serveContactTip: string;
    readonly serveRoll: string;
    readonly forwardSwing: string;
    readonly followThrough: string;
  };
  /** Why a value could not be judged. */
  readonly reason: Readonly<Record<NotAssessableReason, string>>;
  readonly live: {
    readonly better: string;
    readonly thatsIt: string;
    readonly good: string;
    readonly counted: string;
    readonly voice: string;
    /** Titles of the adaptive feedback phrases. */
    readonly overcorrected: string;
    readonly consistency: string;
    readonly fatigue: string;
    readonly stuck: string;
    /** Detail line under the headline, by what the coach decided (missing = none). */
    readonly detail: Readonly<Partial<Record<UtteranceReason, string>>>;
    readonly why: string;
    readonly change: string;
    readonly drill: string;
    readonly focus: string;
    readonly noFocus: string;
    readonly focusOk: string;
    readonly focusNotAssessed: string;
    readonly confidence: (percent: number) => string;
    readonly comparedPersonal: (n: number) => string;
    readonly comparedPopulation: string;
    readonly comparedCombined: (n: number) => string;
    readonly baselineLoading: string;
    readonly baselineProgress: (n: number, needed: number) => string;
    readonly limit: string;
    readonly fatigueBadge: string;
    /** Label of the spoken explanation shown in learning mode. */
    readonly learning: string;
    /** Match mode: label of the persistent fault spoken in a break. */
    readonly matchSpoken: string;
    readonly matchStrokes: string;
  };
  readonly profile: {
    readonly title: string;
    readonly inputs: string;
    readonly change: string;
    readonly typical: string;
    readonly typicalStrokes: (n: number) => string;
    readonly noTypical: string;
    readonly weaknesses: string;
    readonly noWeaknesses: string;
    readonly sessionsN: (n: number) => string;
    readonly faultRate: string;
    readonly trend: Record<'improving' | 'stable' | 'worsening', string>;
    readonly progress: string;
    readonly noProgress: string;
    readonly sparkAria: (name: string, values: string) => string;
    readonly sparkHint: string;
    readonly plan: string;
    readonly noPlan: string;
    readonly volume: (sets: number, balls: number) => string;
    readonly bestCue: string;
    readonly target: (percent: number) => string;
    readonly targetKeep: (percent: number) => string;
    readonly focusItem: string;
    readonly maintenance: string;
    readonly drill: string;
    readonly empty: string;
    readonly basedOn: (n: number) => string;
  };
  readonly faceGauge: { readonly open: string; readonly closed: string; readonly label: string };
  readonly session: {
    readonly title: string;
    readonly strokes: (n: number, unrated: number) => string;
    readonly spread: string;
    readonly focusTitle: string;
    readonly noFocus: string;
    readonly good: string;
    readonly corrections: string;
    readonly noCorrections: string;
    readonly counted: (n: number) => string;
    readonly betterTimes: (n: number) => string;
    readonly thatsItTimes: (n: number) => string;
    readonly focusNow: string;
    readonly exportCsv: string;
    readonly exportRaw: string;
    readonly newSession: string;
    readonly diagnostics: string;
    readonly categoriesTitle: string;
    readonly feedbackTitle: string;
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
    readonly learningMode: string;
    readonly trainingMode: string;
    readonly matchMode: string;
    readonly player: string;
    readonly dominantHand: string;
    readonly handRight: string;
    readonly handLeft: string;
    readonly backhand: string;
    readonly twoHanded: string;
    readonly oneHanded: string;
    readonly forehandStyle: string;
    readonly styleTopspin: string;
    readonly styleFlat: string;
    readonly styleMixed: string;
    readonly level: string;
    readonly levelBeginner: string;
    readonly levelIntermediate: string;
    readonly levelAdvanced: string;
    readonly speakGood: string;
    readonly speechRate: string;
    readonly language: string;
    readonly model: string;
    readonly lever: string;
    readonly leverHint: string;
    readonly firmware: string;
    readonly protocol: string;
    readonly engine: string;
    readonly confidenceInfo: (percent: number) => string;
    readonly baseline: string;
    readonly baselineInfo: (needed: number) => string;
    readonly baselineCount: (stroke: string, n: number, needed: number) => string;
    readonly baselineLoading: string;
    readonly resetBaseline: string;
    readonly resetConfirm: string;
    readonly resetDone: (date: string) => string;
    readonly sensor: string;
    readonly experimentalM416: string;
    readonly experimentalM416Hint: string;
    /** The IMU temperature moved more than 10 °C from the calibration's. */
    readonly temperatureChanged: string;
    readonly diagnostics: string;
    readonly diagnosticsLine: (d: SensorDiagnostics) => string;
  };
}

/** Correction titles come from the correction catalogue; legacy cue ids are added. */
const cueTitles = (
  language: Language,
  legacy: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  ...legacy,
  ...Object.fromEntries(Object.entries(CORRECTIONS[language]).map(([id, c]) => [id, c.title])),
});

const en: Strings = {
  sections: 'Sections',
  startupError: 'Racket Coach failed to start. Is private browsing enabled?',
  cueTitle: cueTitles('en', { good: 'Good', 'not-rated': 'Counted', 'no-reading': 'No reading' }),
  tabs: { live: 'Live', session: 'Session', profile: 'Profile', setup: 'Setup' },
  category: {
    'technical-error': 'Fault',
    variation: 'Your style',
    uncertain: 'Unsure',
    'not-assessable': 'Not judged',
    'fatigue-related': 'Tired',
    improvement: 'Improved',
  },
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
  group: {
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
    faceClosing: 'Face closing',
    takebackTurn: 'Take-back turn',
    takebackTip: 'Racket tip at take-back',
    takebackFace: 'Face at take-back',
    takebackTime: 'Ready position to contact',
    hitchCount: 'Hitches in the swing',
    brushAngle: 'Brush angle',
    contactStability: 'Face stability at contact',
    lateAcceleration: 'Late acceleration (proxy)',
    brakingTime: 'Braking time',
    recovery: 'Recovery',
    serveDrop: 'Racket tip at the serve drop',
    serveContactTip: 'Racket tip at contact',
    serveRoll: 'Racket roll angle',
    forwardSwing: 'Forward swing',
    followThrough: 'Follow-through',
  },
  reason: {
    'no-contact': 'No ball contact',
    'signal-gap': 'Sensor data missing in this stroke',
    'no-value': 'No reading',
    'no-sigma': 'Uncertainty unknown',
    saturated: 'Sensor clipped, value is only a bound',
    'no-baseline': 'No reference yet: personal baseline still building',
    'wrong-stroke': 'Does not apply to this stroke',
  },
  live: {
    better: 'Better',
    thatsIt: "That's it",
    good: 'Good',
    counted: 'Counted',
    voice: 'Voice',
    overcorrected: 'Too much – a little less',
    consistency: 'Same swing every time',
    fatigue: 'Take a short break',
    stuck: 'Try the drill',
    detail: {
      'ladder-sparse': 'Cue said less often now: try the drill below.',
      oscillation: 'Faults swing between opposites: aim for the same swing.',
      'fatigue-hold': 'You seem tired: no new corrections for now.',
      contradiction: 'Too far the other way after the last cue.',
      'no-contact': 'No ball contact detected.',
      'not-assessable': 'Not enough data to judge this stroke yet.',
      'focus-not-assessable': 'The focus could not be judged on this stroke.',
      'repeat-pause': 'Same cue not repeated: short pause.',
      'focus-holding': 'The focus is fine. Keep it up.',
      'no-faults': 'No faults found.',
    },
    why: 'Why',
    change: 'Change',
    drill: 'Drill',
    focus: 'Focus',
    noFocus: 'No focus yet',
    focusOk: 'fine on this stroke',
    focusNotAssessed: 'not judged on this stroke',
    confidence: (percent) => `Confidence ${percent}%`,
    comparedPersonal: (n) => `Compared with: your usual stroke (${n} strokes)`,
    comparedPopulation: 'Compared with: reference limits',
    comparedCombined: (n) => `Compared with: your usual stroke (${n} strokes) and reference limits`,
    baselineLoading: 'Loading your personal baseline…',
    baselineProgress: (n, needed) => `Personal baseline: ${n}/${needed} strokes`,
    limit: 'Limit',
    fatigueBadge: 'Tired',
    learning: 'Explanation',
    matchSpoken: 'Said in the break',
    matchStrokes: 'Strokes',
  },
  profile: {
    title: 'Profile',
    inputs: 'About you',
    change: 'Change in Setup',
    typical: 'Typical stroke',
    typicalStrokes: (n) => `${n} strokes`,
    noTypical: 'Your typical stroke appears after a few strokes.',
    weaknesses: 'Weaknesses',
    noWeaknesses: 'No lasting weaknesses so far.',
    sessionsN: (n) => `${n} sessions`,
    faultRate: 'faults',
    trend: { improving: 'improving', stable: 'steady', worsening: 'getting worse' },
    progress: 'Progress',
    noProgress: 'Progress appears once you have trained a few times.',
    sparkAria: (name, values) => `${name}: fault rate per session, ${values}`,
    sparkHint: 'Fault rate per session, oldest to newest. Lower is better.',
    plan: 'Next session plan',
    noPlan: 'The plan appears once a weakness shows up.',
    volume: (sets, balls) => `${sets} × ${balls} balls`,
    bestCue: 'Cue that worked best',
    target: (percent) => `Goal: under ${percent}% faults`,
    targetKeep: (percent) => `Goal: keep it under ${percent}% faults`,
    focusItem: 'Work on',
    maintenance: 'Keep it up',
    drill: 'Drill',
    empty: 'The profile fills in after a few sessions.',
    basedOn: (n) => `Based on your last ${n} rated strokes.`,
  },
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
    focusTitle: 'Focus',
    noFocus: 'No focus right now. One is chosen when the same fault clearly repeats.',
    good: 'Good',
    corrections: 'Most frequent corrections',
    noCorrections: 'No corrections given.',
    counted: (n) => `${n} strokes counted`,
    betterTimes: (n) => `“Better” ${n}×`,
    thatsItTimes: (n) => `“That’s it” ${n}×`,
    focusNow: 'Current focus',
    exportCsv: 'Export CSV',
    exportRaw: 'Export raw data',
    newSession: 'New session',
    diagnostics: 'Diagnostics',
    categoriesTitle: 'Strokes by reading',
    feedbackTitle: 'Feedback given',
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
    learningMode: 'Learning: cue plus a short explanation',
    trainingMode: 'Training: one short cue per stroke',
    matchMode: 'Match: silent, only a persistent major fault between points',
    player: 'Player',
    dominantHand: 'Playing hand',
    handRight: 'Right',
    handLeft: 'Left',
    backhand: 'Backhand',
    twoHanded: 'Two-handed',
    oneHanded: 'One-handed',
    forehandStyle: 'Forehand style',
    styleTopspin: 'Topspin',
    styleFlat: 'Flat',
    styleMixed: 'Mixed',
    level: 'Level',
    levelBeginner: 'Beginner (fewer, basic cues)',
    levelIntermediate: 'Intermediate',
    levelAdvanced: 'Advanced',
    speakGood: 'Say “Good” when there is nothing to fix',
    speechRate: 'Speech rate',
    language: 'Language of explanations (voice is English)',
    model: 'Model',
    lever: 'Swing radius (centre of rotation to sweet spot)',
    leverHint:
      'Scales the racket speed estimate only (default 0.72 m). Angles do not depend on it.',
    firmware: 'Firmware',
    protocol: 'protocol',
    engine: 'Coaching engine',
    confidenceInfo: (percent) =>
      `A cue is given only when the fault is at least ${percent}% certain. This limit is fixed.`,
    baseline: 'Personal baseline',
    baselineInfo: (needed) =>
      `Your usual stroke, which new strokes are compared with. It is used from ${needed} strokes per stroke type.`,
    baselineCount: (stroke, n, needed) =>
      n >= needed ? `${stroke}: ${n} strokes (in use)` : `${stroke}: ${n}/${needed} strokes`,
    baselineLoading: 'Loading…',
    resetBaseline: 'Reset personal baseline',
    resetConfirm:
      'Reset the personal baseline? Older strokes will no longer be used; saved data stays.',
    resetDone: (date) => `Last reset ${date}.`,
    sensor: 'Sensor',
    experimentalM416: 'Experimental: 416 Hz gyro around the stroke (M416)',
    experimentalM416Hint:
      'Needs firmware 0.2 or later. Not verified on hardware; the default is 104 Hz (M104).',
    temperatureChanged: 'Temperature has changed since calibration, calibrate again.',
    diagnostics: 'Diagnostics',
    diagnosticsLine: (d) =>
      `mode ${d.mode} · P ${d.payloadBytes} B · FIFO overruns ${d.fifoOverruns} · dropped strokes ${d.droppedCaptures} · errors ${d.errors} · free memory ${d.freeVars}`,
  },
};

const et: Strings = {
  sections: 'Jaotised',
  startupError: 'Racket Coach ei käivitunud. Kas privaatne sirvimine on sisse lülitatud?',
  cueTitle: cueTitles('et', { good: 'Korras', 'not-rated': 'Loetud', 'no-reading': 'Näit puudub' }),
  tabs: { live: 'Löök', session: 'Trenn', profile: 'Profiil', setup: 'Seaded' },
  category: {
    'technical-error': 'Viga',
    variation: 'Sinu stiil',
    uncertain: 'Ebakindel',
    'not-assessable': 'Hindamata',
    'fatigue-related': 'Väsinud',
    improvement: 'Paranes',
  },
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
  group: {
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
    faceClosing: 'Pinna sulgumine',
    takebackTurn: 'Tahaviimise pööre',
    takebackTip: 'Reketi ots tahaviimisel',
    takebackFace: 'Pind tahaviimisel',
    takebackTime: 'Valmisasendist tabamuseni',
    hitchCount: 'Katkestused löögis',
    brushAngle: 'Harjamisnurk',
    contactStability: 'Pinna stabiilsus tabamusel',
    lateAcceleration: 'Hiline kiirendus (kaudne)',
    brakingTime: 'Pidurdusaeg',
    recovery: 'Taastumine',
    serveDrop: 'Reketi ots serveeri langetusel',
    serveContactTip: 'Reketi ots tabamusel',
    serveRoll: 'Reketi veerenurk',
    forwardSwing: 'Ettelöök',
    followThrough: 'Lõpetus',
  },
  reason: {
    'no-contact': 'Palli tabamust ei olnud',
    'signal-gap': 'Selle löögi andmetes on lünk',
    'no-value': 'Näit puudub',
    'no-sigma': 'Mõõtemääramatus teadmata',
    saturated: 'Andur küllastus, väärtus on vaid piir',
    'no-baseline': 'Võrdlust veel pole: isiklik baas alles koguneb',
    'wrong-stroke': 'Selle löögi puhul ei kehti',
  },
  live: {
    better: 'Paremini',
    thatsIt: 'Just nii',
    good: 'Hea',
    counted: 'Löök loetud',
    voice: 'Hääl',
    overcorrected: 'Liiga palju – veidi vähem',
    consistency: 'Iga kord sama löök',
    fatigue: 'Tee väike paus',
    stuck: 'Proovi harjutust',
    detail: {
      'ladder-sparse': 'Märkust öeldakse nüüd harvem: proovi allolevat harjutust.',
      oscillation: 'Vead kõiguvad vastassuundade vahel: püüa lüüa iga kord ühtemoodi.',
      'fatigue-hold': 'Tundub, et oled väsinud: uusi parandusi praegu ei tule.',
      contradiction: 'Eelmise märkuse järel liiga palju teisele poole.',
      'no-contact': 'Palli tabamust ei tuvastatud.',
      'not-assessable': 'Selle löögi hindamiseks on andmeid veel liiga vähe.',
      'focus-not-assessable': 'Fookust ei saanud sellel löögil hinnata.',
      'repeat-pause': 'Sama märkust ei korrata: väike paus.',
      'focus-holding': 'Fookus on korras. Hoia samas vaimus.',
      'no-faults': 'Vigu ei leitud.',
    },
    why: 'Miks',
    change: 'Muuda',
    drill: 'Harjutus',
    focus: 'Fookus',
    noFocus: 'Fookust veel pole',
    focusOk: 'sellel löögil korras',
    focusNotAssessed: 'sellel löögil hindamata',
    confidence: (percent) => `Kindlus ${percent}%`,
    comparedPersonal: (n) => `Võrdlus: sinu tavaline löök (${n} lööki)`,
    comparedPopulation: 'Võrdlus: viitepiirid',
    comparedCombined: (n) => `Võrdlus: sinu tavaline löök (${n} lööki) ja viitepiirid`,
    baselineLoading: 'Laen isiklikku baasi…',
    baselineProgress: (n, needed) => `Isiklik baas: ${n}/${needed} lööki`,
    limit: 'Piir',
    fatigueBadge: 'Väsinud',
    learning: 'Selgitus',
    matchSpoken: 'Pausi ajal öeldud',
    matchStrokes: 'Lööke',
  },
  profile: {
    title: 'Profiil',
    inputs: 'Sinust',
    change: 'Muuda seadetes',
    typical: 'Tavaline löök',
    typicalStrokes: (n) => `${n} lööki`,
    noTypical: 'Sinu tavaline löök ilmub pärast paari lööki.',
    weaknesses: 'Nõrkused',
    noWeaknesses: 'Püsivaid nõrkusi pole siiani.',
    sessionsN: (n) => `${n} trenni`,
    faultRate: 'vigu',
    trend: { improving: 'paraneb', stable: 'stabiilne', worsening: 'halveneb' },
    progress: 'Areng',
    noProgress: 'Areng ilmub pärast paari trenni.',
    sparkAria: (name, values) => `${name}: vigade osakaal trennis, ${values}`,
    sparkHint: 'Vigade osakaal trennis, vanimast uusimani. Väiksem on parem.',
    plan: 'Järgmise trenni plaan',
    noPlan: 'Plaan ilmub, kui nõrkus ilmneb.',
    volume: (sets, balls) => `${sets} × ${balls} palli`,
    bestCue: 'Kõige paremini aidanud märkus',
    target: (percent) => `Eesmärk: alla ${percent}% vigu`,
    targetKeep: (percent) => `Eesmärk: hoia alla ${percent}% vigu`,
    focusItem: 'Harjuta',
    maintenance: 'Hoia samas vaimus',
    drill: 'Harjutus',
    empty: 'Profiil täitub pärast paari trenni.',
    basedOn: (n) => `Põhineb sinu viimasel ${n} hinnatud löögil.`,
  },
  faceGauge: { open: 'avatud', closed: 'suletud', label: 'Reketipind tabamusel, küljelt vaadates' },
  session: {
    title: 'Trenn',
    strokes: (n, unrated) => `${n} lööki${unrated ? `, neist ${unrated} ilma mõõtmiseta` : ''}.`,
    spread:
      '„±“ on hajuvus: mida väiksem, seda ühtlasemad löögid. Slice’id on keskmistest välja jäetud.',
    focusTitle: 'Fookus',
    noFocus: 'Praegu fookust pole. Fookus valitakse, kui sama viga kordub selgelt.',
    good: 'Korras',
    corrections: 'Sagedasemad parandused',
    noCorrections: 'Parandusi ei antud.',
    counted: (n) => `${n} lööki loetud`,
    betterTimes: (n) => `„Paremini“ ${n}×`,
    thatsItTimes: (n) => `„Just nii“ ${n}×`,
    focusNow: 'Praegune fookus',
    exportCsv: 'Ekspordi CSV',
    exportRaw: 'Ekspordi toorandmed',
    newSession: 'Uus trenn',
    diagnostics: 'Diagnostika',
    categoriesTitle: 'Löögid hinnangu järgi',
    feedbackTitle: 'Antud tagasiside',
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
    learningMode: 'Õppimine: märkus koos lühikese selgitusega',
    trainingMode: 'Treening: üks lühike märkus löögi kohta',
    matchMode: 'Mäng: vaikne, ainult püsiv suur viga punktide vahel',
    player: 'Mängija',
    dominantHand: 'Mängiv käsi',
    handRight: 'Parem',
    handLeft: 'Vasak',
    backhand: 'Backhand',
    twoHanded: 'Kahe käega',
    oneHanded: 'Ühe käega',
    forehandStyle: 'Forehandi stiil',
    styleTopspin: 'Topspin',
    styleFlat: 'Lame',
    styleMixed: 'Segatud',
    level: 'Tase',
    levelBeginner: 'Algaja (vähem ja põhilisemad märkused)',
    levelIntermediate: 'Keskmine',
    levelAdvanced: 'Edasijõudnu',
    speakGood: 'Ütle „Good“, kui parandada pole midagi',
    speechRate: 'Kõne kiirus',
    language: 'Selgituste keel (hääl on inglise keeles)',
    model: 'Mudel',
    lever: 'Hoova pikkus (pöördekeskmest tabamispunktini)',
    leverHint:
      'Mõjutab ainult reketi kiiruse hinnangut (vaikimisi 0,72 m). Nurgad sellest ei sõltu.',
    firmware: 'Püsivara',
    protocol: 'protokoll',
    engine: 'Treeneri mootor',
    confidenceInfo: (percent) =>
      `Märkus tehakse alles siis, kui viga on vähemalt ${percent}% kindel. Seda piiri ei saa muuta.`,
    baseline: 'Isiklik baas',
    baselineInfo: (needed) =>
      `Sinu tavaline löök, millega uusi lööke võrreldakse. Baas hakkab kehtima ${needed} löögist iga löögiliigi kohta.`,
    baselineCount: (stroke, n, needed) =>
      n >= needed ? `${stroke}: ${n} lööki (kasutusel)` : `${stroke}: ${n}/${needed} lööki`,
    baselineLoading: 'Laen…',
    resetBaseline: 'Lähtesta isiklik baas',
    resetConfirm:
      'Lähtestada isiklik baas? Vanu lööke enam ei kasutata, salvestatud andmed jäävad alles.',
    resetDone: (date) => `Viimati lähtestatud ${date}.`,
    sensor: 'Andur',
    experimentalM416: 'Katseline: güroskoop 416 Hz löögi ümber (M416)',
    experimentalM416Hint:
      'Vajab püsivara 0.2 või uuemat. Riistvaral kontrollimata; vaikimisi on 104 Hz (M104).',
    temperatureChanged: 'Temperatuur on kalibreerimisest muutunud, kalibreeri uuesti.',
    diagnostics: 'Diagnostika',
    diagnosticsLine: (d) =>
      `režiim ${d.mode} · P ${d.payloadBytes} B · FIFO ületäitumisi ${d.fifoOverruns} · kadunud lööke ${d.droppedCaptures} · vigu ${d.errors} · vaba mälu ${d.freeVars}`,
  },
};

const STRINGS: Record<Language, Strings> = { en, et };

export const strings = (language: Language): Strings => STRINGS[language];

/** Localised cue title for a rule id, falling back to the English spoken cue text. */
export const cueLabel = (t: Strings, ruleId: string, fallback: string): string =>
  t.cueTitle[ruleId] ?? fallback;
