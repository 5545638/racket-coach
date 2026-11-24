import type { Language } from './guidance';

/**
 * Correction catalogue: the on-screen and spoken texts for every technique
 * correction the coaching engine can issue.
 *
 * Rules for the wording (the sensor is one IMU in the racket butt cap):
 * - `explanation` only says what the racket showed (rotation, orientation,
 *   timing, speed). It never claims to have measured grip pressure, the elbow,
 *   the shoulders, the wrist angle, the feet or the contact point relative to
 *   the body.
 * - `adjustment` and `drill` may tell the player what to do with the body.
 * - Where a stroke is compared with the player's own usual strokes, the
 *   explanation says "than your usual stroke".
 * - `spoken` is English, imperative, short, and identical in both languages.
 */
export type CorrectionId =
  | 'face-open'
  | 'face-closed'
  | 'slice-face-closed'
  | 'slice-chop'
  | 'path-flat'
  | 'path-steep'
  | 'accelerated-early'
  | 'no-racket-drop'
  | 'open-takeback'
  | 'hitch'
  | 'stiff-arm'
  | 'short-finish'
  | 'late-preparation'
  | 'small-turn'
  | 'high-takeback'
  | 'unstable-contact'
  | 'slow-recovery'
  | 'serve-no-drop'
  | 'serve-low-contact'
  | 'serve-no-pronation'
  | 'serve-accelerated-early'
  | 'serve-hitch'
  | 'serve-short-finish';

export interface CorrectionText {
  /** English cue spoken through the earphones (max 4 words, imperative). */
  readonly spoken: string;
  /**
   * Escalating English cues (max 5 words each). Variant 0 equals `spoken`;
   * variant 1 is a different angle for when 0 did not work after a few
   * strokes; variant 2 is a third, preferably external-focus or image cue.
   */
  readonly spokenVariants: readonly [string, string, string];
  /** English, max 6 words, spoken when the player fixed the problem. */
  readonly reinforce: string;
  /** One English sentence (max 14 words) for learning mode: the why/how. */
  readonly learningSpoken: string;
  /** On-screen name of the weakness in the player profile. */
  readonly weaknessLabel: string;
  /** What the racket showed and why it matters (max 2 sentences). */
  readonly explanation: string;
  /** The concrete change for the next ball (1-2 sentences). */
  readonly adjustment: string;
  /** One safe drill (1-2 sentences). */
  readonly drill: string;
  /** Short on-screen name. */
  readonly title: string;
}

/** Spoken feedback after a corrected stroke. */
export const FEEDBACK_PHRASES = {
  better: 'Better',
  keepIt: "That's it",
  overcorrected: 'A little less',
  consistency: 'Same swing every time',
  fatigue: 'Take a short break',
  stuck: 'Try the drill',
} as const;

/** On-screen titles for the spoken feedback phrases. */
export const FEEDBACK_LABELS: Record<Language, Record<keyof typeof FEEDBACK_PHRASES, string>> = {
  et: {
    better: 'Parem löök („Better“)',
    keepIt: "Just nii, hoia seda („That's it“)",
    overcorrected: 'Parandasid üle („A little less“)',
    consistency: 'Iga kord sama löök („Same swing every time“)',
    fatigue: 'Tee lühike paus („Take a short break“)',
    stuck: 'Proovi harjutust („Try the drill“)',
  },
  en: {
    better: 'Better stroke (“Better”)',
    keepIt: "Keep it (“That's it”)",
    overcorrected: 'Overcorrected (“A little less”)',
    consistency: 'Consistency (“Same swing every time”)',
    fatigue: 'Fatigue (“Take a short break”)',
    stuck: 'Stuck (“Try the drill”)',
  },
};

type BaseText = Omit<
  CorrectionText,
  'spokenVariants' | 'reinforce' | 'learningSpoken' | 'weaknessLabel'
>;

