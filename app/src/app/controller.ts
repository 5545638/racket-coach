import { computed, signal } from '@preact/signals';
import {
  BASELINE_LOAD_LIMIT,
  EMPTY_BASELINE,
  type PersonalBaseline,
  addStrokeToBaseline,
  buildBaseline,
} from '../coach/baseline';
import {
  type CoachConfig,
  type CoachContext,
  type CoachLane,
  type CoachState,
  type CoachStep,
  DEFAULT_COACH_CONFIG,
  INITIAL_COACH_STATE,
  type Utterance,
  coachStep,
  cueForStroke,
  focusByStroke,
  focusOf,
  laneOf,
  matchIdle,
  phraseLevelOf,
  withCueUnheard,
  withoutFocus,
} from '../coach/coachEngine';
import { type FatigueState, initialFatigue, isFatigued, updateFatigue } from '../coach/fatigue';
import { bestLevel, buildPlan } from '../coach/plan';
import {
  EMPTY_PROFILE_STATE,
  type ProfileState,
  addStrokeToProfile,
  buildProfileState,
  coachingPolicy,
  deriveProfile,
  withSessions,
} from '../coach/profile';
import type { CorrectionId } from '../coaching/corrections';
import { DEFAULT_RULES } from '../coaching/defaultRules';
import type { RuleSet } from '../coaching/rules';
import type {
  CategoryCounts,
  MountCalibration,
  PhraseLevel,
  RawCapture,
  SensorDiagnostics,
  SensorStatus,
  SessionInfo,
  SpokenLanguage,
  StrokeCoaching,
  StrokeRecord,
  VoiceProfile,
  VoiceSettings,
} from '../domain/types';
import type { StrokeAssessment } from '../elements/assess';
import {
  type DownloadFailure,
  type DownloadedVoiceStore,
  FALLBACK_ET_SPEAKERS,
  downloadEstonianVoice,
  downloadedCount,
  fetchEtSpeakers,
} from '../feedback/estonianVoice';
import { spokenPhrases } from '../feedback/phraseCatalog';
import {
  type DropReason,
  type EngineUse,
  type SpeechCategory,
  type Speaker,
  type VoiceInfo,
  hasVoiceFor,
} from '../feedback/speech';
import {
  FeedbackGate,
  RallyDetector,
  type SuppressReason,
  categoryOf,
  quantile,
} from '../feedback/speechPolicy';
import { TEST_PHRASES, type SystemPhrase } from '../feedback/speechStrings';
import { strokeSpeech, systemSpeech } from '../feedback/spokenText';
import { NO_SCREEN_LOCK, type ScreenLock } from '../feedback/wakeLock';
import { type AnalysisParams, DEFAULT_ANALYSIS_PARAMS } from '../metrics/analyzeSwing';
import { ANALYSIS_VERSION } from '../metrics/version';
import { type StaticPose, calibrateMount, extractStaticPose } from '../processing/calibration';
import { toImuSeries } from '../processing/units';
import { CaptureAssembler } from '../protocol/assembler';
import { Command, SensorMode } from '../protocol/constants';
import type { LinkEvent } from '../protocol/link';
import type { BenchResultMessage } from '../protocol/messagesV2';
import type { Repository } from '../storage/repository';
import type { ConnectionState, SensorTransport, Unsubscribe } from '../transport/transport';
import { analyzeCapture } from './pipeline';
import { DEFAULT_SETTINGS, type Settings, playerInputs, resolveSettings } from './settings';

export type CalibrationStep =
  | { readonly step: 'idle' }
  | { readonly step: 'capturing'; readonly pose: 'faceUp' | 'tipUp' }
  | { readonly step: 'awaitTipUp'; readonly faceUp: StaticPose }
  | { readonly step: 'failed'; readonly reason: string }
  | { readonly step: 'done' };

export interface LogEntry {
  readonly id: number;
  readonly text: string;
}

export interface ControllerDeps {
  readonly repository: Repository;
  readonly speaker: Speaker;
  readonly screenLock?: ScreenLock;
  readonly rules?: RuleSet;
  /** Coaching behaviour; `speakGood` is always taken from the settings. */
  readonly coachConfig?: Omit<CoachConfig, 'speakGood'>;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Starts a timer and returns its cancel function (match mode: speaking between points). */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
  readonly staticCaptureTimeoutMs?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectDelayMs?: number;
  /** Optional natural Estonian voice download (feedback/estonianVoice.ts); absent = not offered. */
  readonly estonianVoice?: EstonianVoiceDeps;
}

export interface EstonianVoiceDeps {
  readonly fetch: typeof fetch;
  readonly store: DownloadedVoiceStore;
  /** The clips of `speaker` changed (the clip engine must reload them). */
  readonly onInstalled?: (speaker: string) => void;
}

/** The downloaded Estonian natural voice of the chosen speaker. */
export type EstonianVoiceStatus =
  | { readonly state: 'unavailable' }
  | { readonly state: 'checking' }
  | {
      readonly state: 'missing' | 'partial' | 'ready';
      readonly clips: number;
      readonly total: number;
    }
  | { readonly state: 'downloading'; readonly done: number; readonly total: number }
  | {
      readonly state: 'failed';
      readonly reason: DownloadFailure;
      readonly status?: number;
      readonly clips: number;
      readonly total: number;
    };

/** Texts voiced by the device voice although the natural voice was chosen, kept for diagnostics. */
const MAX_FALLBACK_TEXTS = 5;

