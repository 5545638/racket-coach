import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../../src/protocol/crc32';

export const FIRMWARE_PATH = fileURLToPath(
  new URL('../../../firmware/puck/src/main.js', import.meta.url),
);

export interface AccelEvent {
  readonly acc: { x: number; y: number; z: number };
  readonly gyro: { x: number; y: number; z: number };
}

/**
 * Runs the Espruino firmware on Node with minimal fakes of the Espruino APIs
 * it uses (NRF, Puck, E, LED2, setTimeout). Notifications are captured as the
 * byte payloads the phone would receive.
 */
export class FirmwareHarness {
  readonly notifications: Uint8Array[] = [];
  readonly registerWrites: [number, number][] = [];
  accelOn = false;
  /** When > 0, every n-th notify call fails as if the BLE TX queue were full. */
  failEvery = 0;

  private notifyCalls = 0;
  private timers: (() => void)[] = [];
  private readonly handlers = new Map<string, (arg?: unknown) => void>();
  private controlWrite: ((evt: { data: ArrayBuffer }) => void) | null = null;

  constructor() {
    const source = readFileSync(FIRMWARE_PATH, 'utf8');
    const NRF = {
      setServices: (
        services: Record<string, Record<string, { onWrite?: (e: { data: ArrayBuffer }) => void }>>,
      ) => {
        for (const service of Object.values(services)) {
          for (const characteristic of Object.values(service)) {
            if (characteristic.onWrite) this.controlWrite = characteristic.onWrite;
          }
        }
      },
      setAdvertising: () => undefined,
      getAddress: () => 'e7:8a:12:34:56:78 random',
      setConnectionInterval: () => undefined,
      on: (event: string, fn: (arg?: unknown) => void) => this.handlers.set(`nrf:${event}`, fn),
      updateServices: (services: Record<string, Record<string, { value: Uint8Array }>>) => {
        this.notifyCalls++;
        if (this.failEvery > 0 && this.notifyCalls % this.failEvery === 0) {
          throw new Error('BLE error 0x13 (NRF_ERROR_RESOURCES)');
        }
        for (const service of Object.values(services)) {
          for (const characteristic of Object.values(service)) {
            this.notifications.push(Uint8Array.from(characteristic.value));
          }
        }
      },
    };
    const Puck = {
      on: (event: string, fn: (arg?: unknown) => void) => this.handlers.set(`puck:${event}`, fn),
      accelOn: () => {
        this.accelOn = true;
      },
      accelOff: () => {
        this.accelOn = false;
      },
      accelWr: (reg: number, value: number) => this.registerWrites.push([reg, value]),
      getBatteryPercentage: () => 88,
    };
    const E = {
      CRC32: (data: Uint8Array) => crc32(data),
      getTemperature: () => 22.4,
    };
    const LED2 = { write: () => undefined };
    const setTimeoutFake = (fn: () => void) => {
      this.timers.push(fn);
      return this.timers.length;
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('NRF', 'Puck', 'E', 'LED2', 'setTimeout', source) as (
      ...args: unknown[]
    ) => void;
    run(NRF, Puck, E, LED2, setTimeoutFake);
  }

  connect(): void {
    this.handlers.get('nrf:connect')?.();
  }

  disconnect(): void {
    this.handlers.get('nrf:disconnect')?.();
  }

  write(command: number): void {
    this.controlWrite?.({ data: Uint8Array.of(command).buffer });
  }

  sample(event: AccelEvent): void {
    this.handlers.get('puck:accel')?.(event);
  }

  /** Runs pending timers until none remain (bounded to catch livelocks). */
  flushTimers(maxRounds = 10_000): void {
    for (let i = 0; i < maxRounds && this.timers.length > 0; i++) {
      const pending = this.timers;
      this.timers = [];
      for (const fn of pending) fn();
    }
    if (this.timers.length > 0) throw new Error('Timers did not settle');
  }
}
