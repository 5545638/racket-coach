import {
  CONTROL_CHARACTERISTIC_UUID,
  DATA_CHARACTERISTIC_UUID,
  DEVICE_NAME_PREFIX,
  SERVICE_UUID,
} from '../protocol/constants';
import { type ConnectionState, Emitter, type SensorTransport, type Unsubscribe } from './transport';

export class BluetoothUnavailableError extends Error {
  override readonly name = 'BluetoothUnavailableError';
}

/**
 * Web Bluetooth implementation. On iPhone this requires a browser that
 * implements Web Bluetooth (e.g. Bluefy); Safari does not.
 */
export class WebBluetoothTransport implements SensorTransport {
  private readonly packets = new Emitter<Uint8Array>();
  private readonly states = new Emitter<ConnectionState>();
  private device: BluetoothDevice | null = null;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private data: BluetoothRemoteGATTCharacteristic | null = null;
  private currentState: ConnectionState = 'disconnected';

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
    if (!this.control) throw new Error('Not connected');
    await this.control.writeValueWithResponse(new Uint8Array(command));
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
    this.packets.emit(
      new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)),
    );
  };

  private readonly handleDisconnect = (): void => {
    this.cleanup();
    this.setState('disconnected');
  };

  private cleanup(): void {
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