const EN_BASE: Record<CorrectionId, BaseText> = {
  'face-open': {
    spoken: 'Face too open',
    title: 'Racket face too open',
    explanation:
      'At contact the strings pointed upwards more than they should, so the ball tends to fly long or float.',
    adjustment:
      'Aim the ball a little lower over the net, just above the tape, and let the racket keep moving forward after contact.',
    drill: 'Feed 20 easy balls and aim to land them inside the service line with full swings.',
  },
  'face-closed': {
    spoken: 'Face too closed',
    title: 'Racket face too closed',
    explanation:
      'At contact the strings pointed downwards more than they should, so the ball tends to dive into the net.',
    adjustment: 'Aim the ball higher over the net and meet it further in front of you.',
    drill:
      'Rally to a target one metre above the net tape; count how many of 20 balls clear that target.',
  },
  'slice-face-closed': {
    spoken: 'Open the face for the slice',
    title: 'Slice face too closed',
    explanation:
      'On a slice the strings should point slightly upwards at contact; here they pointed down, so the ball dives.',
    adjustment: 'Send the ball out slightly higher and let it ride on the strings for a moment.',
    drill: 'Slice from the service line and make the ball float deep with backspin.',
  },
  'slice-chop': {
    spoken: 'Slice through the ball, not down',
    title: 'Slice chopped too steeply',
    explanation:
      'The racket travelled steeply downwards into the ball: plenty of backspin, but the ball sits up short.',
    adjustment: 'Swing more forwards than down, towards the target.',
    drill: 'Slice so the ball skids low past the service line; steep chops will bounce up.',
  },
  'path-flat': {
    spoken: 'Swing low to high',
    title: 'Swing path too flat',
    explanation:
      'The racket travelled almost level through the ball, which gives little topspin and little margin over the net.',
    adjustment: 'Start the forward swing below the ball and finish above your shoulder.',
    drill: 'Brush up the back of the ball from the service line; let it loop over the net.',
  },
  'path-steep': {
    spoken: 'Drive through the ball',
    title: 'Swing path too steep',
    explanation:
      'The racket travelled almost straight up through the ball, which gives lots of spin but little depth or pace.',
    adjustment: 'Send the racket out towards the target before it rises.',
    drill:
      'Lay three balls or cones in a line towards the target and swing out along that line before the racket rises.',
  },
  'accelerated-early': {
    spoken: 'Accelerate through contact',
    title: 'Racket peaked too early',
    explanation:
      'The racket reached its top speed well before contact and was already slowing down when it met the ball, so speed was wasted.',
    adjustment: 'Start the swing smoother and save the fastest part for contact and just after it.',
    drill: 'Swing at 60 % effort and listen for the whoosh in front of your body, not beside it.',
  },
  'no-racket-drop': {
    spoken: 'Drop the racket head',
    title: 'No racket drop',
    explanation:
      'The racket tip stayed high before the forward swing, so there was no room to swing up from and the swing path suffers.',
    adjustment:
      'Let the racket head fall below your hand at the end of the take-back, then swing up.',
    drill: 'Shadow swings: pause with the tip pointing at the ground behind you, then swing.',
  },
  'open-takeback': {
    spoken: 'Face down on the take-back',
    title: 'Face open on the take-back',
    explanation:
      'The strings faced the sky at the bottom of the take-back, so the face has to be corrected on the way up.',
    adjustment: 'Keep the strings facing the ground as the racket drops ("pat the dog").',
    drill: 'Shadow swings in front of a mirror, checking the face at the lowest point.',
  },
  hitch: {
    spoken: 'Keep the swing flowing',
    title: 'Pause in the swing',
    explanation:
      'The racket paused between the take-back and the forward swing, which wastes momentum.',
    adjustment: 'Make one continuous loop: back, down and up without a stop.',
    drill: 'Count "one-and-two" through the swing; no pause on "and".',
  },
  'stiff-arm': {
    spoken: 'Loosen the wrist',
    title: 'Loosen the wrist',
    explanation:
      "This is an indirect proxy, not a wrist measurement: the sensor only sees how much of the racket's speed was gained in the last 50 ms before contact. Little late gain means the racket moved with the arm instead of lagging and whipping through, which can go with a tight wrist.",
    adjustment: 'Stay relaxed through the swing and let the wrist firm up only at contact.',
    drill:
      'Shadow swings, alternating deliberately stiff and deliberately relaxed ones to feel the difference; then slow feeds with the relaxed version.',
  },
  'short-finish': {
    spoken: 'Finish your swing',
    title: 'Short finish',
    explanation: 'The racket stopped soon after contact instead of carrying on through the finish.',
    adjustment: 'Let the racket finish over the opposite shoulder; do not brake it.',
    drill: 'Catch the racket with your other hand at the end of every swing.',
  },
  'late-preparation': {
    spoken: 'Prepare earlier',
    title: 'Late preparation',
    explanation:
      'The racket started its take-back later before contact than in your usual stroke, so there was less time to swing smoothly.',
    adjustment:
      'Start turning and take the racket back as soon as you see which side the ball is coming to.',
    drill:
      'Shadow swings with a partner pointing left or right: turn the racket back at once, before they finish the signal.',
  },
  'small-turn': {
    spoken: 'Turn earlier',
    title: 'Small turn',
    explanation:
      'During the take-back the racket turned less about the vertical than in your usual stroke. The sensor sees only the racket, not how much your body turned.',
    adjustment: 'Turn your shoulders sideways to the net as the racket goes back.',
    drill:
      'Shadow swings, turning until your back shoulder points at the net and holding for a moment before swinging.',
  },
  'high-takeback': {
    spoken: 'Keep it compact',
    title: 'Take-back too high',
    explanation:
      'At the end of the take-back the racket tip was higher than in your usual stroke, which makes the loop bigger and the timing harder.',
    adjustment: 'Take the racket back to about head height or lower and keep the loop small.',
    drill:
      'Shadow swings with a fence or wall about a metre behind you; take back without touching it.',
  },
  'unstable-contact': {
    spoken: 'Steady through contact',
    title: 'Unsteady racket at contact',
    explanation:
      'The racket face was rotating a lot just before contact, so the ball is likely to go in an unpredictable direction.',
    adjustment:
      'Hold the racket steady and swing through the ball towards the target; do not flick at it.',
    drill:
      'Hit 20 slow balls at half pace and keep the strings pointing at the target for as long as you can after contact.',
  },
  'slow-recovery': {
    spoken: 'Recover faster',
    title: 'Slow recovery',
    explanation:
      'After the finish the racket took longer to come back to the ready position than in your usual stroke.',
    adjustment: 'Bring the racket back in front of you at once and take a split step.',
    drill:
      'After each shot, return the racket to the ready position and count to one before the next ball.',
  },
  'serve-no-drop': {
    spoken: 'Drop the racket',
    title: 'No racket drop on the serve',
    explanation:
      'The racket did not drop low behind your back before the upward swing, so it has less distance to speed up.',
    adjustment:
      'Let the racket head fall behind your back, like scratching your back, before swinging up.',
    drill:
      'Slow serve motions without a ball: pause at the lowest point behind your back, then swing up.',
  },
  'serve-low-contact': {
    spoken: 'Reach up',
    title: 'Contact too low',
    explanation:
      'At contact the racket tip was lower than in your usual serve, which suggests the ball was hit below your best height.',
    adjustment: 'Toss slightly higher and stretch up to meet the ball at full reach.',
    drill:
      'Serve 10 balls with the aim of hitting the ball at the top of your reach, then check the toss height.',
  },
  'serve-no-pronation': {
    spoken: 'Turn the racket over',
    title: 'Racket not turned over',
    explanation:
      'Around contact the racket rotated less about its own long axis than in your usual serve. The sensor sees only this rotation of the racket and cannot tell forearm pronation from shoulder internal rotation.',
    adjustment:
      'After contact let the racket turn over so the strings face away from you, instead of stopping the rotation.',
    drill:
      'Serve from the service line at half pace and let the racket turn over fully into the finish.',
  },
  'serve-accelerated-early': {
    spoken: 'Accelerate through contact',
    title: 'Serve peaked too early',
    explanation:
      'The racket reached its top speed well before contact and was already slowing down when it met the ball.',
    adjustment:
      'Stay relaxed in the early part of the swing and speed up the racket towards contact.',
    drill: 'Serve at 60 % effort and listen for the whoosh at the top, above you, not behind you.',
  },
  'serve-hitch': {
    spoken: 'Keep the swing flowing',
    title: 'Pause in the serve',
    explanation:
      'The racket paused during the take-back and drop, which breaks the rhythm and wastes momentum.',
    adjustment:
      'Make the motion one continuous swing from the start to the drop and up to the ball.',
    drill:
      'Serve motions without a ball, saying "one-two" slowly to match a smooth rhythm without a pause.',
  },
  'serve-short-finish': {
    spoken: 'Finish your swing',
    title: 'Short serve finish',
    explanation: 'The racket stopped soon after contact instead of carrying on through the finish.',
    adjustment: 'Let the racket swing down across your body after contact; do not brake it.',
    drill: 'Serve without a ball and finish with the racket by your opposite hip every time.',
  },
};