const MAX_LOG = 20;

/** Battery level at or below which "Sensor battery low" is said (once per connection), %. */
export const BATTERY_LOW_PERCENT = 15;

/** Most latency samples kept per session. */
const MAX_LATENCY_SAMPLES = 1000;

/** Speech diagnostics of the current session. */
export interface SpeechSessionStats {
  /** Time from the stroke's `receivedAt` to `onstart`, per spoken stroke cue, ms. */
  readonly latenciesMs: readonly number[];
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /** Stroke cues the queue dropped (never started), by reason. */
  readonly dropped: Readonly<Partial<Record<DropReason, number>>>;
  /** Stroke cues the coach decided on but that were not spoken, by reason. */
  readonly suppressed: Readonly<Partial<Record<SuppressReason, number>>>;
  /** Utterances by how they were voiced (natural clip, device voice, device voice as fallback). */
  readonly engines: Readonly<Partial<Record<EngineUse, number>>>;
  /** The latest texts that had no natural voice clip (`synth-fallback`), newest first. */
  readonly fallbackTexts: readonly string[];
}

export const EMPTY_SPEECH_STATS: SpeechSessionStats = {
  latenciesMs: [],
  p50Ms: null,
  p95Ms: null,
  dropped: {},
  suppressed: {},
  engines: {},
  fallbackTexts: [],
};

/** Two voice profiles are the same (every field). */
const sameVoice = (a: VoiceSettings, b: VoiceSettings): boolean =>
  (Object.keys({ ...a, ...b }) as (keyof VoiceSettings)[]).every((k) => a[k] === b[k]);

/** Sum of the counts of a stats record (e.g. `speechStats.dropped`). */
export const countOf = (counts: Readonly<Partial<Record<string, number>>>): number =>
  Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * A gap this long without a stroke ends the session: the next stroke (or a
 * reconnect after it) starts a new one. Engineering choice.
 */
export const SESSION_GAP_MS = 30 * 60_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Application service: owns the live session and connects transport,
 * analysis, feedback and persistence. UI components only read its signals
 * and call its methods. Apart from connect(), no method rejects: failures
 * surface as state or as log entries.
 */
export class CoachController {
  readonly connection = signal<ConnectionState>('disconnected');
  readonly deviceName = signal<string | null>(null);
  readonly status = signal<SensorStatus | null>(null);
  /** STATUS2 counters from v2 firmware (null with v1 firmware). */
  readonly diagnostics = signal<SensorDiagnostics | null>(null);
  /** Negotiated protocol version, null until known (v1-only transports: 1). */
  readonly protocolVersion = signal<1 | 2 | null>(null);
  readonly calibration = signal<MountCalibration | null>(null);
  readonly calibrationStep = signal<CalibrationStep>({ step: 'idle' });
  readonly settings = signal<Settings>(DEFAULT_SETTINGS);
  readonly session = signal<SessionInfo | null>(null);
  readonly strokes = signal<readonly StrokeRecord[]>([]);
  readonly log = signal<readonly LogEntry[]>([]);
  readonly lastStroke = computed(() => this.strokes.value.at(-1) ?? null);

  /* Live coaching (see coach/coachEngine.ts). */
  /** Personal baseline: previous sessions' strokes plus this session's, updated after every stroke. */
  readonly baseline = signal<PersonalBaseline>(EMPTY_BASELINE);
  /** True while the baseline of previous sessions is being loaded. */
  readonly baselineLoading = signal(false);
  readonly coachState = signal<CoachState>(INITIAL_COACH_STATE);
  /** Element assessment of the latest stroke. */
  readonly assessment = signal<StrokeAssessment | null>(null);
  /** What the coach decided after the latest stroke (also in match mode, where nothing is spoken). */
  readonly utterance = signal<Utterance | null>(null);
  /** Category counts of the latest stroke's elements. */
  readonly categories = signal<CategoryCounts | null>(null);
  /** The latest stroke phrase actually spoken (started) by the coach (any kind), or null. */
  readonly lastSpeech = signal<string | null>(null);

