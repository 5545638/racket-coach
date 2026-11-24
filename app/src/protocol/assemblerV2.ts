import type { RawCapture } from '../domain/types';
import type { AssemblerEvent } from './assembler';
import {
  ACK_EVERY_BLOCKS,
  ACK_INTERVAL_MS,
  DEFAULT_CREDIT,
  DoneStatus,
  H_SAMPLES_PER_FRAME,
  NAK_MAX_ENTRIES,
  NAK_RESEND_HEADERS,
  PROTOCOL_VERSION_V2,
  SensorMode,
  TIMESTAMP_US_PER_LSB,
  TIMESTAMP_WRAP,
} from './constants';
import { crc32 } from './crc32';
import {
  type BeginAMessage,
  type BeginBMessage,
  type DataMessage,
  type EndMessage,
  encodeAck,
  encodeDone,
  encodeNak,
} from './messagesV2';

export interface V2AssemblerOptions {
  /** Monotonic time, ms (drives ACK cadence, NAK throttling and timeouts). */
  readonly now: () => number;
  /** Wall-clock time for `receivedAt`, ms since epoch. Defaults to `now`. */
  readonly wallClock?: () => number;
  /** Sends a command to the sensor (write without response). */
  readonly send: (command: Uint8Array) => void;
  readonly credit?: number;
  readonly ackEveryBlocks?: number;
  readonly ackIntervalMs?: number;
  /** A block is NAKed again at most this often; also the stall time before NAKing the window. */
  readonly retryMs?: number;
  /** A capture with no packet for this long is abandoned. */
  readonly timeoutMs?: number;
}

/** Nominal frame rate reported as `sampleRateHz`, like v1 (true rate: 1e9 / framePeriodNs). */
const NOMINAL_FRAME_RATE_HZ = 104;
const L_BYTES_PER_FRAME = 12;
const H_BYTES_PER_FRAME = H_SAMPLES_PER_FRAME * 6;

interface Rx {
  readonly nibble: number;
  capId: number | null;
  a: BeginAMessage | null;
  b: BeginBMessage | null;
  readonly blocks: Map<number, Uint8Array>;
  /** Cumulative: all blocks below it have arrived. */
  nextBlock: number;
  highest: number;
  sinceAck: number;
  lastAckAt: number;
  lastPacketAt: number;
  /** Block index (or NAK_RESEND_HEADERS) → time it was last NAKed. */
  readonly nakedAt: Map<number, number>;
}

export type V2CaptureMessage = BeginAMessage | BeginBMessage | DataMessage | EndMessage;

/**
 * Receives v2 captures: collects blocks in a bitmap (map) per capture, sends
 * a cumulative ACK every 8 blocks or 100 ms, NAKs holes (BLE is ordered, so
 * a hole below the highest received block is lost for sure), NAKs the whole
 * open window after a stall or an END, verifies the CRC over the stream and
 * emits a {@link RawCapture}. Call {@link tick} periodically (≈ every 50 ms).
 */
export class V2Assembler {
  private readonly rx = new Map<number, Rx>();
  /** Low nibble → capture id of recently completed captures (late END → DONE again). */
  private readonly completed = new Map<number, number>();
  private lastTsLast: number | null = null;
  private wraps = 0;
  private readonly credit: number;
  private readonly ackEvery: number;
  private readonly ackIntervalMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly wallClock: () => number;
  /** Firmware version from STATUS2, copied into captures. */
  firmwareVersion: string | null = null;

  constructor(private readonly options: V2AssemblerOptions) {
    this.credit = options.credit ?? DEFAULT_CREDIT;
    this.ackEvery = options.ackEveryBlocks ?? ACK_EVERY_BLOCKS;
    this.ackIntervalMs = options.ackIntervalMs ?? ACK_INTERVAL_MS;
    this.retryMs = options.retryMs ?? 300;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.wallClock = options.wallClock ?? options.now;
  }

  /** True while a capture is being received. */
  get busy(): boolean {
    return this.rx.size > 0;
  }

  push(message: V2CaptureMessage): AssemblerEvent[] {
    switch (message.type) {
      case 'beginA':
        return this.onBeginA(message);
      case 'beginB':
        return this.onBeginB(message);
      case 'data':
        return this.onData(message);
      case 'end':
        return this.onEnd(message);
    }
  }

  /** Timers: periodic ACK, hole and stall NAKs, timeout. */
  tick(): AssemblerEvent[] {
    const now = this.options.now();
    const events: AssemblerEvent[] = [];
    for (const r of [...this.rx.values()]) {
      if (now - r.lastPacketAt >= this.timeoutMs) {
        this.rx.delete(r.nibble);
        this.send(encodeDone(this.idOf(r), DoneStatus.Abandoned));
        events.push({ type: 'error', reason: `Capture ${this.idOf(r)} timed out` });
        continue;
      }
      if (now - r.lastAckAt >= this.ackIntervalMs) this.sendAck(r);
      const stalled = now - r.lastPacketAt >= this.retryMs;
      this.nakMissing(r, stalled, false);
    }
    return events;
  }

