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
  type CoachState,
  DEFAULT_COACH_CONFIG,
  INITIAL_COACH_STATE,
  type Utterance,
  coachStep,
  cueForStroke,
  focusByStroke,
} from '../coach/coachEngine';
import { DEFAULT_RULES } from '../coaching/defaultRules';
import type { RuleSet } from '../coaching/rules';
import type {
  MountCalibration,
  RawCapture,
  SensorStatus,
  SessionInfo,
  StrokeCoaching,
  StrokeRecord,
} from '../domain/types';
import type { StrokeAssessment } from '../elements/assess';
import type { Speaker } from '../feedback/speech';
import { NO_SCREEN_LOCK, type ScreenLock } from '../feedback/wakeLock';
import { type AnalysisParams, DEFAULT_ANALYSIS_PARAMS } from '../metrics/analyzeSwing';
import { ANALYSIS_VERSION } from '../metrics/version';
import { type StaticPose, calibrateMount, extractStaticPose } from '../processing/calibration';
import { toImuSeries } from '../processing/units';
import { type AssemblerEvent, CaptureAssembler } from '../protocol/assembler';
import { Command } from '../protocol/constants';
import type { Repository } from '../storage/repository';
import type { ConnectionState, SensorTransport, Unsubscribe } from '../transport/transport';
import { analyzeCapture } from './pipeline';
import { DEFAULT_SETTINGS, type Settings, resolveSettings } from './settings';

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
  readonly staticCaptureTimeoutMs?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectDelayMs?: number;
}

