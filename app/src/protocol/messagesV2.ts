/**
 * Protocol v2 messages (docs/ble-protocol.md, "Version 2"). All integers are
 * little-endian. The firmware (firmware/puck/src/main.js) is the production
 * encoder of sensor → app messages and decoder of commands; the mirrors here
 * serve the app, the tests and the simulator.
 */
import type { CaptureKind } from '../domain/types';
import {
  CaptureKindCode,
  CommandV2,
  MessageLengthV2,
  MessageTypeV2,
  NAK_MAX_ENTRIES,
  type SensorModeCode,
} from './constants';
import { ProtocolError } from './messages';

export interface Status2Message {
  readonly type: 'status2';
  readonly protocolVersion: number;
  readonly batteryPercent: number;
  readonly firmwareVersion: string;
  readonly mode: number;
  /** DATA payload bytes per block. */
  readonly payloadBytes: number;
  /** b0 IMU running, b1/b2 outbox A/B busy, b3 v2 session active. */
  readonly flags: number;
  /** IMU OUT_TEMP: 256 LSB/°C, 0 = 25 °C. */
  readonly temperatureRaw: number;
  readonly fifoOverruns: number;
  readonly droppedCaptures: number;
  readonly freeVars: number;
  readonly errors: number;
}

export interface ProbeMessage {
  readonly type: 'probe';
  /** Bytes that arrived; less than 50 when the link MTU truncated it. */
  readonly length: number;
}

export interface BeginAMessage {
  readonly type: 'beginA';
  readonly capId: number;
  readonly kind: CaptureKind;
  readonly mode: number;
  readonly nFrames: number;
  readonly hStart: number;
  readonly hFrames: number;
  readonly peakFrame: number;
  readonly payloadBytes: number;
  readonly nBlocks: number;
  readonly streamLength: number;
  readonly crc32: number;
}

export interface BeginBMessage {
  readonly type: 'beginB';
  readonly capId: number;
  readonly framePeriodNs: number;
  /** IMU timestamp of the last frame, 25 µs units, 24 bits. */
  readonly tsLast: number;
  readonly accelMicroGPerLsb: number;
  readonly gyroMilliDpsPerLsb: number;
  readonly temperatureRaw: number;
  readonly filterCfg: number;
  readonly flags: number;
}

export interface DataMessage {
  readonly type: 'data';
  /** Low four bits of the capture id. */
  readonly capNibble: number;
  readonly block: number;
  readonly payload: Uint8Array;
}

export interface EndMessage {
  readonly type: 'end';
  readonly capId: number;
  readonly nBlocks: number;
}

export interface BenchResultMessage {
  readonly type: 'benchResult';
  readonly test: number;
  readonly part: number;
  /** 17 bytes; layout per test in docs/ble-protocol.md. */
  readonly payload: Uint8Array;
}

export type MessageV2 =
  | Status2Message
  | ProbeMessage
  | BeginAMessage
  | BeginBMessage
  | DataMessage
  | EndMessage
  | BenchResultMessage;

/** True for the first byte of any v2 sensor → app message. */
export function isV2MessageType(type: number): boolean {
  return (
    type === MessageTypeV2.Status2 ||
    type === MessageTypeV2.Probe ||
    type === MessageTypeV2.BeginA ||
    type === MessageTypeV2.BeginB ||
    type === MessageTypeV2.End ||
    type === MessageTypeV2.BenchResult ||
    (type & 0xf0) === MessageTypeV2.Data
  );
}

function need(bytes: Uint8Array, n: number, what: string): void {
  if (bytes.length < n)
    throw new ProtocolError(`${what}: expected ${n} bytes, got ${bytes.length}`);
}

