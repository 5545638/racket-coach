import type { Language } from '../coaching/guidance';

/** Texts of the redesigned training (live) screen. */
export interface TrainingStrings {
  readonly strokeType: {
    readonly forehand: string;
    readonly backhand: string;
    readonly overhead: string;
  };
  readonly verdict: {
    readonly good: string;
    readonly correction: string;
    readonly uncertain: string;
    readonly notRated: string;
  };
  readonly empty: { readonly title: string; readonly hint: string };
  readonly mode: {
    readonly learning: string;
    readonly training: string;
    readonly match: string;
    readonly pick: string;
  };
  readonly mute: string;
  readonly unmute: string;
  readonly battery: (percent: number) => string;
  readonly strip: {
    readonly label: string;
    readonly forehand: string;
    readonly backhand: string;
    readonly serve: string;
    readonly last: string;
    readonly average: string;
    readonly good: string;
  };
  readonly details: string;
  readonly baselineNote: string;
  readonly whyHow: string;
  readonly spoken: string;
  readonly strokeNo: (n: number) => string;
}

const et: TrainingStrings = {
  strokeType: { forehand: 'FOREHAND', backhand: 'BACKHAND', overhead: 'SERV' },
  verdict: { good: 'Hea', correction: 'Paranda', uncertain: 'Ebakindel', notRated: 'Hindamata' },
  empty: {
    title: 'Löö esimene pall',
    hint: 'Pärast esimest lööki ilmub siia löögi tüüp ja märkus. Ekraani ei pea puutuma.',
  },
  mode: {
    learning: 'Õppimine',
    training: 'Treening',
    match: 'Mäng',
    pick: 'Vali režiim',
  },
  mute: 'Vaigista hääl',
  unmute: 'Lülita hääl sisse',
  battery: (p) => `Aku ${p}%`,
  strip: {
    label: 'Trenni kokkuvõte',
    forehand: 'FH',
    backhand: 'BH',
    serve: 'Serv',
    last: 'Viimane',
    average: 'Keskmine',
    good: 'Head',
  },
  details: 'Detailid',
  baselineNote: 'Võrdlust veel pole: isiklik baas alles koguneb',
  whyHow: 'Miks ja kuidas',
  spoken: 'Hääl',
  strokeNo: (n) => `#${n}`,
};

const en: TrainingStrings = {
  strokeType: { forehand: 'FOREHAND', backhand: 'BACKHAND', overhead: 'SERVE' },
  verdict: { good: 'Good', correction: 'Fix', uncertain: 'Unsure', notRated: 'Not rated' },
  empty: {
    title: 'Hit the first ball',
    hint: 'After the first stroke its type and cue appear here. No need to touch the screen.',
  },
  mode: {
    learning: 'Learning',
    training: 'Training',
    match: 'Match',
    pick: 'Choose mode',
  },
  mute: 'Mute voice',
  unmute: 'Unmute voice',
  battery: (p) => `Battery ${p}%`,
  strip: {
    label: 'Session summary',
    forehand: 'FH',
    backhand: 'BH',
    serve: 'Serve',
    last: 'Last',
    average: 'Average',
    good: 'Good',
  },
  details: 'Details',
  baselineNote: 'No reference yet: personal baseline still building',
  whyHow: 'Why and how',
  spoken: 'Voice',
  strokeNo: (n) => `#${n}`,
};

export const trainingStrings = (language: Language): TrainingStrings =>
  language === 'et' ? et : en;
