import { describe, expect, it } from 'vitest';
import { CaptureAssembler, encodeCapture } from '../../src/protocol/assembler';
import { PROTOCOL_VERSION } from '../../src/protocol/constants';
import { crc32 } from '../../src/protocol/crc32';
import {
  ProtocolError,
  decodeMessage,
  encodeCaptureBegin,
  encodeSample,
  encodeStatus,
} from '../../src/protocol/messages';
import { DEFAULT_SWING, simulateSwing } from '../../src/simulation/swingModel';
import { SETUP } from '../helpers';

const capture = simulateSwing(DEFAULT_SWING, SETUP, 7).capture;

describe('crc32', () => {
  it('matches the CRC-32/ISO-HDLC check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('message codec', () => {
  it('round-trips every message type', () => {
    const begin = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: 3,
      kind: 'static' as const,
      sampleRateHz: 104,
      accelMicroGPerLsb: 488,
      gyroMilliDpsPerLsb: 70,
      triggerIndex: 12,
    };
    expect(decodeMessage(encodeCaptureBegin(begin))).toEqual({ type: 'captureBegin', ...begin });

    const sample = { sequence: 3, index: 513, values: [-32768, 32767, 0, 1, -1, 1234] as const };
    expect(decodeMessage(encodeSample(sample))).toEqual({ type: 'sample', ...sample });

    const status = {
      protocolVersion: 1,
      batteryPercent: 64,
      temperatureC: -5,
      firmwareVersion: '1.2.3',
    };
    expect(decodeMessage(encodeStatus(status))).toEqual({ type: 'status', ...status });
  });

  it('rejects unknown types, short frames and future protocol versions', () => {
    expect(() => decodeMessage(Uint8Array.of(0x7f))).toThrow(ProtocolError);
    expect(() => decodeMessage(Uint8Array.of(0x02, 0, 0))).toThrow(/expected 16 bytes/);
    const future = encodeCaptureBegin({
      protocolVersion: PROTOCOL_VERSION + 1,
      sequence: 0,
      kind: 'swing',
      sampleRateHz: 104,
      accelMicroGPerLsb: 488,
      gyroMilliDpsPerLsb: 70,
      triggerIndex: 0,
    });
    expect(() => decodeMessage(future)).toThrow(/Unsupported protocol version/);
  });

  it('decodes from a view into a larger buffer', () => {
    const packet = encodeSample({ sequence: 1, index: 2, values: [1, 2, 3, 4, 5, 6] });
    const padded = new Uint8Array(packet.length + 8);
    padded.set(packet, 4);
    expect(decodeMessage(padded.subarray(4, 4 + packet.length))).toMatchObject({ index: 2 });
  });
});

describe('CaptureAssembler', () => {
  const feed = (packets: readonly Uint8Array[]) => {
    const assembler = new CaptureAssembler(() => 1234);
    return packets.flatMap((p) => assembler.push(p));
  };

  it('reassembles a complete capture bit-exactly', () => {
    const events = feed(encodeCapture(capture));
    expect(events).toHaveLength(1);
    const [event] = events;
    if (event?.type !== 'capture') throw new Error('expected a capture');
    expect(event.capture.samples).toEqual(capture.samples);
    expect(event.capture.triggerIndex).toBe(capture.triggerIndex);
    expect(event.capture.accelGPerLsb).toBeCloseTo(capture.accelGPerLsb, 9);
    expect(event.capture.receivedAt).toBe(1234);
  });

  it('drops a capture with a missing sample', () => {
    const packets = encodeCapture(capture);
    packets.splice(10, 1);
    expect(feed(packets)).toEqual([
      { type: 'error', reason: expect.stringContaining('expected sample 9, got 10') as string },
    ]);
  });

  it('drops a capture whose payload was corrupted', () => {
    const packets = encodeCapture(capture);
    const corrupted = packets[5]?.slice() ?? new Uint8Array();
    corrupted[6] = (corrupted[6] ?? 0) ^ 0x01;
    packets[5] = corrupted;
    expect(feed(packets)[0]).toMatchObject({
      type: 'error',
      reason: expect.stringContaining('CRC') as string,
    });
  });

  it('reports an interrupted capture and still accepts the next one', () => {
    const first = encodeCapture(capture).slice(0, 20);
    const second = encodeCapture({ ...capture, sequence: 8 });
    const events = feed([...first, ...second]);
    expect(events.map((e) => e.type)).toEqual(['error', 'capture']);
  });

  it('turns malformed packets into errors instead of throwing', () => {
    expect(feed([Uint8Array.of(0xee)])[0]).toMatchObject({ type: 'error' });
    expect(
      feed([encodeSample({ sequence: 1, index: 0, values: [0, 0, 0, 0, 0, 0] })])[0],
    ).toMatchObject({
      type: 'error',
      reason: 'Sample outside of an active capture',
    });
  });
});