  private onBeginA(m: BeginAMessage): AssemblerEvent[] {
    const nibble = m.capId & 0x0f;
    if (this.completed.get(nibble) === m.capId) {
      this.send(encodeDone(m.capId, DoneStatus.Ok)); // our DONE was lost
      return [];
    }
    const events: AssemblerEvent[] = [];
    const expected = m.nFrames * L_BYTES_PER_FRAME + m.hFrames * H_BYTES_PER_FRAME;
    const blocks = m.payloadBytes > 0 ? Math.ceil(m.streamLength / m.payloadBytes) : -1;
    if (m.nFrames === 0 || m.streamLength !== expected || blocks !== m.nBlocks) {
      this.rx.delete(nibble);
      this.send(encodeDone(m.capId, DoneStatus.Abandoned));
      return [{ type: 'error', reason: `Capture ${m.capId}: inconsistent header` }];
    }
    let r = this.rx.get(nibble);
    if (r?.capId !== null && r?.capId !== undefined && r.capId !== m.capId) {
      events.push({ type: 'error', reason: `Capture ${r.capId} replaced by ${m.capId}` });
      r = undefined;
    }
    r ??= this.open(nibble);
    r.capId = m.capId;
    r.a = m;
    r.lastPacketAt = this.options.now();
    // Blocks may have arrived before the header: drop any that do not fit.
    for (const [k, payload] of r.blocks) {
      if (payload.length !== this.blockLength(m, k)) r.blocks.delete(k);
    }
    this.advance(r);
    return [...events, ...this.tryComplete(r)];
  }

  private onBeginB(m: BeginBMessage): AssemblerEvent[] {
    const nibble = m.capId & 0x0f;
    if (this.completed.get(nibble) === m.capId) return [];
    let r = this.rx.get(nibble);
    if (r?.capId !== null && r?.capId !== undefined && r.capId !== m.capId) r = undefined;
    r ??= this.open(nibble);
    r.capId = m.capId;
    r.b = m;
    r.lastPacketAt = this.options.now();
    return this.tryComplete(r);
  }

  private onData(m: DataMessage): AssemblerEvent[] {
    let r = this.rx.get(m.capNibble);
    if (!r) {
      // Late resend of a completed capture, or a capture whose headers were lost.
      if (this.completed.has(m.capNibble)) return [];
      r = this.open(m.capNibble);
    }
    r.lastPacketAt = this.options.now();
    if (r.a && (m.block >= r.a.nBlocks || m.payload.length !== this.blockLength(r.a, m.block))) {
      return []; // malformed block: it stays missing and is NAKed
    }
    if (!r.blocks.has(m.block)) {
      r.blocks.set(m.block, m.payload.slice());
      r.highest = Math.max(r.highest, m.block);
      this.advance(r);
    }
    r.sinceAck++;
    const done = this.tryComplete(r);
    if (done.length > 0) return done;
    if (r.sinceAck >= this.ackEvery) this.sendAck(r);
    return [];
  }

  private onEnd(m: EndMessage): AssemblerEvent[] {
    const nibble = m.capId & 0x0f;
    let r = this.rx.get(nibble);
    if (!r) {
      if (this.completed.get(nibble) === m.capId) {
        this.send(encodeDone(m.capId, DoneStatus.Ok)); // our DONE was lost
        return [];
      }
      r = this.open(nibble);
    }
    r.capId ??= m.capId;
    r.lastPacketAt = this.options.now();
    // Everything sent before END has arrived or is lost (BLE is ordered).
    this.nakMissing(r, true, true);
    return [];
  }

  private open(nibble: number): Rx {
    const now = this.options.now();
    const r: Rx = {
      nibble,
      capId: null,
      a: null,
      b: null,
      blocks: new Map(),
      nextBlock: 0,
      highest: -1,
      sinceAck: 0,
      lastAckAt: now,
      lastPacketAt: now,
      nakedAt: new Map(),
    };
    this.rx.set(nibble, r);
    return r;
  }

  private blockLength(a: BeginAMessage, k: number): number {
    return Math.min(a.payloadBytes, a.streamLength - k * a.payloadBytes);
  }

  private advance(r: Rx): void {
    while (r.blocks.has(r.nextBlock)) r.nextBlock++;
  }

  private idOf(r: Rx): number {
    return r.capId ?? r.nibble;
  }

  private send(command: Uint8Array): void {
    this.options.send(command);
  }

  private sendAck(r: Rx): void {
    const next = r.a ? Math.min(r.nextBlock, r.a.nBlocks) : r.nextBlock;
    this.send(encodeAck(this.idOf(r), next, this.credit));
    r.sinceAck = 0;
    r.lastAckAt = this.options.now();
  }