const ET_BASE: Record<CorrectionId, BaseText> = {
  'face-open': {
    spoken: EN_BASE['face-open'].spoken,
    title: 'Reketi pind liiga avatud',
    explanation:
      'Tabamuse hetkel olid keeled rohkem üles suunatud kui vaja, seepärast läheb pall kergesti pikaks või jääb hõljuma.',
    adjustment:
      'Sihi pall võrgu kohal veidi madalamale, lindi lähedale, ja lase reketil pärast tabamust edasi liikuda.',
    drill: 'Sööda 20 kerget palli ja löö need täishooga teenindusjoone sisse.',
  },
  'face-closed': {
    spoken: EN_BASE['face-closed'].spoken,
    title: 'Reketi pind liiga suletud',
    explanation:
      'Tabamuse hetkel olid keeled rohkem alla suunatud kui vaja, seepärast läheb pall kergesti võrku.',
    adjustment: 'Sihi pall võrgu kohal kõrgemale ja taba see rohkem enda ees.',
    drill:
      'Löö sihtmärki, mis on meeter võrgulindist kõrgemal; loe 20 löögist kokku, mitu palli läks sellest sihtmärgist kõrgemalt üle.',
  },
  'slice-face-closed': {
    spoken: EN_BASE['slice-face-closed'].spoken,
    title: "Slice'i pind liiga suletud",
    explanation:
      "Slice'i puhul peavad keeled tabamusel olema veidi üles suunatud; siin olid need alla, seepärast pall sukeldub.",
    adjustment: 'Saada pall veidi kõrgemale ja lase sel hetkeks keelte peal kanduda.',
    drill: "Löö slice'i teenindusjoonelt nii, et pall hõljub tagasipöörlemisega sügavale.",
  },
  'slice-chop': {
    spoken: EN_BASE['slice-chop'].spoken,
    title: 'Slice liiga järsult alla',
    explanation:
      'Reket liikus palli kaudu järsult allapoole: palju tagasipöörlemist, aga pall jääb lühikeseks ja kõrgeks.',
    adjustment: 'Löö rohkem ette kui alla, sihtmärgi suunas.',
    drill:
      "Löö slice'i nii, et pall libiseb madalalt üle teenindusjoone; järsk raiumine põrkab üles.",
  },
  'path-flat': {
    spoken: EN_BASE['path-flat'].spoken,
    title: 'Löögitee liiga lame',
    explanation:
      'Reket liikus läbi palli peaaegu horisontaalselt, mis annab vähe topspinni ja väikese varu võrgu kohal.',
    adjustment: 'Alusta ettelööki pallist madalamalt ja lõpeta õla kohal.',
    drill: 'Harja teenindusjoonelt palli tagakülge üles ja lase pallil kaarega üle võrgu minna.',
  },
  'path-steep': {
    spoken: EN_BASE['path-steep'].spoken,
    title: 'Löögitee liiga järsk',
    explanation:
      'Reket liikus läbi palli peaaegu otse üles, mis annab palju spinni, aga vähe pikkust ja kiirust.',
    adjustment: 'Saada reket enne tõusu sihtmärgi suunas välja.',
    drill:
      'Pane kolm palli või koonust sihtmärgi suunas ritta ja lase reketil enne tõusu mööda seda joont edasi liikuda.',
  },
  'accelerated-early': {
    spoken: EN_BASE['accelerated-early'].spoken,
    title: 'Reketi tippkiirus liiga vara',
    explanation:
      'Reket saavutas tippkiiruse selgelt enne tabamust ja oli palli kohtamisel juba aeglustumas, seega läks osa kiirusest kaotsi.',
    adjustment:
      'Alusta löögi algust sujuvamalt ja hoia kiireim osa tabamuse ja sellele järgneva hetke jaoks.',
    drill: 'Löö 60% jõuga ja kuula, et „vihin“ kostaks keha ees, mitte küljel.',
  },
  'no-racket-drop': {
    spoken: EN_BASE['no-racket-drop'].spoken,
    title: 'Reketi pea ei lange',
    explanation:
      'Reketi tipp jäi enne ettelööki kõrgele, seega polnud kust üles lüüa ja löögitee kannatab.',
    adjustment: 'Lase tagahoo lõpus reketi pea käest madalamale vajuda ja löö siis üles.',
    drill: 'Varjulöögid: peata reket nii, et tipp näitab selja taga maha, ja löö sealt.',
  },
  'open-takeback': {
    spoken: EN_BASE['open-takeback'].spoken,
    title: 'Pind avatud tagahoos',
    explanation:
      'Tagahoo madalaimas punktis olid keeled taeva poole, mistõttu tuleb pinda teel üles korrigeerida.',
    adjustment: 'Hoia keeled reketi langemisel maa poole („patsuta koera“).',
    drill: 'Varjulöögid peegli ees: kontrolli pinda madalaimas punktis.',
  },
  hitch: {
    spoken: EN_BASE.hitch.spoken,
    title: 'Paus löögis',
    explanation: 'Reket jäi tagahoo ja ettelöögi vahel seisma, mistõttu hoog läheb kaotsi.',
    adjustment: 'Tee üks katkematu silmus: taha, alla ja üles ilma peatuseta.',
    drill: 'Loe löögi ajal „üks-ja-kaks“; „ja“ peal ei tohi pausi olla.',
  },
  'stiff-arm': {
    spoken: EN_BASE['stiff-arm'].spoken,
    title: 'Lõdvesta ranne',
    explanation:
      'See on kaudne näitaja, mitte randme mõõtmine: andur näeb ainult, kui suure osa reketi kiirusest sai see viimase 50 ms jooksul enne tabamust. Väike hiline kiirenemine tähendab, et reket liikus käega koos, selle asemel et maha jääda ja piitsana läbi tulla, mis võib käia pingulise randmega kaasas.',
    adjustment: 'Püsi löögi ajal lõdvana ja lase randmel kinnituda alles tabamuse hetkel.',
    drill:
      'Varjulöögid, kus vaheldumisi tahtlikult jäigalt ja tahtlikult lõdvalt, et vahet tunda; seejärel aeglased söödud pallid lõdva variandiga.',
  },
  'short-finish': {
    spoken: EN_BASE['short-finish'].spoken,
    title: 'Lühike lõpetus',
    explanation: 'Reket peatus kohe pärast tabamust, selle asemel et lõpetuseni liikuda.',
    adjustment: 'Lase reketil lõpetada vastasõla kohal; ära pidurda.',
    drill: 'Püüa iga löögi lõpus reket teise käega kinni.',
  },
  'late-preparation': {
    spoken: EN_BASE['late-preparation'].spoken,
    title: 'Hiline ettevalmistus',
    explanation:
      'Reket alustas tagahoogu tabamuse suhtes hiljem kui sinu tavalisel löögil, seega jäi sujuvaks hooks vähem aega.',
    adjustment: 'Hakka pöörama ja vii reket taha kohe, kui näed, kummale küljele pall tuleb.',
    drill:
      'Varjulöögid, kus partner näitab vasakule või paremale: vii reket kohe taha, enne kui ta märguande lõpetab.',
  },
  'small-turn': {
    spoken: EN_BASE['small-turn'].spoken,
    title: 'Väike pööre',
    explanation:
      'Tagahoo ajal pöördus reket vertikaaltelje ümber vähem kui sinu tavalisel löögil. Andur näeb ainult reketit, mitte seda, kui palju keha pöördus.',
    adjustment: 'Pööra õlad reketi taha minnes võrguga risti.',
    drill: 'Varjulöögid: pööra, kuni tagumine õlg näitab võrgu poole, ja hoia hetk enne löömist.',
  },
  'high-takeback': {
    spoken: EN_BASE['high-takeback'].spoken,
    title: 'Tagahoog liiga kõrge',
    explanation:
      'Tagahoo lõpus oli reketi tipp kõrgemal kui sinu tavalisel löögil, mistõttu silmus läheb suuremaks ja ajastus raskemaks.',
    adjustment: 'Vii reket taha umbes pea kõrgusele või madalamale ja hoia silmus väike.',
    drill:
      'Varjulöögid, kui piire või sein on umbes meetri sinu taga; tee tagahoog seda puudutamata.',
  },
  'unstable-contact': {
    spoken: EN_BASE['unstable-contact'].spoken,
    title: 'Reket rahutu tabamusel',
    explanation:
      'Reketi pind pöörles vahetult enne tabamust palju, mistõttu läheb pall tõenäoliselt ettearvamatus suunas.',
    adjustment: 'Hoia reket stabiilsena ja löö palli läbi sihtmärgi suunas; ära näpsa selle poole.',
    drill:
      'Löö 20 aeglast palli pooleldi tempoga ja hoia keeled pärast tabamust nii kaua kui võimalik sihtmärgi poole.',
  },
  'slow-recovery': {
    spoken: EN_BASE['slow-recovery'].spoken,
    title: 'Aeglane taastumine',
    explanation:
      'Pärast lõpetust jõudis reket valmisasendisse tagasi aeglasemalt kui sinu tavalisel löögil.',
    adjustment: 'Too reket kohe enda ette tagasi ja tee hüpe valmisasendisse.',
    drill: 'Vii reket pärast iga lööki valmisasendisse ja loe „üks“ enne järgmist palli.',
  },
  'serve-no-drop': {
    spoken: EN_BASE['serve-no-drop'].spoken,
    title: 'Reket ei lange servil',
    explanation:
      'Reket ei langenud enne ülespoole hoogu selja taha madalale, seega on kiirendamiseks vähem teed.',
    adjustment: 'Lase reketi pea selja taha langeda, nagu kratsiksid selga, ja löö siis üles.',
    drill:
      'Aeglased serviliigutused ilma pallita: peatu selja taga madalaimas punktis ja löö siis üles.',
  },
  'serve-low-contact': {
    spoken: EN_BASE['serve-low-contact'].spoken,
    title: 'Tabamus liiga madalal',
    explanation:
      'Tabamuse hetkel oli reketi tipp madalamal kui sinu tavalisel servil, mis viitab, et pall löödi sinu parimast kõrgusest madalamalt.',
    adjustment: 'Viska pall veidi kõrgemale ja sirutu pallile täies ulatuses vastu.',
    drill:
      'Serveeri 10 palli eesmärgiga lüüa pall oma ulatuse tipus, seejärel kontrolli viskekõrgust.',
  },
  'serve-no-pronation': {
    spoken: EN_BASE['serve-no-pronation'].spoken,
    title: 'Reket ei pöördu üle',
    explanation:
      'Tabamuse ümber pöördus reket oma pikitelje ümber vähem kui sinu tavalisel servil. Andur näeb ainult seda reketi pöörlemist ega erista küünarvarre pronatsiooni õla sisepöördest.',
    adjustment:
      'Lase reketil pärast tabamust üle pöörduda, nii et keeled vaatavad sinust eemale, ära peata pöörlemist.',
    drill:
      'Serveeri teenindusjoonelt pooleldi tempoga ja lase reketil lõpetuses täielikult üle pöörduda.',
  },
  'serve-accelerated-early': {
    spoken: EN_BASE['serve-accelerated-early'].spoken,
    title: 'Serv saavutas tipu liiga vara',
    explanation:
      'Reket saavutas tippkiiruse selgelt enne tabamust ja oli palli kohtamisel juba aeglustumas.',
    adjustment: 'Püsi hoo alguses lõdvana ja kiirenda reketit tabamuse suunas.',
    drill: 'Serveeri 60% jõuga ja kuula, et „vihin“ kostaks üleval, mitte taga.',
  },
  'serve-hitch': {
    spoken: EN_BASE['serve-hitch'].spoken,
    title: 'Paus servis',
    explanation: 'Reket peatus tagahoo ja languse ajal, mis rikub rütmi ja kaotab hoo.',
    adjustment: 'Tee liikumine üks katkematu hoog algusest languseni ja üles pallini.',
    drill:
      'Serviliigutused ilma pallita, öeldes aeglaselt „üks-kaks“, et rütm oleks sujuv ja ilma pausita.',
  },
  'serve-short-finish': {
    spoken: EN_BASE['serve-short-finish'].spoken,
    title: 'Lühike servi lõpetus',
    explanation: 'Reket peatus kohe pärast tabamust, selle asemel et lõpetuseni liikuda.',
    adjustment: 'Lase reketil pärast tabamust keha ees alla liikuda; ära pidurda.',
    drill: 'Serviliigutused ilma pallita, lõpetades iga kord reketiga vastaskoksa juures.',
  },
};

