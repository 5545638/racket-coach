import type { MountCalibration } from '../domain/types';
import type { Vec3 } from '../math/vec3';
import { encodeCapture } from '../protocol/assembler';
import { Command, PROTOCOL_VERSION } from '../protocol/constants';
import { encodeStatus } from '../protocol/messages';
import { createRandom } from '../simulation/random';
import {
  BUTT_CAP_MOUNT,
  DEFAULT_SWING,
  simulateStatic,
  simulateSwing,
} from '../simulation/swingModel';
import { type ConnectionState, Emitter, type SensorTransport, type Unsubscribe } from './transport';

export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

const browserScheduler: Scheduler = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => {
    globalThis.clearInterval(h as ReturnType<typeof setInterval>);
  },
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
};

/**
 * Mounting used by the simulated sensor: the PCB in the butt cap, its z axis
 * pointing out of the cap (racket −x) and its x axis along the forehand face
 * normal (racket +z).
 */
export const SIMULATED_MOUNT: MountCalibration = {
  version: 1,
  racketFromSensor: [
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 0],
  ],
  gyroBias: [0.004, -0.006, 0.002],
  createdAt: '1970-01-01T00:00:00.000Z',
};

const SAMPLE_RATE_HZ = 104;

/**
 * A virtual sensor that speaks the real wire protocol. Used for the in-app
 * demo mode and for end-to-end tests of the capture pipeline. Static captures
 * alternate between the two calibration poses.
 */
export class SimulatedTransport implements SensorTransport {
  private readonly packets = new Emitter<Uint8Array>();
  private readonly states = new Emitter<ConnectionState>();
  private currentState: ConnectionState = 'disconnected';
  private timer: unknown = null;
  private sequence = 0;
  private staticCount = 0;
  private readonly random: () => number;

  constructor(
    private readonly swingIntervalMs = 4000,
    private readonly scheduler: Scheduler = browserScheduler,
    seed = 42,
  ) {
    this.random = createRandom(seed);
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get deviceName(): string {
    return 'RacketCoach (demo)';
  }

  connect(): Promise<void> {
    this.setState('connected');
    this.timer = this.scheduler.setInterval(() => {
      this.emitSwing();
    }, this.swingIntervalMs);
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    if (this.timer !== null) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    this.setState('disconnected');
    return Promise.resolve();
  }

  send(command: Uint8Array): Promise<void> {
    if (this.currentState !== 'connected') return Promise.reject(new Error('Not connected'));
    switch (command[0]) {
      case Command.RequestStatus:
        this.scheduler.setTimeout(() => {
          this.packets.emit(
            encodeStatus({
              protocolVersion: PROTOCOL_VERSION,
              batteryPercent: 87,
              temperatureC: 21,
              firmwareVersion: '0.1.0',
            }),
          );
        }, 0);
        break;
      case Command.CaptureStatic: {
        const up: Vec3 = this.staticCount % 2 === 0 ? [0, 0, 1] : [1, 0, 0];
        this.staticCount += 1;
        const capture = simulateStatic(up, SIMULATED_MOUNT, SAMPLE_RATE_HZ, SAMPLE_RATE_HZ);
        this.scheduler.setTimeout(() => {
          this.emitAll(encodeCapture({ ...capture, sequence: this.nextSequence() }));
        }, 1000);
        break;
      }
      default:
        break;
    }
    return Promise.resolve();
  }

  onPacket(listener: (packet: Uint8Array) => void): Unsubscribe {
    return this.packets.on(listener);
  }

  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.states.on(listener);
  }

  /** Simulates the link dropping (out of range, sensor reset). */
  simulateLinkLoss(): void {
    if (this.timer !== null) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    this.setState('disconnected');
  }

  /** Emits one randomised swing immediately. */
  emitSwing(): void {
    const r = this.random;
    const backhand = r() < 0.35;
    const slice = r() < 0.2;
    const { capture } = simulateSwing(
      {
        ...DEFAULT_SWING,
        // Butt-cap sensor: weak acceleration transient, clear jolt in rotation,
        // and the rate drop the ball causes at contact (DEFAULT_SWING).
        ...BUTT_CAP_MOUNT,
        hittingFace: backhand ? 'backhand' : 'forehand',
        faceTiltDeg: (slice ? 12 : -12) + (r() - 0.5) * 30,
        swingPathDeg: (slice ? -22 : 25) + (r() - 0.5) * (slice ? 20 : 36),
        peakRateRadPerS: 20 + r() * 10,
        peakOffsetS: r() < 0.2 ? -0.07 : 0,
        fallSigmaS: r() < 0.2 ? 0.06 : 0.16,
        backswingRateRadPerS: 5 + r() * 3,
        backswingLeadS: r() < 0.2 ? 0.3 : 0.5 + r() * 0.2,
        rollRateRadPerS: (r() - 0.5) * 10,
        noiseStd: { accelG: 0.01, gyroDps: 0.3 },
        seed: Math.floor(r() * 1e9),
      },
      {
        sampleRateHz: SAMPLE_RATE_HZ,
        durationS: 2.6,
        contactTimeS: 1.7,
        mount: SIMULATED_MOUNT,
        triggerRadPerS: (300 * Math.PI) / 180,
      },
      this.nextSequence(),
    );
    this.emitAll(encodeCapture(capture));
  }

  private emitAll(packets: readonly Uint8Array[]): void {
    for (const p of packets) this.packets.emit(p);
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) & 0xff;
    return this.sequence;
  }

  private setState(state: ConnectionState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.states.emit(state);
  }
}
