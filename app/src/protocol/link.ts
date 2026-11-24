import type { SensorDiagnostics } from '../domain/types';
import { type AssemblerEvent, CaptureAssembler } from './assembler';
import { V2Assembler, type V2AssemblerOptions } from './assemblerV2';
import {
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_V2,
  SensorMode,
  type SensorModeCode,
} from './constants';
import { ProtocolError } from './messages';
import {
  type BenchResultMessage,
  type Status2Message,
  decodeMessageV2,
  encodeBench,
  encodeHello,
  encodeMode,
  encodePacing,
  isV2MessageType,
} from './messagesV2';

export type LinkEvent =
  | AssemblerEvent
  | { readonly type: 'diagnostics'; readonly diagnostics: SensorDiagnostics }
  | { readonly type: 'bench'; readonly result: BenchResultMessage }
  /** The protocol was negotiated: 2 after PROBE/STATUS2, 1 after the HELLO timeout. */
  | { readonly type: 'protocol'; readonly version: 1 | 2 };

export interface LinkClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserClock: LinkClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => {
    globalThis.clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface SensorLinkOptions {
  readonly helloTimeoutMs?: number;
  /** Period of the v2 assembler timers (ACK cadence, NAKs, timeout), ms. */
  readonly tickMs?: number;
  /** Wall clock for `receivedAt`. */
  readonly wallClock?: () => number;
  readonly assembler?: Partial<Omit<V2AssemblerOptions, 'now' | 'send' | 'wallClock'>>;
}

type LinkState = 'idle' | 'pending' | 1 | 2;

/**
 * App side of the sensor link: negotiates the protocol and reassembles
 * captures in either version.
 *
 * start() sends HELLO (protoMax 2, probe length 0). v2 firmware answers with
 * PROBE (50 bytes, truncated by the link to MTU − 3) and STATUS2; the link
 * answers with HELLO carrying the received PROBE length, from which the sensor
 * picks its block size. HELLO is repeated once after 250 ms; without an answer
 * within 500 ms the link falls back to v1 and says so with HELLO (protoMax 1),
 * which v1 firmware ignores (it only marks the app as subscribed).
 */
export class SensorLink {
  private state: LinkState = 'idle';
  private readonly v1: CaptureAssembler;
  private readonly v2: V2Assembler;
  private readonly listeners = new Set<(event: LinkEvent) => void>();
  private helloTimer: unknown = null;
  private tickTimer: unknown = null;
  private mode: SensorModeCode | null = null;
  private readonly helloTimeoutMs: number;
  private readonly tickMs: number;

  constructor(
    private readonly write: (command: Uint8Array) => void,
    private readonly clock: LinkClock,
    options: SensorLinkOptions = {},
  ) {
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.tickMs = options.tickMs ?? 50;
    const wallClock = options.wallClock ?? Date.now;
    this.v1 = new CaptureAssembler(wallClock);
    this.v2 = new V2Assembler({
      ...options.assembler,
      now: () => this.clock.now(),
      wallClock,
      send: (c) => {
        this.write(c);
      },
    });
  }

  /** Negotiated protocol version, or null while negotiating. */
  get version(): 1 | 2 | null {
    return this.state === 1 || this.state === 2 ? this.state : null;
  }

  onEvent(listener: (event: LinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    this.stop();
    this.state = 'pending';
    this.write(encodeHello(PROTOCOL_VERSION_V2, 0));
    // One retry halfway, in case the answer was dropped from the sensor's TX queue.
    this.helloTimer = this.clock.setTimeout(
      () => {
        if (this.state !== 'pending') return;
        this.write(encodeHello(PROTOCOL_VERSION_V2, 0));
        this.helloTimer = this.clock.setTimeout(
          () => {
            this.helloTimer = null;
            if (this.state !== 'pending') return;
            this.state = PROTOCOL_VERSION;
            this.write(encodeHello(PROTOCOL_VERSION, 0)); // v2 firmware: stay on v1
            this.emit({ type: 'protocol', version: 1 });
          },
          this.helloTimeoutMs - Math.floor(this.helloTimeoutMs / 2),
        );
      },
      Math.floor(this.helloTimeoutMs / 2),
    );
  }

  stop(): void {
    if (this.helloTimer !== null) this.clock.clearTimeout(this.helloTimer);
    if (this.tickTimer !== null) this.clock.clearTimeout(this.tickTimer);
    this.helloTimer = null;
    this.tickTimer = null;
    this.state = 'idle';
  }

  /** Requests an IMU mode; sent now on v2, or as soon as v2 is negotiated. */
  setMode(mode: SensorModeCode): void {
    this.mode = mode;
    if (this.state === 2) this.write(encodeMode(mode));
  }

  /** Runs a bench test (docs/bring-up.md); results arrive as 'bench' events. v2 only. */
  bench(test: number, param = 0): void {
    if (this.state === 2) this.write(encodeBench(test, param));
  }

  /** Sets the sensor's transmit pacing. v2 only. */
  pacing(blocksPerTick: number, tickMs: number): void {
    if (this.state === 2) this.write(encodePacing(blocksPerTick, tickMs));
  }

  /** Feeds one notification payload. */
  push(bytes: Uint8Array): void {
    const type = bytes[0];
    if (type === undefined) return;
    if (!isV2MessageType(type)) {
      this.emitAll(this.v1.push(bytes));
      return;
    }
    if (this.state !== 'pending' && this.state !== 2) return; // late answer after fallback
    let m;
    try {
      m = decodeMessageV2(bytes);
    } catch (e) {
      if (e instanceof ProtocolError) {
        this.emit({ type: 'error', reason: e.message });
        return;
      }
      throw e;
    }
    switch (m.type) {
      case 'probe':
        this.write(encodeHello(PROTOCOL_VERSION_V2, m.length));
        this.upgrade();
        break;
      case 'status2':
        this.upgrade();
        this.v2.firmwareVersion = m.firmwareVersion;
        this.emit({ type: 'diagnostics', diagnostics: toDiagnostics(m) });
        break;
      case 'benchResult':
        this.emit({ type: 'bench', result: m });
        break;
      default:
        this.emitAll(this.v2.push(m));
    }
  }

  private upgrade(): void {
    if (this.state !== 'pending') return;
    if (this.helloTimer !== null) this.clock.clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.state = PROTOCOL_VERSION_V2;
    this.emit({ type: 'protocol', version: 2 });
    if (this.mode !== null) this.write(encodeMode(this.mode));
    this.scheduleTick();
  }

  private scheduleTick(): void {
    this.tickTimer = this.clock.setTimeout(() => {
      this.tickTimer = null;
      if (this.state !== 2) return;
      this.emitAll(this.v2.tick());
      this.scheduleTick();
    }, this.tickMs);
  }

  private emitAll(events: readonly LinkEvent[]): void {
    for (const e of events) this.emit(e);
  }

  private emit(event: LinkEvent): void {
    for (const l of this.listeners) l(event);
  }
}

function toDiagnostics(m: Status2Message): SensorDiagnostics {
  return {
    protocolVersion: m.protocolVersion,
    firmwareVersion: m.firmwareVersion,
    batteryPercent: m.batteryPercent,
    mode: m.mode === SensorMode.M416 ? 'M416' : 'M104',
    payloadBytes: m.payloadBytes,
    temperatureC: 25 + m.temperatureRaw / 256,
    fifoOverruns: m.fifoOverruns,
    droppedCaptures: m.droppedCaptures,
    freeVars: m.freeVars,
    errors: m.errors,
  };
}