const EXTRA: Record<
  CorrectionId,
  {
    variants: readonly [string, string];
    reinforce: string;
    learningSpoken: string;
    weakness: { et: string; en: string };
  }
> = {
  'face-open': {
    variants: ['Tilt the face down', 'Send it just over tape'],
    reinforce: 'Good. Ball is staying in.',
    learningSpoken: 'Strings tilted up send the ball long, so aim lower.',
    weakness: { et: 'Reketi pind liiga avatud', en: 'Racket face too open' },
  },
  'face-closed': {
    variants: ['Tilt the face up', 'Lift it over the net'],
    reinforce: 'Good. That clears the net.',
    learningSpoken: 'Strings tilted down send the ball into the net, so aim higher.',
    weakness: { et: 'Reketi pind liiga suletud', en: 'Racket face too closed' },
  },
  'slice-face-closed': {
    variants: ['Strings slightly skyward', 'Let the ball ride'],
    reinforce: 'Good. Slice is floating now.',
    learningSpoken: 'A slightly open face lets the slice float instead of diving.',
    weakness: { et: "Slice'i pind suletud", en: 'Slice face too closed' },
  },
  'slice-chop': {
    variants: ['Swing forward, not down', 'Skid it low and long'],
    reinforce: 'Good. Forward, not down.',
    learningSpoken: 'Swinging forward keeps the slice low and deep instead of sitting up.',
    weakness: { et: 'Slice liiga järsult alla', en: 'Slice chopped too steeply' },
  },
  'path-flat': {
    variants: ['Start below the ball', 'Brush up the back'],
    reinforce: 'Good. Nice low-to-high path.',
    learningSpoken: 'Swinging low to high adds topspin and margin over the net.',
    weakness: { et: 'Lame löögitee', en: 'Flat swing path' },
  },
  'path-steep': {
    variants: ['Swing out before up', 'Send it toward the target'],
    reinforce: 'Good. Driving through the ball.',
    learningSpoken: 'Going out toward the target adds depth and pace to your spin.',
    weakness: { et: 'Järsk löögitee', en: 'Steep swing path' },
  },
  'accelerated-early': {
    variants: ['Keep the racket accelerating longer', 'Fastest after the ball'],
    reinforce: 'Good. Keep that acceleration.',
    learningSpoken: 'Your racket should be fastest at contact, not before it.',
    weakness: { et: 'Kiirendab liiga vara', en: 'Accelerates too early' },
  },
  'no-racket-drop': {
    variants: ['Let the tip fall', 'Tip toward the ground'],
    reinforce: 'Good. Racket head dropped nicely.',
    learningSpoken: 'Dropping the tip gives you room to swing up through the ball.',
    weakness: { et: 'Reketi pea ei lange', en: 'No racket drop' },
  },
  'open-takeback': {
    variants: ['Strings toward the ground', 'Pat the dog'],
    reinforce: 'Good. Face stays down.',
    learningSpoken: 'A face pointing down early needs no fixing on the way up.',
    weakness: { et: 'Avatud pind tagahoos', en: 'Face open on the take-back' },
  },
  hitch: {
    variants: ['One smooth loop', 'Swing like a pendulum'],
    reinforce: 'Good. Smooth, continuous swing.',
    learningSpoken: 'A pause wastes momentum, so one flowing loop gives more speed.',
    weakness: { et: 'Paus löögis', en: 'Pause in the swing' },
  },
  'stiff-arm': {
    variants: ['Loose arm, firm contact', 'Let the racket lag'],
    reinforce: 'Good. That felt loose.',
    learningSpoken: 'A loose arm lets the racket lag, then whip through the ball.',
    weakness: { et: 'Jäik löök', en: 'Stiff swing' },
  },
  'short-finish': {
    variants: ['Swing all the way through', 'Hold the finish'],
    reinforce: 'Good. Full finish.',
    learningSpoken: 'Finishing fully means you accelerate through the ball instead of braking.',
    weakness: { et: 'Lühike lõpetus', en: 'Short finish' },
  },
  'late-preparation': {
    variants: ['Racket back sooner', 'Ready before the bounce'],
    reinforce: 'Good. Early preparation.',
    learningSpoken: 'Early preparation gives you time for a smooth, unhurried swing.',
    weakness: { et: 'Hiline ettevalmistus', en: 'Late preparation' },
  },
  'small-turn': {
    variants: ['Turn sideways to the net', 'Show your back'],
    reinforce: 'Good. Full turn.',
    learningSpoken: 'A bigger turn stores more power and gives the swing more room.',
    weakness: { et: 'Väike pööre', en: 'Small turn' },
  },
  'high-takeback': {
    variants: ['Take it back shorter', 'Small, tidy loop'],
    reinforce: 'Good. Compact take-back.',
    learningSpoken: 'A smaller loop makes your timing simpler and more repeatable.',
    weakness: { et: 'Liiga kõrge tagahoog', en: 'Take-back too high' },
  },
  'unstable-contact': {
    variants: ["Swing, don't flick", 'Strings stay on target'],
    reinforce: 'Good. Steady through contact.',
    learningSpoken: 'A steady racket face sends the ball where you aim.',
    weakness: { et: 'Rahutu tabamus', en: 'Unsteady contact' },
  },
  'slow-recovery': {
    variants: ['Racket back in front', 'Split step, ready'],
    reinforce: 'Good. Quick recovery.',
    learningSpoken: 'Getting ready quickly prepares you for the next ball.',
    weakness: { et: 'Aeglane taastumine', en: 'Slow recovery' },
  },
  'serve-no-drop': {
    variants: ['Let it fall behind', 'Scratch your back'],
    reinforce: 'Good. Deep racket drop.',
    learningSpoken: 'A deeper drop gives the racket more distance to build speed.',
    weakness: { et: 'Reket ei lange servil', en: 'No racket drop on the serve' },
  },
  'serve-low-contact': {
    variants: ['Toss a bit higher', 'Hit at full height'],
    reinforce: 'Good. Reaching high.',
    learningSpoken: 'Hitting higher gives you a better angle and more margin over the net.',
    weakness: { et: 'Madal tabamus servil', en: 'Low contact on the serve' },
  },
  'serve-no-pronation': {
    variants: ['Strings face away after', 'Let it roll over'],
    reinforce: 'Good. Racket turned over.',
    learningSpoken: 'Turning the racket over adds speed and keeps the ball on target.',
    weakness: { et: 'Reket ei pöördu üle', en: 'Racket not turned over' },
  },
  'serve-accelerated-early': {
    variants: ['Speed up toward the ball', 'Fastest at the top'],
    reinforce: 'Good. Speed built toward contact.',
    learningSpoken: 'Building speed late puts the fastest racket moment at the ball.',
    weakness: { et: 'Serv kiirendab liiga vara', en: 'Serve accelerates too early' },
  },
  'serve-hitch': {
    variants: ['No pause, one motion', 'Say one, two'],
    reinforce: 'Good. Smooth serve rhythm.',
    learningSpoken: 'A smooth rhythm carries speed all the way up to the ball.',
    weakness: { et: 'Paus servis', en: 'Pause in the serve' },
  },
  'serve-short-finish': {
    variants: ['Follow through across you', 'Carry on past contact'],
    reinforce: 'Good. Full serve finish.',
    learningSpoken: 'Finishing across your body lets the racket keep speeding through contact.',
    weakness: { et: 'Lühike servi lõpetus', en: 'Short serve finish' },
  },
};

function build(
  lang: Language,
  base: Record<CorrectionId, BaseText>,
): Record<CorrectionId, CorrectionText> {
  const out = {} as Record<CorrectionId, CorrectionText>;
  for (const id of Object.keys(base) as CorrectionId[]) {
    const x = EXTRA[id];
    out[id] = {
      ...base[id],
      spokenVariants: [EN_BASE[id].spoken, x.variants[0], x.variants[1]],
      reinforce: x.reinforce,
      learningSpoken: x.learningSpoken,
      weaknessLabel: x.weakness[lang],
    };
  }
  return out;
}

const EN = build('en', EN_BASE);
const ET = build('et', ET_BASE);

export const CORRECTIONS: Record<Language, Record<CorrectionId, CorrectionText>> = {
  en: EN,
  et: ET,
};
