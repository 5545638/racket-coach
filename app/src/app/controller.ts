import { computed, signal } from '@preact/signals';
import { DEFAULT_RULES } from '../coaching/defaultRules';
import type { RuleSet } from '../coaching/rules';
import type {
  MountCalibration,
  RawCapture,
  SensorStatus,
  SessionInfo,
  StrokeRecord,
} from '../domain/types';
import type { Speaker } from '../feedback/speech';
import { DEFAULT_ANALYSIS_PARAMS } from '../metrics/analyzeSwing';
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

export interface ControllerDeps {
  readonly repository: Repository;
  readonly speaker: Speaker;
  readonly rules?: RuleSet;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly staticCaptureTimeoutMs?: number;
}

const MAX_LOG = 20;

/**
 * Application service: owns the live session and connects transport,
 * analysis, feedback and persistence. UI components only read its signals
 * and call its methods.
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
  readonly log = signal<readonly string[]>([]);
  readonly lastStroke = computed(() => this.strokes.value.at(-1) ?? null);

  private transport: SensorTransport | null = null;
  private subscriptions: Unsubscribe[] = [];
  private assembler: CaptureAssembler;
  private pendingStatic: ((capture: RawCapture) => void) | null = null;
  private readonly rules: RuleSet;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly staticTimeoutMs: number;

  constructor(private readonly deps: ControllerDeps) {
    this.rules = deps.rules ?? DEFAULT_RULES;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.staticTimeoutMs = deps.staticCaptureTimeoutMs ?? 5000;
    this.assembler = new CaptureAssembler(this.now);
  }

  async init(): Promise<void> {
    this.settings.value = resolveSettings(await this.deps.repository.loadSettings());
  }

  /* ---------------------------------------------------------- connection */

  async connect(transport: SensorTransport): Promise<void> {
    await this.disconnect();
    this.transport = transport;
    this.assembler = new CaptureAssembler(this.now);
    this.subscriptions = [
      transport.onPacket((p) => {
        this.handleEvents(this.assembler.push(p));
      }),
      transport.onStateChange((s) => {
        this.connection.value = s;
      }),
    ];
    try {
      await transport.connect();
    } catch (error) {
      this.teardown();
      throw error;
    }
    this.connection.value = transport.state;
    this.deviceName.value = transport.deviceName;
    this.calibration.value = await this.deps.repository.loadCalibration(this.deviceKey());
    this.calibrationStep.value = { step: 'idle' };
    await transport.send(Uint8Array.of(Command.RequestStatus));
    if (!this.session.value) await this.startSession();
  }

  async disconnect(): Promise<void> {
    const transport = this.transport;
    this.teardown();
    await transport?.disconnect();
    this.connection.value = 'disconnected';
  }

  private teardown(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.transport = null;
  }

  /* ------------------------------------------------------------- session */

  async startSession(): Promise<void> {
    const startedAt = this.now();
    const session: SessionInfo = {
      id: this.newId(),
      startedAt,
      label: new Date(startedAt).toLocaleString(),
    };
    await this.deps.repository.saveSession(session);
    this.session.value = session;
    this.strokes.value = [];
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const next = resolveSettings({ ...this.settings.value, ...patch });
    this.settings.value = next;
    await this.deps.repository.saveSettings(next);
  }

  /* --------------------------------------------------------- calibration */

  /** Runs one calibration pose. Call for 'faceUp' first, then 'tipUp'. */
  async capturePose(pose: 'faceUp' | 'tipUp'): Promise<void> {
    const current = this.calibrationStep.value;
    const faceUp = current.step === 'awaitTipUp' ? current.faceUp : null;
    if (pose === 'tipUp' && !faceUp) {
      this.calibrationStep.value = { step: 'failed', reason: 'Do the face-up step first.' };
      return;
    }
    this.calibrationStep.value = { step: 'capturing', pose };

    let capture: RawCapture;
    try {
      capture = await this.requestStaticCapture();
    } catch (error) {
      this.calibrationStep.value = { step: 'failed', reason: errorMessage(error) };
      return;
    }
    const result = extractStaticPose(toImuSeries(capture));
    if (!result.ok) {
      this.calibrationStep.value = { step: 'failed', reason: result.reason };
      return;
    }
    if (pose === 'faceUp' || !faceUp) {
      this.calibrationStep.value = { step: 'awaitTipUp', faceUp: result.pose };
      return;
    }
    const calibrated = calibrateMount(faceUp, result.pose);
    if (!calibrated.ok) {
      this.calibrationStep.value = { step: 'failed', reason: calibrated.reason };
      return;
    }
    await this.deps.repository.saveCalibration(this.deviceKey(), calibrated.calibration);
    this.calibration.value = calibrated.calibration;
    this.calibrationStep.value = { step: 'done' };
  }

  resetCalibrationFlow(): void {
    this.calibrationStep.value = { step: 'idle' };
  }

  private deviceKey(): string {
    return this.deviceName.value ?? 'unknown';
  }

  private requestStaticCapture(): Promise<RawCapture> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error('Connect the sensor first.'));
    return new Promise<RawCapture>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStatic = null;
        reject(new Error('The sensor did not respond. Check the connection.'));
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
            void this.handleSwing(event.capture);
          }
          break;
      }
    }
  }

  private async handleSwing(capture: RawCapture): Promise<void> {
    const calibration = this.calibration.value;
    const session = this.session.value;
    if (!calibration) {
      this.appendLog('Swing ignored: calibrate the sensor first.');
      return;
    }
    if (!session) return;

    const settings = this.settings.value;
    let analysis;
    try {
      analysis = analyzeCapture(
        capture,
        calibration,
        { ...DEFAULT_ANALYSIS_PARAMS, leverRadiusM: settings.leverRadiusM },
        this.rules,
      );
    } catch (error) {
      this.appendLog(`Analysis failed: ${errorMessage(error)}`);
      return;
    }

    const record: StrokeRecord = {
      id: this.newId(),
      sessionId: session.id,
      capture,
      metrics: analysis.metrics,
      cue: analysis.cue,
    };
    this.strokes.value = [...this.strokes.value, record];

    if (settings.mode === 'drill' && (analysis.cue.severity === 'fix' || settings.speakGood)) {
      this.deps.speaker.say(analysis.cue.text, settings.speechRate);
    }
    await this.deps.repository.saveStroke(record);
  }

  private appendLog(message: string): void {
    const line = `${new Date(this.now()).toLocaleTimeString()} ${message}`;
    this.log.value = [line, ...this.log.value].slice(0, MAX_LOG);
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