  /* Speech (feedback/speech.ts, feedback/speechPolicy.ts). */
  /** Quick mute (persisted in the settings): no stroke speech; system messages still spoken. */
  readonly speechMuted = computed(() => this.settings.value.speechMuted);
  /** Voices of the device (updated on voiceschanged). */
  readonly voices = signal<readonly VoiceInfo[]>([]);
  /** The downloaded natural Estonian voice of `voice.etSpeaker`. */
  readonly estonianVoice = signal<EstonianVoiceStatus>({ state: 'unavailable' });
  /** Speakers the Estonian natural voice can be downloaded in. */
  readonly etSpeakers = signal<readonly string[]>(FALLBACK_ET_SPEAKERS);
  /**
   * Language actually spoken: Estonian only when the device has an Estonian
   * voice or the natural Estonian voice is downloaded (and chosen).
   */
  readonly spokenLanguage = computed<SpokenLanguage>(() => {
    const voice = this.settings.value.voice;
    if (voice.lang !== 'et') return 'en';
    const natural = voice.engine === 'natural' && this.estonianVoice.value.state === 'ready';
    return natural || hasVoiceFor(this.voices.value, 'et') ? 'et' : 'en';
  });
  /** Estonian is wanted but the device has no Estonian voice (English is spoken). */
  readonly estonianVoiceMissing = computed(
    () => this.settings.value.voice.lang === 'et' && this.spokenLanguage.value !== 'et',
  );
  /** Rally play detected from stroke timing (cues silenced when `autoRallyMute` is on). */
  readonly rallyActive = signal(false);
  /** Speech latency and drop counts of the current session. */
  readonly speechStats = signal<SpeechSessionStats>(EMPTY_SPEECH_STATS);
  /** Fatigue detector of the current session (coach/fatigue.ts). */
  readonly fatigue = signal<FatigueState>(initialFatigue());
  /** The fatigue detector is active for any stroke type. */
  readonly fatigueActive = computed(() => isFatigued(this.fatigue.value));
  /** How strokes are assessed for this player (level, style, hand). */
  readonly policy = computed(() => coachingPolicy(playerInputs(this.settings.value)));
  /** Stroke history behind the profile; built at session start, grown per stroke. */
  readonly profileState = signal<ProfileState>(EMPTY_PROFILE_STATE);
  /** Player profile: inputs plus typical swing, weaknesses and progress. */
  readonly profile = computed(() =>
    deriveProfile(
      this.profileState.value,
      this.policy.value.inputs,
      this.baseline.value,
      this.policy.value.baselineCatalog,
    ),
  );
  readonly weaknesses = computed(() => this.profile.value.weaknesses);
  readonly progress = computed(() => this.profile.value.progress);
  /** Next-session training plan (deterministic, from the profile). */
  readonly plan = computed(() => buildPlan(this.profile.value, this.settings.value.language));
  /** Current focus per stroke type. */
  readonly focus = computed(() => focusByStroke(this.coachState.value));
  /** Per correction, the cue variant that earned the most "Better"s: a new focus starts there. */
  readonly preferredLevels = computed(() => {
    const out: Partial<Record<CorrectionId, PhraseLevel>> = {};
    for (const [id, counts] of Object.entries(this.profileState.value.betterByLevel) as [
      CorrectionId,
      readonly [number, number, number],
    ][]) {
      if (counts[0] + counts[1] + counts[2] > 0) out[id] = bestLevel(counts);
    }
    return out;
  });
  /** Strokes with contact in the baseline, per stroke type. */
  readonly baselineCounts = computed(() => this.baseline.value.strokeCounts);
  /**
   * The IMU temperature (latest stroke, else STATUS2) differs from the
   * calibration's by more than `temperatureWarnC`: the gyro bias may have
   * moved, so Setup suggests recalibrating. False when either is unknown.
   */
  readonly temperatureWarning = computed(() => {
    const calibrationC = this.calibration.value?.temperatureC;
    if (calibrationC === undefined) return false;
    const currentC =
      this.lastStroke.value?.capture.temperatureC ?? this.diagnostics.value?.temperatureC;
    if (currentC === undefined) return false;
    return Math.abs(currentC - calibrationC) > DEFAULT_ANALYSIS_PARAMS.temperatureWarnC;
  });

  private transport: SensorTransport | null = null;
  private subscriptions: Unsubscribe[] = [];
  private assembler: CaptureAssembler;
  private pendingStatic: ((capture: RawCapture) => void) | null = null;
  /** Bumped on every connect/disconnect; stale async continuations check it. */
  private generation = 0;
  private reconnecting = false;
  /** Bench T5: numbered packets received since the test was started. */
  private benchT5Received = 0;
  private logId = 0;
  private readonly screenLock: ScreenLock;
  private readonly rules: RuleSet;
  private readonly coachConfig: Omit<CoachConfig, 'speakGood'>;
  /** Bumped per session so a late baseline load cannot overwrite a newer session's. */
  private baselineGeneration = 0;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private cancelMatchTimer: (() => void) | null = null;
  private readonly staticTimeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private gate = new FeedbackGate();
  private rally = new RallyDetector();
  private batteryWarned = false;