const MAX_LOG = 20;

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
  /** What the coach decided after the latest stroke (also in rally mode, where nothing is spoken). */
  readonly utterance = signal<Utterance | null>(null);
  /** Current focus per stroke type. */
  readonly focus = computed(() => focusByStroke(this.coachState.value));
  /** Strokes with contact in the baseline, per stroke type. */
  readonly baselineCounts = computed(() => this.baseline.value.strokeCounts);

  private transport: SensorTransport | null = null;
  private subscriptions: Unsubscribe[] = [];
  private assembler: CaptureAssembler;
  private pendingStatic: ((capture: RawCapture) => void) | null = null;
  /** Bumped on every connect/disconnect; stale async continuations check it. */
  private generation = 0;
  private reconnecting = false;
  private logId = 0;
  private readonly screenLock: ScreenLock;
  private readonly rules: RuleSet;
  private readonly coachConfig: Omit<CoachConfig, 'speakGood'>;
  /** Bumped per session so a late baseline load cannot overwrite a newer session's. */
  private baselineGeneration = 0;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly staticTimeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;

  constructor(private readonly deps: ControllerDeps) {
    this.screenLock = deps.screenLock ?? NO_SCREEN_LOCK;
    this.rules = deps.rules ?? DEFAULT_RULES;
    this.coachConfig = deps.coachConfig ?? DEFAULT_COACH_CONFIG;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.staticTimeoutMs = deps.staticCaptureTimeoutMs ?? 5000;
    this.reconnectAttempts = deps.reconnectAttempts ?? 5;
    this.reconnectDelayMs = deps.reconnectDelayMs ?? 2000;
    this.assembler = new CaptureAssembler(this.now);
  }

  async init(): Promise<void> {
    await this.safely('Loading settings', async () => {
      this.settings.value = resolveSettings(await this.deps.repository.loadSettings());
    });
  }

  /* ---------------------------------------------------------- connection */

  /**
   * Connects to a sensor. Call from a user gesture: it also unlocks speech on
   * iOS. Rejects only with errors the user must see (no Web Bluetooth,
   * device picker cancelled, link failure).
   */
  async connect(transport: SensorTransport): Promise<void> {
    this.deps.speaker.prime();
    const generation = ++this.generation;
    await this.closeLink();
    if (generation !== this.generation) return; // disconnect() was called meanwhile
    this.transport = transport;
    this.assembler = new CaptureAssembler(this.now);
    this.subscriptions = [
      transport.onPacket((p) => {
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
    // The first command also tells the sensor that notifications are enabled.
    await this.safely('Requesting sensor status', () =>
      transport.send(Uint8Array.of(Command.RequestStatus)),
    );
    await this.screenLock.acquire();
    if (!this.session.value) await this.startSession();
  }

  /** Disconnects, and cancels any connect() or reconnect still in progress. */
  async disconnect(): Promise<void> {
    this.generation++;
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
    const rate = this.settings.value.speechRate;
    this.appendLog('Sensor disconnected.');
    this.deps.speaker.say('Sensor disconnected', rate);
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
          this.deps.speaker.say('Sensor connected', rate);
          return;
        } catch (error) {
          this.appendLog(`Reconnect attempt ${attempt} failed: ${errorMessage(error)}`);
        }
      }
      if (generation === this.generation) {
        this.deps.speaker.say('Sensor lost', rate);
        await this.disconnect();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /* ------------------------------------------------------------- session */

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
    await this.safely('Saving session', () => this.deps.repository.saveSession(session));
    await this.loadBaseline();
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
        if (generation !== this.baselineGeneration) return;
        // Strokes from before "reset personal baseline" no longer count.
        const since = this.settings.value.baselineResetAt;
        const counts = (r: StrokeRecord): boolean => r.capture.receivedAt >= since;
        const current = this.strokes.value;
        const ids = new Set(current.map((r) => r.id));
        this.baseline.value = buildBaseline(
          [...recent.filter((r) => !ids.has(r.id)), ...current].filter(counts),
        );
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
    const next = resolveSettings({ ...this.settings.value, ...patch });
    this.settings.value = next;
    await this.safely('Saving settings', () => this.deps.repository.saveSettings(next));
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

      if (pose === 'faceUp' || !faceUp) {
        this.calibrationStep.value = { step: 'awaitTipUp', faceUp: measured.pose };
        return;
      }
      const calibrated = calibrateMount(faceUp, measured.pose);
      if (!calibrated.ok) throw new Error(calibrated.reason);

      await this.deps.repository.saveCalibration(this.deviceKey(), calibrated.calibration);
      this.calibration.value = calibrated.calibration;
      this.calibrationStep.value = { step: 'done' };
    } catch (error) {
      this.calibrationStep.value = { step: 'failed', reason: errorMessage(error) };
    }
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

  private handleEvents(events: readonly AssemblerEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'status':
          this.status.value = event.status;
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
    const session = this.session.value;
    if (!calibration) {
      this.appendLog('Swing ignored: calibrate the sensor first.');
      return;
    }
    if (!session) return;

    const settings = this.settings.value;
    const analysisParams: AnalysisParams = {
      ...DEFAULT_ANALYSIS_PARAMS,
      leverRadiusM: settings.leverRadiusM,
    };
    let analysis;
    try {
      analysis = analyzeCapture(
        capture,
        calibration,
        analysisParams,
        this.rules,
        this.baseline.value,
      );
    } catch (error) {
      this.appendLog(`Analysis failed: ${errorMessage(error)}`);
      return;
    }

    const { assessment } = analysis;
    const step = coachStep(this.coachState.value, assessment, {
      ...this.coachConfig,
      speakGood: settings.speakGood,
    });
    const { utterance } = step;
    const coach: StrokeCoaching = {
      utterance: utterance.kind,
      correctionId: utterance.correctionId ?? null,
      focus: step.state.byStroke[assessment.strokeType].focus?.correctionId ?? null,
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
    this.assessment.value = assessment;
    this.utterance.value = utterance;
    // The stroke was judged against the baseline before it; now it joins it.
    this.baseline.value = addStrokeToBaseline(this.baseline.value, record);
    this.strokes.value = [...this.strokes.value, record];

    // Rally mode: everything is computed and stored, nothing is said.
    if (settings.mode === 'drill' && utterance.spoken !== '') {
      this.deps.speaker.say(utterance.spoken, settings.speechRate);
    }

    void this.safely('Saving stroke', () => this.deps.repository.saveStroke(record));
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
