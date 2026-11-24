import { describe, expect, it } from 'vitest';
import type { AssemblerEvent } from '../../src/protocol/assembler';
import { V2Assembler, type V2CaptureMessage } from '../../src/protocol/assemblerV2';
import { DoneStatus, NAK_RESEND_HEADERS } from '../../src/protocol/constants';
import { crc32 } from '../../src/protocol/crc32';
import { ProtocolError } from '../../src/protocol/messages';
import {
  type BeginAMessage,
  type BeginBMessage,
  decodeCommandV2,
  decodeMessageV2,
  encodeAck,
  encodeBeginA,
  encodeBeginB,
  encodeBench,
  encodeBenchResult,
  encodeData,
  encodeDone,
  encodeEnd,
  encodeHello,
  encodeMode,
  encodeNak,
  encodePacing,
  encodeProbe,
  encodeStatus2,
  isV2MessageType,
} from '../../src/protocol/messagesV2';

describe('v2 message codec', () => {
  it('round-trips every sensor → app message', () => {
    const status2 = {
      protocolVersion: 2,
      batteryPercent: 77,
      firmwareVersion: '0.2.0',
      mode: 1,
      payloadBytes: 48,
      flags: 9,
      temperatureRaw: -666,
      fifoOverruns: 3,
      droppedCaptures: 65535,
      freeVars: 1234,
      errors: 7,
    };
    expect(decodeMessageV2(encodeStatus2(status2))).toEqual({ type: 'status2', ...status2 });
    const a = {
      capId: 200,
      kind: 'swing' as const,
      mode: 1,
      nFrames: 229,
      hStart: 185,
      hFrames: 31,
      peakFrame: 200,
      payloadBytes: 48,
      nBlocks: 73,
      streamLength: 3492,
      crc32: 0xdeadbeef,
    };
    expect(decodeMessageV2(encodeBeginA(a))).toEqual({ type: 'beginA', ...a });
    const b = {
      capId: 200,
      framePeriodNs: 9_600_000,
      tsLast: 0xffffff,
      accelMicroGPerLsb: 488,
      gyroMilliDpsPerLsb: 70,
      temperatureRaw: -1,
      filterCfg: 2,
      flags: 0x0f,
    };
    expect(decodeMessageV2(encodeBeginB(b))).toEqual({ type: 'beginB', ...b });
    expect(decodeMessageV2(encodeData(0x2b, 7, Uint8Array.of(1, 2, 3)))).toEqual({
      type: 'data',
      capNibble: 0xb,
      block: 7,
      payload: Uint8Array.of(1, 2, 3),
    });
    expect(decodeMessageV2(encodeEnd(5, 73))).toEqual({ type: 'end', capId: 5, nBlocks: 73 });
    expect(decodeMessageV2(encodeProbe(20))).toEqual({ type: 'probe', length: 20 });
    const payload = Uint8Array.from({ length: 17 }, (_, i) => i);
    expect(decodeMessageV2(encodeBenchResult(5, 0xff, payload))).toEqual({
      type: 'benchResult',
      test: 5,
      part: 0xff,
      payload,
    });
  });

  it('round-trips every app → sensor command', () => {
    expect(decodeCommandV2(encodeHello(2, 50))).toEqual({
      type: 'hello',
      protoMax: 2,
      probeLenReceived: 50,
    });
    expect(decodeCommandV2(encodeAck(3, 9, 24))).toEqual({
      type: 'ack',
      capId: 3,
      nextBlock: 9,
      credit: 24,
    });
    expect(decodeCommandV2(encodeNak(3, [1, 5, NAK_RESEND_HEADERS]))).toEqual({
      type: 'nak',
      capId: 3,
      blocks: [1, 5, 0xfe],
    });
    expect(decodeCommandV2(encodeDone(3, DoneStatus.Abandoned))).toEqual({
      type: 'done',
      capId: 3,
      status: 2,
    });
    expect(decodeCommandV2(encodePacing(2, 30))).toEqual({
      type: 'pacing',
      blocksPerTick: 2,
      tickMs: 30,
    });
    expect(decodeCommandV2(encodeMode(1))).toEqual({ type: 'mode', mode: 1 });
    expect(decodeCommandV2(encodeBench(4, 600))).toEqual({ type: 'bench', test: 4, param: 600 });
    expect(() =>
      encodeNak(
        1,
        Array.from({ length: 17 }, (_, i) => i),
      ),
    ).toThrow(RangeError);
    expect(decodeCommandV2(Uint8Array.of(0x01))).toBeNull();
  });

  it('classifies message types and rejects short frames', () => {
    expect([0x01, 0x02, 0x03, 0x10].some(isV2MessageType)).toBe(false);
    expect([0x18, 0x19, 0x20, 0x21, 0x22, 0x28, 0x30, 0x3f].every(isV2MessageType)).toBe(true);
    expect(() => decodeMessageV2(Uint8Array.of(0x20, 1))).toThrow(ProtocolError);
    expect(() => decodeMessageV2(Uint8Array.of(0x30, 1))).toThrow(/Data/);
  });
});

