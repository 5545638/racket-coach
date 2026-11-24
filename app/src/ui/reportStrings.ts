import type { CorrectionId } from '../coaching/corrections';
import type { Language } from '../coaching/guidance';
import type { StrokeVerdict } from '../coaching/strokeFacts';
import type { CoachMode, StrokeType } from '../domain/types';

/** Texts of the session report and the history charts (Estonian and English). */
export interface ReportStrings {
  readonly mode: Record<CoachMode, string>;
  readonly modeLabel: string;
  readonly durationLabel: string;
  readonly minutes: (m: number) => string;
  readonly hours: (h: number, m: number) => string;
  readonly noStrokes: string;
  readonly totals: { readonly all: string } & Record<StrokeType, string>;
  readonly speedTitle: string;
  readonly estimate: string;
  readonly speedNote: string;
  readonly lowerBound: string;
  readonly noSpeed: string;
  readonly consistencyTitle: string;
  readonly consistencyNote: string;
  readonly basedOn: (n: number) => string;
  readonly tooFew: string;
  readonly consistencyParts: {
    readonly face: string;
    readonly path: string;
    readonly speed: string;
  };
  readonly strengthsTitle: string;
  readonly strengthsEmpty: string;
  readonly inBand: (share: number, n: number) => string;
  readonly errorsTitle: string;
  readonly errorsEmpty: string;
  readonly errorShare: (share: number, n: number) => string;
  readonly improvementTitle: string;
  readonly tooFewStrokes: string;
  readonly firstHalf: string;
  readonly secondHalf: string;
  readonly improvementNote: string;
  readonly faultRate: string;
  readonly better: string;
  readonly worse: string;
  readonly same: string;
  readonly noHalfData: string;
  readonly focusTitle: string;
  readonly focusEmpty: string;
  readonly focusFromSession: string;
  readonly drill: string;
  readonly detailsTitle: string;
  readonly verdictTitle: string;
  readonly verdict: Record<StrokeVerdict, string>;
  readonly feedbackTitle: string;
  readonly strength: Record<CorrectionId, string>;
  /* History */
  readonly historyTitle: string;
  readonly historyLoading: string;
  readonly historyEmpty: string;
  readonly historyNote: (n: number) => string;
  readonly strokesChart: string;
  readonly speedChart: string;
  readonly consistencyChart: string;
  readonly faultChart: string;
  readonly speedUnit: string;
  readonly tapHint: string;
  readonly noData: string;
  readonly chartAria: (title: string, points: string) => string;
  readonly strokesWord: string;
}

