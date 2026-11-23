import type { CaptureKind } from '../domain/types';
import {
  AXES_PER_SAMPLE,
  CaptureKindCode,
  MessageLength,
  MessageType,
  PROTOCOL_VERSION,
} from './constants';

export interface CaptureBeginMessage {
  readonly type: 'captureBegin';
  readonly protocolVersion: number;
  readonly sequence: number;
  readonly kind: CaptureKind;
  readonly sampleRateHz: number;
  readonly accelMicroGPerLsb: number;
  readonly gyroMilliDpsPerLsb: number;
  readonly triggerIndex: number;
}

export interface SampleMessage {
  readonly type: 'sample';
  readonly sequence: number;
  readonly index: number;
  /** ax, ay, az, gx, gy, gz in raw counts. */
  readonly values: readonly [number, number, number, number, number, number];
}

export interface CaptureEndMessage {
  readonly type: 'captureEnd';
  readonly sequence: number;
  readonly sampleCount: number;
  readonly crc32: number;
}

export interface StatusMessage {
  readonly type: 'status';
  readonly protocolVersion: number;
  readonly batteryPercent: number;
  readonly temperatureC: number;
  readonly firmwareVersion: string;
}

export type Message = CaptureBeginMessage | SampleMessage | CaptureEndMessage | StatusMessage;

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

function expectLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length < expected) {
    throw new ProtocolError(`${what}: expected ${expected} bytes, got ${bytes.length}`);
  }
}

function kindFromCode(code: number): CaptureKind {
  if (code === CaptureKindCode.Swing) return 'swing';
  if (code === CaptureKindCode.Static) return 'static';
  throw new ProtocolError(`Unknown capture kind ${code}`);
}

/** Decodes one BLE notification payload. Throws {@link ProtocolError} on malformed input. */
export function decodeMessage(bytes: Uint8Array): Message {
  if (bytes.length === 0) {
    throw new ProtocolError('Empty message');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);

  switch (type) {
    case MessageType.CaptureBegin: {
      expectLength(bytes, MessageLength.CaptureBegin, 'CaptureBegin');
      const protocolVersion = view.getUint8(1);
      if (protocolVersion !== PROTOCOL_VERSION) {
        throw new ProtocolError(
          `Unsupported protocol version ${protocolVersion} (app supports ${PROTOCOL_VERSION})`,
        );
      }
      return {
        type: 'captureBegin',
        protocolVersion,
        sequence: view.getUint8(2),
        kind: kindFromCode(view.getUint8(3)),
        sampleRateHz: view.getUint16(4, true),
        accelMicroGPerLsb: view.getUint16(6, true),
        gyroMilliDpsPerLsb: view.getUint16(8, true),
        triggerIndex: view.getUint16(10, true),
      };
    }
    case MessageType.Sample: {
      expectLength(bytes, MessageLength.Sample, 'Sample');
      const values = Array.from({ length: AXES_PER_SAMPLE }, (_, i) =>
        view.getInt16(4 + 2 * i, true),
      ) as unknown as SampleMessage['values'];
      return {
        type: 'sample',
        sequence: view.getUint8(1),
        index: view.getUint16(2, true),
        values,
      };
    }
    case MessageType.CaptureEnd: {
      expectLength(bytes, MessageLength.CaptureEnd, 'CaptureEnd');
      return {
        type: 'captureEnd',
        sequence: view.getUint8(1),
        sampleCount: view.getUint16(2, true),
        crc32: view.getUint32(4, true),
      };
    }
    case MessageType.Status: {
      expectLength(bytes, MessageLength.Status, 'Status');
      return {
        type: 'status',
        protocolVersion: view.getUint8(1),
        batteryPercent: view.getUint8(2),
        temperatureC: view.getInt8(3),
        firmwareVersion: `${view.getUint8(4)}.${view.getUint8(5)}.${view.getUint8(6)}`,
      };
    }
    default:
      throw new ProtocolError(`Unknown message type 0x${type.toString(16).padStart(2, '0')}`);
  }
}

/* ------------------------------------------------------------------------ */
/* Encoders. The firmware is the production encoder; these mirror it for the */
/* simulator and for tests.                                                  */
/* ------------------------------------------------------------------------ */

export function encodeCaptureBegin(m: Omit<CaptureBeginMessage, 'type'>): Uint8Array {
  const bytes = new Uint8Array(MessageLength.CaptureBegin);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MessageType.CaptureBegin);
  view.setUint8(1, m.protocolVersion);
  view.setUint8(2, m.sequence & 0xff);
  view.setUint8(3, m.kind === 'swing' ? CaptureKindCode.Swing : CaptureKindCode.Static);
  view.setUint16(4, m.sampleRateHz, true);
  view.setUint16(6, m.accelMicroGPerLsb, true);
  view.setUint16(8, m.gyroMilliDpsPerLsb, true);
  view.setUint16(10, m.triggerIndex, true);
  return bytes;
}

export function encodeSample(m: Omit<SampleMessage, 'type'>): Uint8Array {
  const bytes = new Uint8Array(MessageLength.Sample);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MessageType.Sample);
  view.setUint8(1, m.sequence & 0xff);
  view.setUint16(2, m.index, true);
  m.values.forEach((v, i) => {
    view.setInt16(4 + 2 * i, v, true);
  });
  return bytes;
}

export function encodeCaptureEnd(m: Omit<CaptureEndMessage, 'type'>): Uint8Array {
  const bytes = new Uint8Array(MessageLength.CaptureEnd);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MessageType.CaptureEnd);
  view.setUint8(1, m.sequence & 0xff);
  view.setUint16(2, m.sampleCount, true);
  view.setUint32(4, m.crc32 >>> 0, true);
  return bytes;
}

export function encodeStatus(m: Omit<StatusMessage, 'type'>): Uint8Array {
  const [major = 0, minor = 0, patch = 0] = m.firmwareVersion.split('.').map(Number);
  const bytes = new Uint8Array(MessageLength.Status);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MessageType.Status);
  view.setUint8(1, m.protocolVersion);
  view.setUint8(2, m.batteryPercent);
  view.setInt8(3, m.temperatureC);
  view.setUint8(4, major);
  view.setUint8(5, minor);
  view.setUint8(6, patch);
  return bytes;
}
