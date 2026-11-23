import type { RawCapture, SensorStatus } from '../domain/types';
import { AXES_PER_SAMPLE, MAX_SAMPLES_PER_CAPTURE, PROTOCOL_VERSION } from './constants';
import { crc32 } from './crc32';
import {
  type CaptureBeginMessage,
  type Message,
  ProtocolError,
  decodeMessage,
  encodeCaptureBegin,
  encodeCaptureEnd,
  encodeSample,
} from './messages';

export type AssemblerEvent =
  | { readonly type: 'capture'; readonly capture: RawCapture }
  | { readonly type: 'status'; readonly status: SensorStatus }
  | { readonly type: 'error'; readonly reason: string };

interface InProgress {
  readonly header: CaptureBeginMessage;
  readonly values: number[];
  nextIndex: number;
  broken: string | null;
}

/**
 * Reassembles the per-sample notification stream into complete captures.
 *
 * BLE notifications arrive in order within a connection, but the sensor can
 * still drop messages when its TX queue is full. Every capture is therefore
 * validated by sample index continuity, sample count and CRC-32 before it is
 * emitted; anything else is reported as an error and discarded.
 */
export class CaptureAssembler {
  private current: InProgress | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Feeds one notification payload; returns the events it completes. */
  push(bytes: Uint8Array): AssemblerEvent[] {
    let message: Message;
    try {
      message = decodeMessage(bytes);
    } catch (e) {
      if (e instanceof ProtocolError) {
        return [{ type: 'error', reason: e.message }];
      }
      throw e;
    }

    switch (message.type) {
      case 'status':
        return [
          {
            type: 'status',
            status: {
              protocolVersion: message.protocolVersion,
              batteryPercent: message.batteryPercent,
              temperatureC: message.temperatureC,
              firmwareVersion: message.firmwareVersion,
            },
          },
        ];

      case 'captureBegin': {
        const events: AssemblerEvent[] = [];
        if (this.current) {
          events.push({
            type: 'error',
            reason: `Capture ${this.current.header.sequence} interrupted by a new capture`,
          });
        }
        this.current = { header: message, values: [], nextIndex: 0, broken: null };
        return events;
      }

      case 'sample': {
        const c = this.current;
        if (!c || message.sequence !== c.header.sequence) {
          return [{ type: 'error', reason: 'Sample outside of an active capture' }];
        }
        if (c.broken) return [];
        if (message.index !== c.nextIndex) {
          c.broken = `expected sample ${c.nextIndex}, got ${message.index}`;
          return [];
        }
        if (c.nextIndex >= MAX_SAMPLES_PER_CAPTURE) {
          c.broken = `more than ${MAX_SAMPLES_PER_CAPTURE} samples`;
          return [];
        }
        c.values.push(...message.values);
        c.nextIndex += 1;
        return [];
      }

      case 'captureEnd': {
        const c = this.current;
        this.current = null;
        if (!c || message.sequence !== c.header.sequence) {
          return [{ type: 'error', reason: 'Capture end without a matching begin' }];
        }
        const failure = c.broken ?? this.validateEnd(c, message.sampleCount, message.crc32);
        if (failure) {
          return [{ type: 'error', reason: `Capture ${c.header.sequence} dropped: ${failure}` }];
        }
        return [{ type: 'capture', capture: this.toCapture(c) }];
      }
    }
  }

  private validateEnd(c: InProgress, sampleCount: number, expectedCrc: number): string | null {
    if (sampleCount !== c.nextIndex) {
      return `sensor sent ${sampleCount} samples, received ${c.nextIndex}`;
    }
    if (c.header.triggerIndex > sampleCount) {
      return `trigger index ${c.header.triggerIndex} beyond ${sampleCount} samples`;
    }
    const samples = Int16Array.from(c.values);
    const actual = crc32(new Uint8Array(samples.buffer));
    if (actual !== expectedCrc) {
      return `CRC mismatch (expected ${hex(expectedCrc)}, got ${hex(actual)})`;
    }
    return null;
  }

  private toCapture(c: InProgress): RawCapture {
    const h = c.header;
    return {
      kind: h.kind,
      sequence: h.sequence,
      sampleRateHz: h.sampleRateHz,
      accelGPerLsb: h.accelMicroGPerLsb / 1e6,
      gyroDpsPerLsb: h.gyroMilliDpsPerLsb / 1e3,
      triggerIndex: h.triggerIndex,
      samples: Int16Array.from(c.values),
      receivedAt: this.now(),
    };
  }
}

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

/**
 * Serialises a capture into the exact notification sequence the firmware
 * produces. Used by the simulator and tests.
 */
export function encodeCapture(capture: RawCapture): Uint8Array[] {
  const sampleCount = capture.samples.length / AXES_PER_SAMPLE;
  const packets: Uint8Array[] = [
    encodeCaptureBegin({
      protocolVersion: PROTOCOL_VERSION,
      sequence: capture.sequence,
      kind: capture.kind,
      sampleRateHz: capture.sampleRateHz,
      accelMicroGPerLsb: Math.round(capture.accelGPerLsb * 1e6),
      gyroMilliDpsPerLsb: Math.round(capture.gyroDpsPerLsb * 1e3),
      triggerIndex: capture.triggerIndex,
    }),
  ];
  for (let i = 0; i < sampleCount; i++) {
    const o = i * AXES_PER_SAMPLE;
    const s = capture.samples;
    packets.push(
      encodeSample({
        sequence: capture.sequence,
        index: i,
        values: [
          s[o] ?? 0,
          s[o + 1] ?? 0,
          s[o + 2] ?? 0,
          s[o + 3] ?? 0,
          s[o + 4] ?? 0,
          s[o + 5] ?? 0,
        ],
      }),
    );
  }
  packets.push(
    encodeCaptureEnd({
      sequence: capture.sequence,
      sampleCount,
      crc32: crc32(
        new Uint8Array(
          capture.samples.buffer,
          capture.samples.byteOffset,
          capture.samples.byteLength,
        ),
      ),
    }),
  );
  return packets;
}
