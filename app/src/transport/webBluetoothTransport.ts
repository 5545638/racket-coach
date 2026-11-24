import {
  CONTROL_CHARACTERISTIC_UUID,
  DATA_CHARACTERISTIC_UUID,
  DEVICE_NAME_PREFIX,
  SERVICE_UUID,
  type SensorModeCode,
} from '../protocol/constants';
import { type LinkClock, type LinkEvent, SensorLink, browserClock } from '../protocol/link';
import { type ConnectionState, Emitter, type SensorTransport, type Unsubscribe } from './transport';

export class BluetoothUnavailableError extends Error {
  override readonly name = 'BluetoothUnavailableError';
}

/**
 * Web Bluetooth implementation. On iPhone this requires a browser that
 * implements Web Bluetooth (e.g. Bluefy); Safari does not.
 *
 * It owns the protocol link (protocol/link.ts): right after notifications are
 * enabled it sends HELLO (write without response), answers the PROBE length
 * handshake, sends ACK/NAK/DONE for v2 captures and falls back to v1 when the
 * firmware does not answer HELLO within 500 ms. Decoded events go out through
 * onEvent; raw packets are still available through onPacket.
 */
export class WebBluetoothTransport implements SensorTransport {
  private readonly packets = new Emitter<Uint8Array>();
  private readonly events = new Emitter<LinkEvent>();
  private link: SensorLink | null = null;
  private mode: SensorModeCode | null = null;
  /** GATT operations must not overlap: all writes go through this chain. */
  private writes: Promise<void> = Promise.resolve();
  private readonly states = new Emitter<ConnectionState>();
  private device: BluetoothDevice | null = null;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private data: BluetoothRemoteGATTCharacteristic | null = null;
  private currentState: ConnectionState = 'disconnected';

  constructor(private readonly clock: LinkClock = browserClock) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get deviceName(): string | null {
    return this.device?.name ?? null;
  }

  async connect(): Promise<void> {
    if (!WebBluetoothTransport.isSupported()) {
      throw new BluetoothUnavailableError(
        'This browser has no Web Bluetooth. On iPhone, open the app in Bluefy.',
      );
    }
    this.setState('connecting');
    try {
      this.device ??= await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
        optionalServices: [SERVICE_UUID],
      });
      // removeEventListener first: connect() may run again for the same device.
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      const server = await this.connectGatt(this.device);
      const service = await server.getPrimaryService(SERVICE_UUID);
      this.data = await service.getCharacteristic(DATA_CHARACTERISTIC_UUID);
      this.control = await service.getCharacteristic(CONTROL_CHARACTERISTIC_UUID);
      this.data.addEventListener('characteristicvaluechanged', this.handleNotification);
      await this.data.startNotifications();
      this.startLink();
      this.setState('connected');
    } catch (error) {
      this.cleanup();
      this.setState('disconnected');
      throw error;
    }
  }

  /**
   * Closes the link but remembers the device, so the next connect() (and
   * automatic reconnects) skip the browser's device picker.
   */
  disconnect(): Promise<void> {
    const device = this.device;
    this.cleanup();
    device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    device?.gatt?.disconnect();
    this.setState('disconnected');
    return Promise.resolve();
  }

  async send(command: Uint8Array): Promise<void> {
    const control = this.control;
    if (!control) throw new Error('Not connected');
    await this.enqueue(() => control.writeValueWithResponse(new Uint8Array(command)));
  }

  onEvent(listener: (event: LinkEvent) => void): Unsubscribe {
    return this.events.on(listener);
  }

  setSensorMode(mode: SensorModeCode): void {
    this.mode = mode;
    this.link?.setMode(mode);
  }

  /** Bench test (docs/bring-up.md); results arrive as 'bench' events. */
  bench(test: number, param = 0): void {
    this.link?.bench(test, param);
  }

  private startLink(): void {
    this.link?.stop();
    const link = new SensorLink((bytes) => {
      this.writeWithoutResponse(bytes);
    }, this.clock);
    link.onEvent((event) => {
      this.events.emit(event);
    });
    if (this.mode !== null) link.setMode(this.mode);
    this.link = link;
    link.start();
  }

  /** Protocol commands: write without response, serialised, errors only logged. */
  private writeWithoutResponse(bytes: Uint8Array): void {
    const control = this.control;
    if (!control) return;
    const value = new Uint8Array(bytes);
    this.enqueue(() =>
      typeof control.writeValueWithoutResponse === 'function'
        ? control.writeValueWithoutResponse(value)
        : control.writeValue(value),
    ).catch((error: unknown) => {
      console.warn('Sensor command failed', error);
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const result = this.writes.then(op);
    this.writes = result.catch(() => undefined);
    return result;
  }

  onPacket(listener: (packet: Uint8Array) => void): Unsubscribe {
    return this.packets.on(listener);
  }

  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.states.on(listener);
  }

  private async connectGatt(device: BluetoothDevice): Promise<BluetoothRemoteGATTServer> {
    if (!device.gatt) throw new Error('Device has no GATT server');
    return device.gatt.connect();
  }

  private readonly handleNotification = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    // Copy: the browser may reuse the underlying buffer for the next notification.
    const packet = new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
    this.packets.emit(packet);
    this.link?.push(packet);
  };

  private readonly handleDisconnect = (): void => {
    this.cleanup();
    this.setState('disconnected');
  };

  private cleanup(): void {
    this.link?.stop();
    this.link = null;
    this.data?.removeEventListener('characteristicvaluechanged', this.handleNotification);
    this.data = null;
    this.control = null;
  }

  private setState(state: ConnectionState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.states.emit(state);
  }
}