function kindFromCode(code: number): CaptureKind {
  if (code === CaptureKindCode.Swing) return 'swing';
  if (code === CaptureKindCode.Static) return 'static';
  throw new ProtocolError(`Unknown capture kind ${code}`);
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Decodes one v2 notification. Throws {@link ProtocolError} on malformed input. */
export function decodeMessageV2(bytes: Uint8Array): MessageV2 {
  if (bytes.length === 0) throw new ProtocolError('Empty message');
  const v = view(bytes);
  const type = v.getUint8(0);
  if ((type & 0xf0) === MessageTypeV2.Data) {
    need(bytes, MessageLengthV2.DataMin, 'Data');
    return {
      type: 'data',
      capNibble: type & 0x0f,
      block: v.getUint8(1),
      payload: bytes.subarray(2),
    };
  }
  switch (type) {
    case MessageTypeV2.Status2:
      need(bytes, MessageLengthV2.Status2, 'Status2');
      return {
        type: 'status2',
        protocolVersion: v.getUint8(1),
        batteryPercent: v.getUint8(2),
        firmwareVersion: `${v.getUint8(3)}.${v.getUint8(4)}.${v.getUint8(5)}`,
        mode: v.getUint8(6),
        payloadBytes: v.getUint8(7),
        flags: v.getUint8(8),
        temperatureRaw: v.getInt16(9, true),
        fifoOverruns: v.getUint16(11, true),
        droppedCaptures: v.getUint16(13, true),
        freeVars: v.getUint16(15, true),
        errors: v.getUint8(17),
      };
    case MessageTypeV2.Probe:
      return { type: 'probe', length: bytes.length };
    case MessageTypeV2.BeginA:
      need(bytes, MessageLengthV2.BeginA, 'BeginA');
      return {
        type: 'beginA',
        capId: v.getUint8(1),
        kind: kindFromCode(v.getUint8(2)),
        mode: v.getUint8(3),
        nFrames: v.getUint16(4, true),
        hStart: v.getUint16(6, true),
        hFrames: v.getUint16(8, true),
        peakFrame: v.getUint16(10, true),
        payloadBytes: v.getUint8(12),
        nBlocks: v.getUint8(13),
        streamLength: v.getUint16(14, true),
        crc32: v.getUint32(16, true),
      };
    case MessageTypeV2.BeginB:
      need(bytes, MessageLengthV2.BeginB, 'BeginB');
      return {
        type: 'beginB',
        capId: v.getUint8(1),
        framePeriodNs: v.getUint32(2, true),
        tsLast: v.getUint32(6, true),
        accelMicroGPerLsb: v.getUint16(10, true),
        gyroMilliDpsPerLsb: v.getUint16(12, true),
        temperatureRaw: v.getInt16(14, true),
        filterCfg: v.getUint8(16),
        flags: v.getUint8(17),
      };
    case MessageTypeV2.End:
      need(bytes, MessageLengthV2.End, 'End');
      return { type: 'end', capId: v.getUint8(1), nBlocks: v.getUint8(2) };
    case MessageTypeV2.BenchResult:
      need(bytes, MessageLengthV2.BenchResult, 'BenchResult');
      return {
        type: 'benchResult',
        test: v.getUint8(1),
        part: v.getUint8(2),
        payload: bytes.slice(3, MessageLengthV2.BenchResult),
      };
    default:
      throw new ProtocolError(`Unknown v2 message type 0x${type.toString(16).padStart(2, '0')}`);
  }
}

/* ----------------------------------------------- sensor → app encoders */

export function encodeStatus2(m: Omit<Status2Message, 'type'>): Uint8Array {
  const [major = 0, minor = 0, patch = 0] = m.firmwareVersion.split('.').map(Number);
  const b = new Uint8Array(MessageLengthV2.Status2);
  const v = view(b);
  v.setUint8(0, MessageTypeV2.Status2);
  v.setUint8(1, m.protocolVersion);
  v.setUint8(2, m.batteryPercent);
  v.setUint8(3, major);
  v.setUint8(4, minor);
  v.setUint8(5, patch);
  v.setUint8(6, m.mode);
  v.setUint8(7, m.payloadBytes);
  v.setUint8(8, m.flags);
  v.setInt16(9, m.temperatureRaw, true);
  v.setUint16(11, m.fifoOverruns, true);
  v.setUint16(13, m.droppedCaptures, true);
  v.setUint16(15, m.freeVars, true);
  v.setUint8(17, m.errors);
  return b;
}

export function encodeProbe(length: number = MessageLengthV2.Probe): Uint8Array {
  const b = new Uint8Array(length);
  b[0] = MessageTypeV2.Probe;
  for (let i = 1; i < length; i++) b[i] = i;
  return b;
}

export function encodeBeginA(m: Omit<BeginAMessage, 'type'>): Uint8Array {
  const b = new Uint8Array(MessageLengthV2.BeginA);
  const v = view(b);
  v.setUint8(0, MessageTypeV2.BeginA);
  v.setUint8(1, m.capId & 0xff);
  v.setUint8(2, m.kind === 'swing' ? CaptureKindCode.Swing : CaptureKindCode.Static);
  v.setUint8(3, m.mode);
  v.setUint16(4, m.nFrames, true);
  v.setUint16(6, m.hStart, true);
  v.setUint16(8, m.hFrames, true);
  v.setUint16(10, m.peakFrame, true);
  v.setUint8(12, m.payloadBytes);
  v.setUint8(13, m.nBlocks);
  v.setUint16(14, m.streamLength, true);
  v.setUint32(16, m.crc32 >>> 0, true);
  return b;
}

export function encodeBeginB(m: Omit<BeginBMessage, 'type'>): Uint8Array {
  const b = new Uint8Array(MessageLengthV2.BeginB);
  const v = view(b);
  v.setUint8(0, MessageTypeV2.BeginB);
  v.setUint8(1, m.capId & 0xff);
  v.setUint32(2, m.framePeriodNs, true);
  v.setUint32(6, m.tsLast, true);
  v.setUint16(10, m.accelMicroGPerLsb, true);
  v.setUint16(12, m.gyroMilliDpsPerLsb, true);
  v.setInt16(14, m.temperatureRaw, true);
  v.setUint8(16, m.filterCfg);
  v.setUint8(17, m.flags);
  return b;
}

export function encodeData(capId: number, block: number, payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(2 + payload.length);
  b[0] = MessageTypeV2.Data | (capId & 0x0f);
  b[1] = block;
  b.set(payload, 2);
  return b;
}

export function encodeEnd(capId: number, nBlocks: number): Uint8Array {
  return Uint8Array.of(MessageTypeV2.End, capId & 0xff, nBlocks);
}

export function encodeBenchResult(test: number, part: number, payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(MessageLengthV2.BenchResult);
  b[0] = MessageTypeV2.BenchResult;
  b[1] = test;
  b[2] = part;
  b.set(payload.subarray(0, 17), 3);
  return b;
}

/* --------------------------------------------- app → sensor commands */

export type CommandV2Message =
  | { readonly type: 'hello'; readonly protoMax: number; readonly probeLenReceived: number }
  | {
      readonly type: 'ack';
      readonly capId: number;
      readonly nextBlock: number;
      readonly credit: number;
    }
  | { readonly type: 'nak'; readonly capId: number; readonly blocks: readonly number[] }
  | { readonly type: 'done'; readonly capId: number; readonly status: number }
  | { readonly type: 'pacing'; readonly blocksPerTick: number; readonly tickMs: number }
  | { readonly type: 'mode'; readonly mode: number }
  | { readonly type: 'bench'; readonly test: number; readonly param: number };

export const encodeHello = (protoMax: number, probeLenReceived: number): Uint8Array =>
  Uint8Array.of(CommandV2.Hello, protoMax, probeLenReceived & 0xff);

export const encodeAck = (capId: number, nextBlock: number, credit: number): Uint8Array =>
  Uint8Array.of(CommandV2.Ack, capId & 0xff, nextBlock & 0xff, credit & 0xff);

export function encodeNak(capId: number, blocks: readonly number[]): Uint8Array {
  if (blocks.length > NAK_MAX_ENTRIES) {
    throw new RangeError(`NAK carries at most ${NAK_MAX_ENTRIES} blocks`);
  }
  return Uint8Array.of(CommandV2.Nak, capId & 0xff, blocks.length, ...blocks);
}

export const encodeDone = (capId: number, status: number): Uint8Array =>
  Uint8Array.of(CommandV2.Done, capId & 0xff, status);

export const encodePacing = (blocksPerTick: number, tickMs: number): Uint8Array =>
  Uint8Array.of(CommandV2.Pacing, blocksPerTick, tickMs);

export const encodeMode = (mode: SensorModeCode): Uint8Array => Uint8Array.of(CommandV2.Mode, mode);

export const encodeBench = (test: number, param = 0): Uint8Array =>
  Uint8Array.of(CommandV2.Bench, test, param & 0xff, (param >> 8) & 0xff);

/** Decodes an app → sensor v2 command (tests and diagnostics); null if not v2. */
export function decodeCommandV2(b: Uint8Array): CommandV2Message | null {
  const at = (i: number): number => b[i] ?? 0;
  switch (b[0]) {
    case CommandV2.Hello:
      return { type: 'hello', protoMax: at(1), probeLenReceived: at(2) };
    case CommandV2.Ack:
      return { type: 'ack', capId: at(1), nextBlock: at(2), credit: at(3) };
    case CommandV2.Nak:
      return { type: 'nak', capId: at(1), blocks: Array.from(b.subarray(3, 3 + at(2))) };
    case CommandV2.Done:
      return { type: 'done', capId: at(1), status: at(2) };
    case CommandV2.Pacing:
      return { type: 'pacing', blocksPerTick: at(1), tickMs: at(2) };
    case CommandV2.Mode:
      return { type: 'mode', mode: at(1) };
    case CommandV2.Bench:
      return { type: 'bench', test: at(1), param: at(2) | (at(3) << 8) };
    default:
      return null;
  }
}
