/** Languages for on-screen coaching text. Spoken cues are always English. */
export type Language = 'et' | 'en';

export interface Guidance {
  /** What the cue means, in plain words. */
  readonly meaning: string;
  /** What to do about it on the next ball. */
  readonly fix: string;
  /** A drill for the next session. */
  readonly drill: string;
}

/**
 * Coaching text per rule id. Kept as data, separate from the rule thresholds,
 * so wording can change without touching logic. Every rule in the default
 * rule set must have an entry in every language (enforced by a test).
 */
export const GUIDANCE: Record<Language, Record<string, Guidance>> = {
  en: {
    'face-open': {
      meaning: 'At contact the strings pointed up, so the ball may fly long or float.',
      fix: 'Aim the ball a little lower over the net, just above the tape, and let the racket keep moving forward after contact.',
      drill: 'Feed 20 easy balls and aim to land them inside the service line with full swings.',
    },
    'face-closed': {
      meaning: 'At contact the strings pointed down, so the ball dives into the net.',
      fix: 'Aim the ball higher over the net and meet it further in front of you.',
      drill:
        'Rally to a target one metre above the net tape; count how many of 20 balls clear that target.',
    },
    'slice-face-closed': {
      meaning:
        'On a slice the strings should point slightly up; here they pointed down, so the ball dives.',
      fix: 'Send the ball out slightly higher and let it ride on the strings for a moment.',
      drill: 'Slice from the service line and make the ball float deep with backspin.',
    },
    'slice-chop': {
      meaning: 'The racket chopped steeply down: lots of backspin but the ball sits up short.',
      fix: 'Swing more forwards than down, towards the target.',
      drill: 'Slice so the ball skids low past the service line; steep chops will bounce up.',
    },
    'not-rated': {
      meaning:
        'This stroke (serve, smash, volley or a short swing) is counted, but there are no reliable reference values to judge its technique yet.',
      fix: '',
      drill: '',
    },
    'path-flat': {
      meaning: 'The racket travelled level through the ball: little topspin and little margin.',
      fix: 'Start the forward swing below the ball and finish above your shoulder.',
      drill: 'Brush up the back of the ball from the service line; let it loop over the net.',
    },
    'no-racket-drop': {
      meaning:
        'The racket head stayed up before the forward swing, so there was nothing to swing up from.',
      fix: 'Let the head fall below your hand at the end of the backswing, then swing up.',
      drill: 'Shadow swings: pause with the tip pointing at the ground behind you, then swing.',
    },
    'path-steep': {
      meaning: 'The racket went almost straight up: lots of spin but no depth or pace.',
      fix: 'Send the racket out towards the target before it rises.',
      drill:
        'Lay three balls or cones in a line towards the target and swing out along that line before the racket rises.',
    },
    'accelerated-early': {
      meaning: 'The racket was already slowing down when it met the ball.',
      fix: 'Start smoother and save the fastest part of the swing for contact and just after.',
      drill:
        'Swing at 60 % effort and listen for the "whoosh" in front of your body, not beside it.',
    },
    'open-takeback': {
      meaning:
        'The strings faced the sky at the bottom of the backswing; the face then has to be rescued on the way up.',
      fix: 'Keep the strings facing the ground as the racket drops ("pat the dog").',
      drill: 'Shadow swings in front of a mirror, checking the face at the lowest point.',
    },
    hitch: {
      meaning:
        'The racket stopped between the backswing and the forward swing, which wastes the momentum.',
      fix: 'Make one continuous loop: back, down and up without a stop.',
      drill: 'Count "one-and-two" through the swing; no pause on "and".',
    },
    'stiff-arm': {
      meaning:
        "The racket moved together with the arm instead of lagging and whipping through, which can go with a tight wrist. This signal is an indirect proxy (the timing of the racket's peak angular acceleration) and has not been shown to measure wrist looseness.",
      fix: 'Keep the wrist relaxed through the swing and let it firm up only at contact.',
      drill:
        'Shadow swings, alternating deliberately stiff and deliberately relaxed ones to feel the difference; then slow feeds with the relaxed version.',
    },
    'short-finish': {
      meaning: 'The swing stopped soon after contact.',
      fix: 'Let the racket finish over the opposite shoulder; do not brake it.',
      drill: 'Catch the racket with your other hand at the end of every swing.',
    },
    'no-reading': {
      meaning:
        'The racket was not still before the swing, or it moved too fast for the sensor, so the angles could not be measured.',
      fix: 'Hold the racket still for a moment in the ready position before each ball.',
      drill: '',
    },
    good: {
      meaning: 'Every assessed metric was inside the target range.',
      fix: 'Repeat it.',
      drill: '',
    },
  },
  et: {
    'face-open': {
      meaning:
        'Tabamuse hetkel olid keeled suunatud üles, seepärast võib pall minna pikaks või jääda hõljuma.',
      fix: 'Sihi pall võrgu kohal veidi madalamale, lindi lähedale, ja lase reketil pärast tabamust edasi liikuda.',
      drill: 'Sööda 20 kerget palli ja löö need täishooga teenindusjoone sisse.',
    },
    'face-closed': {
      meaning: 'Tabamuse hetkel olid keeled suunatud alla, seepärast läheb pall võrku.',
      fix: 'Sihi pall võrgu kohal kõrgemale ja taba see rohkem enda ees.',
      drill:
        'Löö sihtmärki, mis on meeter võrgulindist kõrgemal; loe 20 löögist kokku, mitu palli läks sellest sihtmärgist kõrgemalt üle.',
    },
    'slice-face-closed': {
      meaning:
        "Slice'i puhul peavad keeled olema veidi üles suunatud; siin olid need alla ja pall sukeldub.",
      fix: 'Saada pall veidi kõrgemale ja lase sel hetkeks keelte peal kanduda.',
      drill: "Löö slice'i teenindusjoonelt nii, et pall hõljub tagasipöörlemisega sügavale.",
    },
    'slice-chop': {
      meaning:
        'Reket raius järsult alla: palju tagasipöörlemist, aga pall jääb lühikeseks ja kõrgeks.',
      fix: 'Löö rohkem ette kui alla, sihtmärgi suunas.',
      drill:
        "Löö slice'i nii, et pall libiseb madalalt üle teenindusjoone; järsk raiumine põrkab üles.",
    },
    'not-rated': {
      meaning:
        'See löök (serv, rabak, volle või lühike hoog) loetakse kokku, aga selle tehnika hindamiseks pole veel usaldusväärseid võrdlusväärtusi.',
      fix: '',
      drill: '',
    },
    'path-flat': {
      meaning: 'Reket liikus läbi palli horisontaalselt: vähe topspinni ja väike varu võrgu kohal.',
      fix: 'Alusta ettelööki pallist madalamalt ja lõpeta õla kohal.',
      drill: 'Harja teenindusjoonelt palli tagakülge üles ja lase pallil kaarega üle võrgu minna.',
    },
    'no-racket-drop': {
      meaning: 'Reketi pea jäi enne ettelööki üles, seega polnud kust üles lüüa.',
      fix: 'Lase tagahoo lõpus reketi pea käest madalamale vajuda ja löö siis üles.',
      drill: 'Varjulöögid: peata reket nii, et tipp näitab selja taga maha, ja löö sealt.',
    },
    'path-steep': {
      meaning: 'Reket liikus peaaegu otse üles: palju spinni, aga pikkust ja kiirust pole.',
      fix: 'Saada reket enne tõusu sihtmärgi suunas välja.',
      drill:
        'Pane kolm palli või koonust sihtmärgi suunas ritta ja lase reketil enne tõusu mööda seda joont edasi liikuda.',
    },
    'accelerated-early': {
      meaning: 'Reket oli juba aeglustumas, kui see pallini jõudis.',
      fix: 'Alusta sujuvamalt ja hoia löögi kiireim osa tabamuse ja sellele järgneva hetke jaoks.',
      drill: 'Löö 60% jõuga ja kuula, et „vihin“ kostaks keha ees, mitte küljel.',
    },
    'open-takeback': {
      meaning:
        'Tagahoo madalaimas punktis olid keeled taeva poole; pinda tuleb siis teel üles korrigeerida.',
      fix: 'Hoia keeled reketi langemisel maa poole („patsuta koera“).',
      drill: 'Varjulöögid peegli ees: kontrolli pinda madalaimas punktis.',
    },
    hitch: {
      meaning: 'Reket jäi tagahoo ja ettelöögi vahel seisma ning hoog läks kaotsi.',
      fix: 'Tee üks katkematu silmus: taha, alla ja üles ilma peatuseta.',
      drill: 'Loe löögi ajal „üks-ja-kaks“; „ja“ peal ei tohi pausi olla.',
    },
    'stiff-arm': {
      meaning:
        'Reket liikus käega koos, selle asemel et maha jääda ja piitsana läbi tulla; see võib viidata pingul olevale randmele. See signaal on kaudne näitaja (reketi nurkkiirenduse tipu ajastus) ja pole tõestatud, et see mõõdab randme lõtvust.',
      fix: 'Hoia ranne löögi ajal lõdvana ja lase sel kinnituda alles tabamuse hetkel.',
      drill:
        'Varjulöögid, kus vaheldumisi tahtlikult jäigalt ja tahtlikult lõdvalt, et vahet tunda; seejärel aeglased söödud pallid lõdva variandiga.',
    },
    'short-finish': {
      meaning: 'Löök peatus kohe pärast tabamust.',
      fix: 'Lase reketil lõpetada vastasõla kohal; ära pidurda.',
      drill: 'Püüa iga löögi lõpus reket teise käega kinni.',
    },
    'no-reading': {
      meaning:
        'Reket ei olnud enne lööki paigal või liikus anduri jaoks liiga kiiresti, seega ei saanud nurki mõõta.',
      fix: 'Hoia reketit enne iga palli hetkeks valmisasendis paigal.',
      drill: '',
    },
    good: {
      meaning: 'Kõik hinnatud näitajad olid sihtvahemikus.',
      fix: 'Korda sama.',
      drill: '',
    },
  },
};

export function guidanceFor(ruleId: string, language: Language): Guidance | null {
  return GUIDANCE[language][ruleId] ?? null;
}