const et: ReportStrings = {
  mode: { learning: 'Õppimine', training: 'Treening', match: 'Mäng' },
  modeLabel: 'Režiim',
  durationLabel: 'Kestus',
  minutes: (m) => `${m} min`,
  hours: (h, m) => `${h} h ${String(m).padStart(2, '0')} min`,
  noStrokes: 'Selles trennis pole veel lööke. Tee mõni löök, siis ilmub aruanne.',
  totals: { all: 'Kokku', forehand: 'Forehand', backhand: 'Backhand', overhead: 'Serv' },
  speedTitle: 'Reketi kiirus',
  estimate: 'hinnang',
  speedNote: 'Hinnanguline reketi keskmine kiirus tabamusel, mitte palli kiirus.',
  lowerBound: 'alampiir: andur küllastus, tegelik kiirus on suurem',
  noSpeed: 'Kiirust ei saanud hinnata.',
  consistencyTitle: 'Ühtlus',
  consistencyNote:
    '0–100: löögitee, pinna nurga ja kiiruse hajuvus võrreldes mõõtetäpsusega. 100 = hajuvus on andurimüra tasemel.',
  basedOn: (n) => `põhineb ${n} löögil`,
  tooFew: 'liiga vähe lööke',
  consistencyParts: { face: 'pind', path: 'tee', speed: 'kiirus' },
  strengthsTitle: 'Tehnilised tugevused',
  strengthsEmpty:
    'Tugevusi pole veel selgunud: iga elemendi kohta on vaja vähemalt 10 hinnatud lööki.',
  inBand: (share, n) => `${Math.round(share * 100)}% löökidest normis · ${n} löögist`,
  errorsTitle: 'Sagedasemad vead',
  errorsEmpty: 'Korduvaid vigu ei olnud.',
  errorShare: (share, n) => `${Math.round(share * 100)}% hinnatud löökidest · ${n}×`,
  improvementTitle: 'Areng trenni jooksul',
  tooFewStrokes: 'liiga vähe lööke (vaja vähemalt 20)',
  firstHalf: '1. pool',
  secondHalf: '2. pool',
  improvementNote: 'Trenni esimene ja teine pool: vigade osakaal ja ühtlus.',
  faultRate: 'vigu',
  better: 'paranes',
  worse: 'halvenes',
  same: 'muutumatu',
  noHalfData: 'vähe andmeid',
  focusTitle: 'Järgmise trenni fookus',
  focusEmpty: 'Selget fookust veel pole. Tee rohkem lööke, et kavast saaks plaan.',
  focusFromSession: 'Selle trenni sagedasem viga. Profiili plaan täpsustub järgmistel trennidel.',
  drill: 'Harjutus',
  detailsTitle: 'Detailid löögitüübi kaupa',
  verdictTitle: 'Löögid hinnangu järgi',
  verdict: {
    correction: 'Parandus öeldud',
    'fault-silent': 'Viga, ei öeldud',
    style: 'Sinu stiil',
    uncertain: 'Ebakindel',
    'not-assessable': 'Hindamata',
    fatigue: 'Väsimus',
  },
  feedbackTitle: 'Antud tagasiside',
  strength: {
    'face-open': 'Reketi pind pole liiga avatud',
    'face-closed': 'Reketi pind pole liiga suletud',
    'slice-face-closed': 'Slice’i pind õiges asendis',
    'slice-chop': 'Slice ei lõika liiga järsult',
    'path-flat': 'Löögitee piisavalt madalalt üles',
    'path-steep': 'Löögitee pole liiga järsk',
    'accelerated-early': 'Tippkiirus tabamushetkel',
    'no-racket-drop': 'Reketi pea langeb enne lööki',
    'open-takeback': 'Pind tagahoos kontrolli all',
    hitch: 'Sujuv löök ilma pausita',
    'stiff-arm': 'Lõdv ranne, reket jõuab järele',
    'short-finish': 'Täispikk lõpetus',
    'late-preparation': 'Ettevalmistus õigel ajal',
    'small-turn': 'Korralik keha pööre',
    'high-takeback': 'Tagahoog sobival kõrgusel',
    'unstable-contact': 'Reket stabiilne tabamusel',
    'slow-recovery': 'Kiire taastumine',
    'serve-no-drop': 'Serval on reketi langetus',
    'serve-low-contact': 'Serva tabamus piisavalt kõrgel',
    'serve-no-pronation': 'Serval reketi ülepööramine',
    'serve-accelerated-early': 'Serva tippkiirus õigel hetkel',
    'serve-hitch': 'Serv sujuv, ilma pausita',
    'serve-short-finish': 'Serva täispikk lõpetus',
  },
  historyTitle: 'Ajalugu',
  historyLoading: 'Laen varasemaid trenne…',
  historyEmpty: 'Ajalugu ilmub, kui on salvestatud vähemalt üks trenn löö←gidega.',
  historyNote: (n) => `Viimased ${n} trenni, vanemad vasakul.`,
  strokesChart: 'Lööke trennis',
  speedChart: 'Keskmine kiirus (hinnang)',
  consistencyChart: 'Ühtlus (0–100)',
  faultChart: 'Vigade osakaal sagedasemate nõrkuste kaupa',
  speedUnit: 'km/h',
  tapHint: 'Puuduta punkti, et näha väärtust.',
  noData: 'andmeid pole',
  chartAria: (title, points) => `${title}: ${points}`,
  strokesWord: 'lööki',
};