/* ---------------------------------------------------------------- assembler */

const P = 18;

function makeCapture(nFrames: number, hFrames: number, capId = 1) {
  const len = nFrames * 12 + hFrames * 24;
  const stream = Uint8Array.from({ length: len }, (_, i) => (i * 7 + capId) & 0xff);
  const a: Omit<BeginAMessage, 'type'> = {
    capId,
    kind: 'swing',
    mode: hFrames > 0 ? 1 : 0,
    nFrames,
    hStart: 2,
    hFrames,
    peakFrame: 3,
    payloadBytes: P,
    nBlocks: Math.ceil(len / P),
    streamLength: len,
    crc32: crc32(stream),
  };
  const b: Omit<BeginBMessage, 'type'> = {
    capId,
    framePeriodNs: 9_600_000,
    tsLast: 1000,
    accelMicroGPerLsb: 488,
    gyroMilliDpsPerLsb: 70,
    temperatureRaw: 256,
    filterCfg: 1,
    flags: 0,
  };
  const blocks = Array.from({ length: a.nBlocks }, (_, k) =>
    encodeData(capId, k, stream.subarray(k * P, Math.min(len, (k + 1) * P))),
  );
  return { a, b, stream, blocks, beginA: encodeBeginA(a), beginB: encodeBeginB(b) };
}

function rig() {
  let now = 0;
  const sent: ReturnType<typeof decodeCommandV2>[] = [];
  const asm = new V2Assembler({
    now: () => now,
    send: (c) => sent.push(decodeCommandV2(c)),
  });
  const events: AssemblerEvent[] = [];
  const push = (bytes: Uint8Array) => {
    events.push(...asm.push(decodeMessageV2(bytes) as V2CaptureMessage));
  };
  return {
    asm,
    sent,
    events,
    push,
    advance: (ms: number) => {
      now += ms;
      events.push(...asm.tick());
    },
  };
}