  /**
   * NAKs missing headers and blocks. Holes below the highest received block
   * are always candidates; after a stall or END also the rest of the credit
   * window (stall) or of the capture (END). Each block at most once per
   * retryMs, unless `force` (END: the sensor finished a round).
   */
  private nakMissing(r: Rx, includeWindow: boolean, force: boolean): void {
    const now = this.options.now();
    const due = (k: number): boolean => {
      const at = r.nakedAt.get(k);
      return force || at === undefined || now - at >= this.retryMs;
    };
    const list: number[] = [];
    if ((!r.a || !r.b) && includeWindow && due(NAK_RESEND_HEADERS)) list.push(NAK_RESEND_HEADERS);
    let end = r.highest;
    if (includeWindow && r.a) {
      end = force ? r.a.nBlocks - 1 : Math.min(r.a.nBlocks, r.nextBlock + this.credit) - 1;
    }
    for (let k = r.nextBlock; k <= end; k++) {
      if (!r.blocks.has(k) && due(k)) list.push(k);
    }
    if (list.length === 0) return;
    for (const k of list) r.nakedAt.set(k, now);
    for (let i = 0; i < list.length; i += NAK_MAX_ENTRIES) {
      this.send(encodeNak(this.idOf(r), list.slice(i, i + NAK_MAX_ENTRIES)));
    }
  }

  private tryComplete(r: Rx): AssemblerEvent[] {
    const { a, b } = r;
    if (!a || !b || r.nextBlock < a.nBlocks) return [];
    this.rx.delete(r.nibble);
    const stream = new Uint8Array(a.streamLength);
    for (let k = 0; k < a.nBlocks; k++) {
      const block = r.blocks.get(k);
      if (block) stream.set(block, k * a.payloadBytes);
    }
    const actual = crc32(stream);
    if (actual !== a.crc32) {
      this.send(encodeDone(a.capId, DoneStatus.CrcMismatch));
      return [
        {
          type: 'error',
          reason: `Capture ${a.capId} dropped: CRC mismatch (expected ${hex(a.crc32)}, got ${hex(actual)})`,
        },
      ];
    }
    this.send(encodeAck(a.capId, a.nBlocks, this.credit));
    this.send(encodeDone(a.capId, DoneStatus.Ok));
    this.completed.set(r.nibble, a.capId);
    return [{ type: 'capture', capture: this.toCapture(a, b, stream) }];
  }

  private toCapture(a: BeginAMessage, b: BeginBMessage, stream: Uint8Array): RawCapture {
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    const samples = new Int16Array(a.nFrames * 6);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(2 * i, true);
    const hOffset = a.nFrames * L_BYTES_PER_FRAME;
    const hData = new Int16Array(a.hFrames * H_SAMPLES_PER_FRAME * 3);
    for (let i = 0; i < hData.length; i++) hData[i] = view.getInt16(hOffset + 2 * i, true);

    if (this.lastTsLast !== null && b.tsLast < this.lastTsLast) this.wraps++;
    this.lastTsLast = b.tsLast;
    const tsLastUs = (this.wraps * TIMESTAMP_WRAP + b.tsLast) * TIMESTAMP_US_PER_LSB;
    const periodUs = b.framePeriodNs / 1000;
    const sampleTimesUs = Array.from({ length: a.nFrames }, (_, f) =>
      Math.round(tsLastUs - (a.nFrames - 1 - f) * periodUs),
    );

    return {
      kind: a.kind,
      sequence: a.capId,
      sampleRateHz: NOMINAL_FRAME_RATE_HZ,
      accelGPerLsb: b.accelMicroGPerLsb / 1e6,
      gyroDpsPerLsb: b.gyroMilliDpsPerLsb / 1e3,
      // v2 anchors the window on the peak rate; it doubles as trigger index.
      triggerIndex: a.kind === 'swing' ? a.peakFrame : 0,
      samples,
      receivedAt: this.wallClock(),
      protocolVersion: PROTOCOL_VERSION_V2,
      mode: a.mode === SensorMode.M416 ? 'M416' : 'M104',
      framePeriodNs: b.framePeriodNs,
      sampleTimesUs,
      ...(a.hFrames > 0
        ? {
            gyroHr: {
              startFrame: a.hStart,
              samplesPerFrame: H_SAMPLES_PER_FRAME,
              data: hData,
            },
          }
        : {}),
      temperatureRaw: b.temperatureRaw,
      temperatureC: 25 + b.temperatureRaw / 256,
      flags: b.flags,
      accelUgPerLsb: b.accelMicroGPerLsb,
      gyroMdpsPerLsb: b.gyroMilliDpsPerLsb,
      ...(this.firmwareVersion !== null ? { firmwareVersion: this.firmwareVersion } : {}),
    };
  }
}

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;
