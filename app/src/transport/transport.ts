import type { SensorModeCode } from '../protocol/constants';
import type { LinkEvent } from '../protocol/link';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export type Unsubscribe = () => void;

/**
 * A byte-oriented link to the racket sensor. The app depends only on this
 * interface, so the analysis stack runs identically against real hardware,
 * the simulator, or recorded sessions.
 */
export interface SensorTransport {
  readonly state: ConnectionState;
  /** Human-readable device name once connected. */
  readonly deviceName: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(command: Uint8Array): Promise<void>;
  /** Called once per BLE notification payload. */
  onPacket(listener: (packet: Uint8Array) => void): Unsubscribe;
  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe;
  /**
   * Transports that negotiate the protocol themselves (protocol v2, see
   * protocol/link.ts) deliver decoded events here; the app then ignores
   * onPacket for captures. Transports without it deliver v1 packets only.
   */
  onEvent?(listener: (event: LinkEvent) => void): Unsubscribe;
  /** Requests an IMU mode (v2 firmware only; ignored otherwise). */
  setSensorMode?(mode: SensorModeCode): void;
  /** Runs a firmware bench test (v2 only); results arrive as 'bench' events. */
  bench?(test: number, param?: number): void;
}

/** Minimal typed event emitter used by transport implementations. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}