const en: ReportStrings = {
  mode: { learning: 'Learning', training: 'Training', match: 'Match' },
  modeLabel: 'Mode',
  durationLabel: 'Duration',
  minutes: (m) => `${m} min`,
  hours: (h, m) => `${h} h ${String(m).padStart(2, '0')} min`,
  noStrokes: 'No strokes in this session yet. Hit a few and the report appears.',
  totals: { all: 'Total', forehand: 'Forehand', backhand: 'Backhand', overhead: 'Serve' },
  speedTitle: 'Racket speed',
  estimate: 'estimate',
  speedNote: 'Estimated mean racket speed at contact, not ball speed.',
  lowerBound: 'lower bound: the sensor saturated, the real speed is higher',
  noSpeed: 'Speed could not be estimated.',
  consistencyTitle: 'Consistency',
  consistencyNote:
    '0–100: spread of swing path, face angle and speed against the measurement noise. 100 = spread at sensor-noise level.',
  basedOn: (n) => `based on ${n} strokes`,
  tooFew: 'too few strokes',
  consistencyParts: { face: 'face', path: 'path', speed: 'speed' },
  strengthsTitle: 'Technical strengths',
  strengthsEmpty: 'No strengths yet: each element needs at least 10 judged strokes.',
  inBand: (share, n) => `${Math.round(share * 100)}% of strokes in range · ${n} strokes`,
  errorsTitle: 'Most frequent errors',
  errorsEmpty: 'No repeated errors.',
  errorShare: (share, n) => `${Math.round(share * 100)}% of judged strokes · ${n}×`,
  improvementTitle: 'Progress within the session',
  tooFewStrokes: 'too few strokes (20 needed)',
  firstHalf: '1st half',
  secondHalf: '2nd half',
  improvementNote: 'First against second half of the session: fault rate and consistency.',
  faultRate: 'faults',
  better: 'improved',
  worse: 'got worse',
  same: 'unchanged',
  noHalfData: 'little data',
  focusTitle: 'Focus for the next session',
  focusEmpty: 'No clear focus yet. Hit more strokes to get a plan.',
  focusFromSession:
    'The most frequent fault in this session. The profile plan sharpens over the next sessions.',
  drill: 'Drill',
  detailsTitle: 'Details by stroke type',
  verdictTitle: 'Strokes by reading',
  verdict: {
    correction: 'Correction given',
    'fault-silent': 'Fault, not spoken',
    style: 'Your style',
    uncertain: 'Unsure',
    'not-assessable': 'Not judged',
    fatigue: 'Fatigue',
  },
  feedbackTitle: 'Feedback given',
  strength: {
    'face-open': 'Racket face not too open',
    'face-closed': 'Racket face not too closed',
    'slice-face-closed': 'Slice face well set',
    'slice-chop': 'Slice not chopped too steeply',
    'path-flat': 'Swing path rises enough',
    'path-steep': 'Swing path not too steep',
    'accelerated-early': 'Peak speed at contact',
    'no-racket-drop': 'Racket head drops before the swing',
    'open-takeback': 'Face under control in the take-back',
    hitch: 'Smooth swing without a pause',
    'stiff-arm': 'Relaxed wrist, racket whips through',
    'short-finish': 'Full finish',
    'late-preparation': 'Preparation on time',
    'small-turn': 'Good body turn',
    'high-takeback': 'Take-back at a good height',
    'unstable-contact': 'Steady racket at contact',
    'slow-recovery': 'Quick recovery',
    'serve-no-drop': 'Racket drop on the serve',
    'serve-low-contact': 'Serve contact high enough',
    'serve-no-pronation': 'Racket turns over on the serve',
    'serve-accelerated-early': 'Serve peaks at the right moment',
    'serve-hitch': 'Smooth serve, no pause',
    'serve-short-finish': 'Full serve finish',
  },
  historyTitle: 'History',
  historyLoading: 'Loading earlier sessions…',
  historyEmpty: 'History appears once at least one session with strokes is saved.',
  historyNote: (n) => `Last ${n} sessions, oldest on the left.`,
  strokesChart: 'Strokes per session',
  speedChart: 'Average speed (estimate)',
  consistencyChart: 'Consistency (0–100)',
  faultChart: 'Fault rate of the most frequent weaknesses',
  speedUnit: 'km/h',
  tapHint: 'Tap a point to see its value.',
  noData: 'no data',
  chartAria: (title, points) => `${title}: ${points}`,
  strokesWord: 'strokes',
};

export const reportStrings = (language: Language): ReportStrings => (language === 'et' ? et : en);
