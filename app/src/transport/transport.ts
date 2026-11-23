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