describe('V2Assembler', () => {
  it('assembles a capture, ACKs every 8 blocks and sends DONE', () => {
    const r = rig();
    const c = makeCapture(10, 2);
    r.push(c.beginA);
    r.push(c.beginB);
    for (const b of c.blocks) r.push(b);
    expect(r.events).toHaveLength(1);
    const capture = r.events[0]?.type === 'capture' ? r.events[0].capture : null;
    expect(capture?.samples.length).toBe(60);
    expect(capture?.gyroHr?.data.length).toBe(24);
    expect(capture?.temperatureC).toBe(26);
    const acks = r.sent.filter((s) => s?.type === 'ack');
    expect(acks.length).toBe(Math.floor(c.blocks.length / 8) + 1);
    expect(r.sent.at(-1)).toEqual({ type: 'done', capId: 1, status: DoneStatus.Ok });
    expect(r.asm.busy).toBe(false);
  });

  it('NAKs holes, missing headers after END, and completes after the resends', () => {
    const r = rig();
    const c = makeCapture(20, 0, 7);
    r.push(c.beginB); // BEGIN_A lost
    c.blocks.forEach((b, k) => {
      if (k !== 3 && k !== 10) r.push(b);
    });
    r.advance(100); // ACK tick: hole 3 and 10 are below the highest received
    expect(r.sent).toContainEqual({ type: 'nak', capId: 7, blocks: [3, 10] });
    r.push(encodeEnd(7, c.a.nBlocks));
    expect(r.sent.at(-1)).toEqual({ type: 'nak', capId: 7, blocks: [NAK_RESEND_HEADERS, 3, 10] });
    r.push(c.beginA);
    r.push(c.blocks[3] ?? new Uint8Array());
    expect(r.events).toHaveLength(0);
    r.push(c.blocks[10] ?? new Uint8Array());
    expect(r.events.map((e) => e.type)).toEqual(['capture']);
  });

  it('rejects a CRC mismatch with DONE status 1', () => {
    const r = rig();
    const c = makeCapture(4, 0);
    r.push(encodeBeginA({ ...c.a, crc32: c.a.crc32 ^ 1 }));
    r.push(c.beginB);
    for (const b of c.blocks) r.push(b);
    expect(r.events[0]).toMatchObject({ type: 'error', reason: /CRC mismatch/ });
    expect(r.sent.at(-1)).toEqual({ type: 'done', capId: 1, status: DoneStatus.CrcMismatch });
  });

  it('abandons a capture after 5 s without packets', () => {
    const r = rig();
    const c = makeCapture(10, 0);
    r.push(c.beginA);
    for (let t = 0; t < 5000; t += 50) r.advance(50);
    expect(r.events).toContainEqual({ type: 'error', reason: 'Capture 1 timed out' });
    expect(r.sent.at(-1)).toEqual({ type: 'done', capId: 1, status: DoneStatus.Abandoned });
    expect(r.asm.busy).toBe(false);
  });

  it('repeats DONE when the sensor repeats END of a completed capture', () => {
    const r = rig();
    const c = makeCapture(3, 0);
    for (const p of [c.beginA, c.beginB, ...c.blocks]) r.push(p);
    r.sent.length = 0;
    r.push(c.blocks[0] ?? new Uint8Array()); // a late resend: ignored
    r.push(encodeEnd(1, c.a.nBlocks));
    expect(r.sent).toEqual([{ type: 'done', capId: 1, status: DoneStatus.Ok }]);
    expect(r.events.map((e) => e.type)).toEqual(['capture']);
  });

  it('derives sample times from tsLast and unwraps the 24-bit timer', () => {
    const r = rig();
    const first = makeCapture(3, 0, 1);
    const second = makeCapture(3, 0, 2);
    for (const p of [first.beginA, encodeBeginB({ ...first.b, tsLast: 0xfffff0 }), ...first.blocks])
      r.push(p);
    for (const p of [second.beginA, encodeBeginB({ ...second.b, tsLast: 16 }), ...second.blocks])
      r.push(p);
    const times = r.events.map((e) => (e.type === 'capture' ? e.capture.sampleTimesUs : null));
    expect(times[0]).toEqual([0xfffff0 * 25 - 19200, 0xfffff0 * 25 - 9600, 0xfffff0 * 25]);
    expect(times[1]?.at(-1)).toBe((2 ** 24 + 16) * 25);
  });

  it('rejects an inconsistent header', () => {
    const r = rig();
    const c = makeCapture(4, 0);
    r.push(encodeBeginA({ ...c.a, nBlocks: c.a.nBlocks + 1 }));
    expect(r.events[0]).toMatchObject({ type: 'error' });
    expect(r.sent.at(-1)).toMatchObject({ type: 'done', status: DoneStatus.Abandoned });
  });
});