  constructor(private readonly deps: ControllerDeps) {
    this.screenLock = deps.screenLock ?? NO_SCREEN_LOCK;
    this.rules = deps.rules ?? DEFAULT_RULES;
    this.coachConfig = deps.coachConfig ?? DEFAULT_COACH_CONFIG;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => {
          clearTimeout(id);
        };
      });
    this.staticTimeoutMs = deps.staticCaptureTimeoutMs ?? 5000;
    this.reconnectAttempts = deps.reconnectAttempts ?? 5;
    this.reconnectDelayMs = deps.reconnectDelayMs ?? 2000;
    this.assembler = new CaptureAssembler(this.now);
    this.refreshVoices();
    deps.speaker.onVoicesChanged?.(() => {
      this.refreshVoices();
    });
  }

  async init(): Promise<void> {
    await this.safely('Loading settings', async () => {
      this.settings.value = resolveSettings(await this.deps.repository.loadSettings());
    });
    await this.refreshEstonianVoice();
    this.prepareVoice();
  }

  /** Re-reads the device's voices (iOS fills the list lazily). */
  refreshVoices(): void {
    this.voices.value = this.deps.speaker.voices?.() ?? [];
  }

  /* ---------------------------------------------------------- connection */

  /**
   * Connects to a sensor. Call from a user gesture: it also unlocks speech on
   * iOS. Rejects only with errors the user must see (no Web Bluetooth,
   * device picker cancelled, link failure).
   */
  async connect(transport: SensorTransport): Promise<void> {
    this.deps.speaker.prime();
    this.refreshVoices();
    this.prepareVoice();
    this.batteryWarned = false;
    const generation = ++this.generation;
    await this.closeLink();
    if (generation !== this.generation) return; // disconnect() was called meanwhile
    this.transport = transport;
    this.assembler = new CaptureAssembler(this.now);
    this.diagnostics.value = null;
    this.protocolVersion.value = transport.onEvent ? null : 1;
    this.subscriptions = [
      // Transports with their own protocol link (v2) deliver decoded events;
      // others deliver v1 packets, assembled here.
      transport.onEvent
        ? transport.onEvent((e) => {
            this.handleEvents([e]);
          })
        : transport.onPacket((p) => {
            this.handleEvents(this.assembler.push(p));
          }),
      transport.onStateChange((state) => {
        this.handleStateChange(transport, state);
      }),
    ];

    try {
      await transport.connect();
    } catch (error) {
      if (generation === this.generation) this.teardown();
      throw error;
    }
    if (generation !== this.generation) {
      // disconnect() ran while the link was coming up: close it again.
      await this.safely('Disconnecting', () => transport.disconnect());
      return;
    }

    this.connection.value = transport.state;
    this.deviceName.value = transport.deviceName;
    this.calibrationStep.value = { step: 'idle' };
    await this.safely('Loading calibration', async () => {
      this.calibration.value = await this.deps.repository.loadCalibration(this.deviceKey());
    });
    transport.setSensorMode?.(this.sensorMode());
    // The first command also tells the sensor that notifications are enabled.
    await this.safely('Requesting sensor status', () =>
      transport.send(Uint8Array.of(Command.RequestStatus)),
    );
    await this.screenLock.acquire();
    if (!this.session.value || this.sessionEnded(this.now())) await this.startSession();
  }

  /**
   * Disconnects, and cancels any connect() or reconnect still in progress.
   * Stops the match-mode timer and drops speech still queued.
   */
  async disconnect(): Promise<void> {
    this.generation++;
    this.stopMatchTimer();
    this.deps.speaker.cancel?.();
    await this.closeLink();
  }

  private async closeLink(): Promise<void> {
    const transport = this.transport;
    this.teardown();
    this.connection.value = 'disconnected';
    await this.screenLock.release();
    await this.safely('Disconnecting', async () => {
      await transport?.disconnect();
    });
  }

  private teardown(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.transport = null;
    this.pendingStatic = null;
  }

  private handleStateChange(transport: SensorTransport, state: ConnectionState): void {
    if (transport !== this.transport) return;
    this.connection.value = state;
    if (state === 'disconnected' && !this.reconnecting) {
      void this.reconnect(transport, this.generation);
    }
  }

  /** The link dropped without the user asking: say so and try to recover. */
  private async reconnect(transport: SensorTransport, generation: number): Promise<void> {
    this.reconnecting = true;
    this.appendLog('Sensor disconnected.');
    this.saySystem('disconnected');
    try {
      for (let attempt = 1; attempt <= this.reconnectAttempts; attempt++) {
        await this.sleep(this.reconnectDelayMs);
        if (generation !== this.generation) return;
        try {
          this.assembler = new CaptureAssembler(this.now);
          await transport.connect();
          if (generation !== this.generation) {
            await transport.disconnect();
            return;
          }
          await transport.send(Uint8Array.of(Command.RequestStatus));
          this.appendLog(`Reconnected (attempt ${attempt}).`);
          this.saySystem('connected');
          // Back after a long gap: that is a new session.
          if (this.sessionEnded(this.now())) await this.startSession();
          return;
        } catch (error) {
          this.appendLog(`Reconnect attempt ${attempt} failed: ${errorMessage(error)}`);
        }
      }
      if (generation === this.generation) {
        // Said after disconnect(), which drops queued speech.
        await this.disconnect();
        this.saySystem('lost');
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /* ------------------------------------------------------------- session */

  /**
   * The current session has had no stroke for more than SESSION_GAP_MS at
   * `at`. A session without strokes never ends this way.
   */
  private sessionEnded(at: number): boolean {
    const last = this.strokes.value.at(-1)?.capture.receivedAt;
    return this.session.value !== null && last !== undefined && at - last > SESSION_GAP_MS;
  }

  /**
   * Starts a new session: a fresh coach, fatigue detector and stroke list.
   * Stored strokes and sessions stay; the baseline and the profile are
   * rebuilt from them.
   */
  async startSession(): Promise<void> {
    const startedAt = this.now();
    const session: SessionInfo = {
      id: this.newId(),
      startedAt,
      label: new Date(startedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    };
    this.session.value = session;
    this.strokes.value = [];
    this.coachState.value = INITIAL_COACH_STATE;
    this.assessment.value = null;
    this.utterance.value = null;
    this.categories.value = null;
    this.lastSpeech.value = null;
    this.gate = new FeedbackGate();
    this.rally.reset();
    this.rallyActive.value = false;
    this.speechStats.value = EMPTY_SPEECH_STATS;
    this.prepareVoice();
    this.fatigue.value = initialFatigue(startedAt);
    this.stopMatchTimer();
    await this.safely('Saving session', () => this.deps.repository.saveSession(session));
    await this.loadBaseline();
  }

  /**
   * The newest `limit` sessions that have strokes, with those strokes, for the
   * history charts. Reads storage on demand; never throws.
   */
  async loadHistory(limit = 20): Promise<{
    readonly sessions: SessionInfo[];
    readonly strokes: StrokeRecord[];
  }> {
    const sessions: SessionInfo[] = [];
    const strokes: StrokeRecord[] = [];
    await this.safely('Loading history', async () => {
      const all = await this.deps.repository.listSessions();
      for (const session of all.slice(0, limit * 3)) {
        if (sessions.length >= limit) break;
        const own = await this.deps.repository.strokesForSession(session.id);
        if (own.length === 0) continue;
        sessions.push(session);
        strokes.push(...own);
      }
    });
    return { sessions, strokes };
  }

  /**
   * Builds the personal baseline from the most recent stored strokes. Strokes
   * that arrive while it loads are already in `strokes` and are merged in
   * (each stroke once, by id).
   */
  private async loadBaseline(): Promise<void> {
    const generation = ++this.baselineGeneration;
    this.baselineLoading.value = true;
    try {
      await this.safely('Loading baseline', async () => {
        const recent = await this.deps.repository.recentStrokes(BASELINE_LOAD_LIMIT);
        const sessions = await this.deps.repository.listSessions();
        if (generation !== this.baselineGeneration) return;
        // Strokes from before "reset personal baseline" no longer count.
        const since = this.settings.value.baselineResetAt;
        const counts = (r: StrokeRecord): boolean => r.capture.receivedAt >= since;
        const current = this.strokes.value;
        const ids = new Set(current.map((r) => r.id));
        const all = [...recent.filter((r) => !ids.has(r.id)), ...current];
        const catalog = this.policy.value.baselineCatalog;
        this.baseline.value = buildBaseline(all.filter(counts), undefined, undefined, catalog);
        // The profile keeps the whole history: a baseline reset does not erase progress.
        this.profileState.value = buildProfileState(all, sessions, catalog);
      });
    } finally {
      if (generation === this.baselineGeneration) this.baselineLoading.value = false;
    }
  }

  /**
   * Forgets the personal baseline: clears it now and, via a stored timestamp,
   * ignores every stroke received before this moment when the baseline is
   * rebuilt at the next session start. Stored strokes themselves stay.
   */
  async resetBaseline(): Promise<void> {
    this.baselineGeneration++; // a load still in flight must not bring the old strokes back
    this.baselineLoading.value = false;
    this.baseline.value = EMPTY_BASELINE;
    await this.updateSettings({ baselineResetAt: this.now() });
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const before = this.settings.value;
    const next = resolveSettings({ ...before, ...patch });
    const modeChanged = next.experimentalM416 !== before.experimentalM416;
    // Hand and style change what the baseline holds (serve roll, path limits).
    const catalogChanged =
      next.dominantHand !== before.dominantHand || next.forehandStyle !== before.forehandStyle;
    this.settings.value = next;
    if (modeChanged) this.transport?.setSensorMode?.(this.sensorMode());
    if (next.voice.etSpeaker !== before.voice.etSpeaker) void this.refreshEstonianVoice();
    if (!sameVoice(next.voice, before.voice)) this.prepareVoice();
    if (next.mode !== 'match') this.stopMatchTimer();
    // Silenced now: cues still queued or speaking are dropped (system messages stay).
    const silenced = (x: Settings) => x.speechMuted || x.feedbackFrequency === 'off';
    if (silenced(next) && !silenced(before)) this.deps.speaker.cancel?.('stroke');
    // A cue heard in one coaching mode is not built on in another.
    if (next.mode !== before.mode) this.coachState.value = withoutFocus(this.coachState.value);
    await this.safely('Saving settings', () => this.deps.repository.saveSettings(next));
    if (catalogChanged && this.session.value) await this.loadBaseline();
  }

  /** Quick mute toggle for the training screen (persisted). */
  async toggleMute(): Promise<void> {
    await this.updateSettings({ speechMuted: !this.settings.value.speechMuted });
  }

  /**
   * Speaks a sample phrase with the current voice profile, or with the natural
   * English voice `profile` ("Proovi" next to a profile). Call from a tap: it
   * unlocks iOS audio.
   */
  testSpeech(profile?: VoiceProfile): void {
    const lang = profile ? 'en' : this.spokenLanguage.value;
    const current = this.settings.value.voice;
    const voice: VoiceSettings = profile ? { ...current, engine: 'natural', profile } : current;
    this.deps.speaker.prime();
    const text = TEST_PHRASES[lang];
    this.deps.speaker.say({
      text,
      lang,
      category: 'info',
      voice,
      onEngine: this.trackEngine(text),
    });
  }

  /* ------------------------------------------------- natural voice clips */

  /** Loads and decodes the natural voice clips of the current voice (never in the cue path). */
  private prepareVoice(): void {
    void this.deps.speaker.prepare?.(this.settings.value.voice, this.spokenLanguage.value);
  }

  /** Re-reads how much of the chosen Estonian speaker is downloaded. */
  async refreshEstonianVoice(): Promise<void> {
    const deps = this.deps.estonianVoice;
    if (!deps) return;
    if (this.estonianVoice.value.state === 'downloading') return;
    const speaker = this.settings.value.voice.etSpeaker;
    const phrases = spokenPhrases('et');
    if (this.estonianVoice.value.state === 'unavailable')
      this.estonianVoice.value = { state: 'checking' };
    const clips = await downloadedCount(deps.store, speaker, phrases);
    if (speaker !== this.settings.value.voice.etSpeaker) return; // changed meanwhile
    const total = new Set(phrases).size;
    this.estonianVoice.value = {
      state: clips === 0 ? 'missing' : clips >= total ? 'ready' : 'partial',
      clips,
      total,
    };
    if (clips >= total) this.prepareVoice();
  }

  /** Asks the TTS service which Estonian speakers it has (fallback list on failure). */
  async loadEtSpeakers(): Promise<void> {
    const deps = this.deps.estonianVoice;
    if (!deps) return;
    this.etSpeakers.value = await fetchEtSpeakers(deps.fetch);
  }

  /**
   * One-time download of the natural Estonian voice (button in the speech
   * settings; needs the network once, then plays offline). Phrases already
   * downloaded are skipped. Never rejects; a failure shows in `estonianVoice`.
   */
  async downloadEstonianVoice(): Promise<void> {
    const deps = this.deps.estonianVoice;
    if (!deps || this.estonianVoice.value.state === 'downloading') return;
    const speaker = this.settings.value.voice.etSpeaker;
    const phrases = spokenPhrases('et');
    const total = new Set(phrases).size;
    this.estonianVoice.value = { state: 'downloading', done: 0, total };
    const result = await downloadEstonianVoice({
      fetch: deps.fetch,
      store: deps.store,
      speaker,
      phrases,
      onProgress: (done, all) => {
        this.estonianVoice.value = { state: 'downloading', done, total: all };
      },
    });
    deps.onInstalled?.(speaker);
    if (result.ok) {
      this.appendLog(`Estonian voice "${speaker}": ${result.clips} clips`);
      this.estonianVoice.value = { state: 'checking' };
      await this.refreshEstonianVoice();
      this.prepareVoice();
    } else {
      this.appendLog(
        `Estonian voice download failed: ${result.reason}${result.status === undefined ? '' : ` ${result.status}`}`,
      );
      this.estonianVoice.value = {
        state: 'failed',
        reason: result.reason,
        ...(result.status === undefined ? {} : { status: result.status }),
        clips: result.clips,
        total,
      };
    }
  }

  /** Counts how an utterance was voiced; remembers texts without a natural clip. */
  private trackEngine(text: string): (use: EngineUse) => void {
    return (use) => {
      const stats = this.speechStats.value;
      const fallbackTexts =
        use === 'synth-fallback'
          ? [text, ...stats.fallbackTexts.filter((t) => t !== text)].slice(0, MAX_FALLBACK_TEXTS)
          : stats.fallbackTexts;
      this.speechStats.value = {
        ...stats,
        engines: { ...stats.engines, [use]: (stats.engines[use] ?? 0) + 1 },
        fallbackTexts,
      };
    };
  }

  /* --------------------------------------------------------- calibration */

  /** Runs one calibration pose: 'faceUp' first, then 'tipUp'. */
  async capturePose(pose: 'faceUp' | 'tipUp'): Promise<void> {
    const current = this.calibrationStep.value;
    const faceUp = current.step === 'awaitTipUp' ? current.faceUp : null;
    if (pose === 'tipUp' && !faceUp) {
      this.calibrationStep.value = { step: 'failed', reason: 'Do the face-up step first.' };
      return;
    }
    this.calibrationStep.value = { step: 'capturing', pose };

    try {
      const capture = await this.requestStaticCapture();
      const measured = extractStaticPose(toImuSeries(capture));
      if (!measured.ok) throw new Error(measured.reason);
      // IMU temperature of the pose: the capture's OUT_TEMP, else the latest STATUS2.
      const temperatureC = capture.temperatureC ?? this.diagnostics.value?.temperatureC;
      const measuredPose =
        temperatureC !== undefined ? { ...measured.pose, temperatureC } : measured.pose;

      if (pose === 'faceUp' || !faceUp) {
        this.calibrationStep.value = { step: 'awaitTipUp', faceUp: measuredPose };
        return;
      }
      const calibrated = calibrateMount(faceUp, measuredPose);
      if (!calibrated.ok) throw new Error(calibrated.reason);

      await this.deps.repository.saveCalibration(this.deviceKey(), calibrated.calibration);
      this.calibration.value = calibrated.calibration;
      this.calibrationStep.value = { step: 'done' };
    } catch (error) {
      this.calibrationStep.value = { step: 'failed', reason: errorMessage(error) };
    }
  }

  /**
   * Runs a firmware bench test (docs/bring-up.md, T1–T7); the raw result
   * bytes appear in the diagnostics log. Needs v2 firmware. During bring-up
   * call it from the browser console: `racketCoach.runBench(1, 10)`.
   */
  runBench(test: number, param = 0): void {
    if (this.protocolVersion.value !== 2 || !this.transport?.bench) {
      this.appendLog('Bench tests need firmware with protocol v2.');
      return;
    }
    if (test === 5) this.benchT5Received = 0;
    this.transport.bench(test, param);
  }

  /** Logs a bench result as hex; T5 packets are counted and summarised instead. */
  private logBench(result: BenchResultMessage): void {
    const { test, part, payload } = result;
    if (test === 5 && part !== 0xff) {
      this.benchT5Received++;
      return;
    }
    const hex = Array.from(payload, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const extra = test === 5 ? ` (received ${this.benchT5Received} of 200 numbered packets)` : '';
    this.appendLog(`Bench T${test} part ${part}: ${hex}${extra}`);
  }

  private sensorMode() {
    return this.settings.value.experimentalM416 ? SensorMode.M416 : SensorMode.M104;
  }

  private deviceKey(): string {
    return this.deviceName.value ?? 'unknown';
  }

  private requestStaticCapture(): Promise<RawCapture> {
    const transport = this.transport;
    if (!transport || this.connection.value !== 'connected') {
      return Promise.reject(new Error('Connect the sensor first.'));
    }
    return new Promise<RawCapture>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStatic = null;
        reject(new Error('No reading from the sensor. Hold the racket still and try again.'));
      }, this.staticTimeoutMs);
      this.pendingStatic = (capture) => {
        clearTimeout(timer);
        this.pendingStatic = null;
        resolve(capture);
      };
      transport.send(Uint8Array.of(Command.CaptureStatic)).catch((error: unknown) => {
        clearTimeout(timer);
        this.pendingStatic = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /* ------------------------------------------------------------- strokes */

  private handleEvents(events: readonly LinkEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'status':
          this.status.value = event.status;
          if (event.status.batteryPercent <= BATTERY_LOW_PERCENT && !this.batteryWarned) {
            this.batteryWarned = true;
            this.saySystem('batteryLow');
          }
          break;
        case 'diagnostics':
          this.diagnostics.value = event.diagnostics;
          break;
        case 'protocol':
          this.protocolVersion.value = event.version;
          this.appendLog(`Sensor protocol v${event.version}.`);
          break;
        case 'bench':
          this.logBench(event.result);
          break;
        case 'error':
          this.appendLog(event.reason);
          break;
        case 'capture':
          if (event.capture.kind === 'static') {
            this.pendingStatic?.(event.capture);
          } else {
            this.handleSwing(event.capture);
          }
          break;
      }
    }
  }

  /**
   * Synchronous up to the spoken cue, so strokes keep their arrival order:
   * analysis and assessment against the current baseline, one coaching step,
   * then the stroke joins the baseline.
   */
  private handleSwing(capture: RawCapture): void {
    const calibration = this.calibration.value;
    if (!calibration) {
      this.appendLog('Swing ignored: calibrate the sensor first.');
      return;
    }
    if (!this.session.value) return;
    // A long gap since the previous stroke: this stroke opens a new session.
    // startSession() switches everything synchronously before its first await.
    if (this.sessionEnded(capture.receivedAt)) void this.startSession();
    const session = this.session.value;
    // Cues of earlier strokes that have not started yet are superseded by this
    // stroke. Dropping them first lets the coach step below see what was really heard.
    this.deps.speaker.cancel?.('queued-stroke');

    const settings = this.settings.value;
    const analysisParams: AnalysisParams = {
      ...DEFAULT_ANALYSIS_PARAMS,
      leverRadiusM: settings.leverRadiusM,
    };
    const policy = this.policy.value;
    let analysis;
    try {
      analysis = analyzeCapture(
        capture,
        calibration,
        analysisParams,
        this.rules,
        this.baseline.value,
        policy.assess,
        policy.catalog,
      );
    } catch (error) {
      this.appendLog(`Analysis failed: ${errorMessage(error)}`);
      return;
    }

    const { assessment } = analysis;
    const fatigue = updateFatigue(
      this.fatigue.value,
      analysis.metrics,
      assessment,
      capture.receivedAt,
    );
    const fatigueActive = isFatigued(fatigue, assessment.strokeType);
    const config = this.fullCoachConfig();
    const context: CoachContext = {
      mode: settings.mode,
      receivedAt: capture.receivedAt,
      fatigueActive,
      preferredLevels: this.preferredLevels.value,
    };
    const before = this.coachState.value;
    const lane = laneOf(assessment.strokeType, assessment.swingStyle);
    const strokeNo = this.gate.nextStroke();
    const inRally = this.rally.observe(capture.receivedAt);
    this.rallyActive.value = inRally;
    let step = coachStep(before, assessment, config, true, context);
    // The coach decided; mute, rally and frequency decide whether it is said.
    // A cue that will not be said is decided again as unheard, so the coach
    // does not build on it (no ladder step, no "Better" / reinforce for it).
    if (step.speech !== null) {
      const reason = this.suppression(step, lane, inRally);
      if (reason !== null) {
        this.countSpeech('suppressed', reason);
        step = coachStep(before, assessment, config, false, context);
      }
    }
    const unheard = () => coachStep(before, assessment, config, false, context).state;
    const { utterance } = step;
    const coach: StrokeCoaching = {
      utterance: utterance.kind,
      correctionId: utterance.correctionId ?? null,
      focus: focusOf(step.state, assessment.strokeType, assessment.swingStyle),
      mode: settings.mode,
      categories: step.categories,
      phraseLevel: phraseLevelOf(utterance),
      fatigueActive,
    };
    const record: StrokeRecord = {
      id: this.newId(),
      sessionId: session.id,
      capture,
      metrics: analysis.metrics,
      cue: cueForStroke(utterance, assessment),
      analysisVersion: ANALYSIS_VERSION,
      analysisParams,
      calibration,
      coach,
    };
    this.coachState.value = step.state;
    this.fatigue.value = fatigue;
    this.assessment.value = assessment;
    this.utterance.value = utterance;
    this.categories.value = step.categories.counts;
    // The stroke was judged against the baseline before it; now it joins it.
    const catalog = policy.baselineCatalog;
    this.baseline.value = addStrokeToBaseline(this.baseline.value, record, undefined, catalog);
    this.profileState.value = withSessions(
      addStrokeToProfile(this.profileState.value, record, catalog),
      this.profileState.value.sessionInfo[session.id] ? [] : [session],
    );
    this.strokes.value = [...this.strokes.value, record];

    // Match mode: everything is computed and stored; speech only between points.
    if (step.speech !== null) {
      this.speakStroke(step, step.speech, lane, strokeNo, capture.receivedAt, unheard);
    }
    if (settings.mode === 'match') this.scheduleMatchCheck();

    void this.safely('Saving stroke', () => this.deps.repository.saveStroke(record));
  }

  /* ---------------------------------------------------------- match mode */

  private fullCoachConfig(): CoachConfig {
    return { ...this.coachConfig, speakGood: this.settings.value.speakGood };
  }

  /* --------------------------------------------------------------- speech */

  /** Why the coach's phrase for a stroke is not said, or null to say it. Match mode: never per stroke. */
  private suppression(step: CoachStep, lane: CoachLane, inRally: boolean): SuppressReason | null {
    const settings = this.settings.value;
    if (settings.speechMuted) return 'muted';
    if (settings.autoRallyMute && inRally && settings.mode !== 'match') return 'rally';
    const text = strokeSpeech(step.utterance, step.speech ?? '', this.spokenLanguage.value).text;
    return this.gate.allows(settings.feedbackFrequency, step.utterance.kind, lane, text);
  }

  /**
   * Queues a stroke's phrase. When it starts, it is heard: the frequency gate
   * and `lastSpeech` learn it. When the queue drops it, the coach state is
   * corrected: re-decided as unheard if nothing happened since (`unheard`),
   * else the cue is marked unheard (withCueUnheard).
   */
  private speakStroke(
    step: CoachStep,
    speech: string,
    lane: CoachLane,
    strokeNo: number,
    receivedAt: number,
    unheard: () => CoachState,
  ): void {
    const { utterance } = step;
    const { text, lang } = strokeSpeech(utterance, speech, this.spokenLanguage.value);
    this.deps.speaker.say({
      text,
      lang,
      category: categoryOf(utterance.kind),
      voice: this.settings.value.voice,
      createdAt: receivedAt,
      onEngine: this.trackEngine(text),
      onStart: (latencyMs) => {
        this.lastSpeech.value = text;
        this.gate.heard(utterance.kind, lane, text, strokeNo);
        this.recordLatency(latencyMs);
      },
      onDrop: (reason) => {
        this.countSpeech('dropped', reason);
        if (this.coachState.value === step.state) {
          this.coachState.value = unheard();
        } else if (utterance.kind === 'correction' && utterance.correctionId !== undefined) {
          this.coachState.value = withCueUnheard(
            this.coachState.value,
            lane,
            utterance.correctionId,
          );
        }
      },
    });
  }

  private saySystem(key: SystemPhrase): void {
    const { text, lang } = systemSpeech(key, this.spokenLanguage.value);
    this.deps.speaker.say({
      text,
      lang,
      category: 'system',
      voice: this.settings.value.voice,
      onEngine: this.trackEngine(text),
    });
  }

  private recordLatency(latencyMs: number): void {
    const stats = this.speechStats.value;
    const latenciesMs = [...stats.latenciesMs, Math.max(0, latencyMs)].slice(-MAX_LATENCY_SAMPLES);
    this.speechStats.value = {
      ...stats,
      latenciesMs,
      p50Ms: quantile(latenciesMs, 0.5),
      p95Ms: quantile(latenciesMs, 0.95),
    };
  }

  private countSpeech(field: 'dropped', reason: DropReason): void;
  private countSpeech(field: 'suppressed', reason: SuppressReason): void;
  private countSpeech(field: 'dropped' | 'suppressed', reason: string): void {
    const stats = this.speechStats.value;
    const counts: Partial<Record<string, number>> = stats[field];
    this.speechStats.value = {
      ...stats,
      [field]: { ...counts, [reason]: (counts[reason] ?? 0) + 1 },
    };
  }

  /** Checks for a persistent major fault once play has paused (no stroke for the quiet time). */
  private scheduleMatchCheck(): void {
    this.stopMatchTimer();
    const config = this.fullCoachConfig();
    this.cancelMatchTimer = this.setTimer(() => {
      this.cancelMatchTimer = null;
      this.checkMatchBreak();
    }, config.match.quietMs);
  }

  /** Speaks a pending persistent major fault if play has paused (match mode). */
  checkMatchBreak(): void {
    if (this.settings.value.mode !== 'match') return;
    // Muted: the pending fault waits for the next break after unmuting.
    if (this.settings.value.speechMuted) return;
    const idle = matchIdle(this.coachState.value, this.now(), this.fullCoachConfig());
    if (idle === null) return;
    this.coachState.value = idle.state;
    this.utterance.value = idle.utterance;
    const { text, lang } = strokeSpeech(idle.utterance, idle.speech, this.spokenLanguage.value);
    const category: SpeechCategory = 'correction';
    this.deps.speaker.say({
      text,
      lang,
      category,
      voice: this.settings.value.voice,
      onEngine: this.trackEngine(text),
      onStart: () => {
        this.lastSpeech.value = text;
      },
    });
  }

  private stopMatchTimer(): void {
    this.cancelMatchTimer?.();
    this.cancelMatchTimer = null;
  }

  /* ------------------------------------------------------------- helpers */

  private async safely(what: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.appendLog(`${what} failed: ${errorMessage(error)}`);
    }
  }

  private appendLog(message: string): void {
    const text = `${new Date(this.now()).toLocaleTimeString()} ${message}`;
    this.log.value = [{ id: ++this.logId, text }, ...this.log.value].slice(0, MAX_LOG);
  }
}
