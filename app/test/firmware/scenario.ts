import { expect } from 'vitest';
import type { RawCapture } from '../../src/domain/types';
import { CaptureAssembler } from '../../src/protocol/assembler';
import { Command, type SensorModeCode, TIMESTAMP_WRAP } from '../../src/protocol/constants';
import { type LinkEvent, SensorLink, type SensorLinkOptions } from '../../src/protocol/link';
import { type BleOptions, FirmwareHarness, type ImuFrame, type Motion } from './firmwareHarness';

/** A v2 session: firmware in the harness, the real app link on the other end. */
export interface V2Session {
  readonly fw: FirmwareHarness;
  readonly link: SensorLink;
  readonly events: LinkEvent[];
  captures(): RawCapture[];
  errors(): string[];
}

export function startV2(
  options: {
    readonly ble?: Partial<BleOptions>;
    readonly mode?: SensorModeCode;
    readonly motion?: Motion;
    readonly link?: SensorLinkOptions;
    /** Runs before the link comes up (IMU model settings that apply at IMU start). */
    readonly before?: (fw: FirmwareHarness) => void;
  } = {},
): V2Session {
  const fw = new FirmwareHarness(options.ble);
  if (options.motion) fw.imu.motion = options.motion;
  options.before?.(fw);
  fw.connectLink();
  const events: LinkEvent[] = [];
  const link = new SensorLink(
    (b) => {
      fw.write(b);
    },
    fw.clock.linkClock,
    { wallClock: () => 0, ...options.link },
  );
  link.onEvent((e) => events.push(e));
  fw.onNotify((p) => {
    link.push(p);
  });
  if (options.mode !== undefined) link.setMode(options.mode);
  link.start();
  fw.write(Command.RequestStatus); // as the controller does right after connecting
  return {
    fw,
    link,
    events,
    captures: () => events.flatMap((e) => (e.type === 'capture' ? [e.capture] : [])),
    errors: () => events.flatMap((e) => (e.type === 'error' ? [e.reason] : [])),
  };
}

/** A v1 session: what the current app does without HELLO. */
export function startV1(
  options: { readonly ble?: Partial<BleOptions>; readonly motion?: Motion } = {},
) {
  const fw = new FirmwareHarness(options.ble);
  if (options.motion) fw.imu.motion = options.motion;
  const assembler = new CaptureAssembler(() => 0);
  const events: ReturnType<CaptureAssembler['push']> = [];
  fw.onNotify((p) => events.push(...assembler.push(p)));
  fw.connect();
  events.length = 0; // the status answer to connect()'s RequestStatus
  return {
    fw,
    events,
    captures: () => events.flatMap((e) => (e.type === 'capture' ? [e.capture] : [])),
  };
}

/** The L-section row (ax ay az gx gy gz) the firmware derives from one FIFO frame. */
export function lowRateRow(words: Int16Array): number[] {
  const w = (i: number): number => words[i] ?? 0;
  if (words.length === 6) return [w(3), w(4), w(5), w(0), w(1), w(2)];
  const mean = (a: number) => (w(a) + w(6 + a) + w(9 + a) + w(12 + a) + 2) >> 2;
  return [w(3), w(4), w(5), mean(0), mean(1), mean(2)];
}

/** The H-section row (G0..G3 x y z) of one M416 frame. */
export function highRateRow(words: Int16Array): number[] {
  return [0, 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => words[i] ?? 0);
}

/**
 * Locates the capture among the frames the IMU produced, using the IMU
 * timestamp of its last frame (± 2 frames: the sensor estimates it from the
 * poll timing), and asserts that L and H sections match bit for bit.
 * Returns the index of the capture's first frame in `frames`.
 */
export function expectBitExact(capture: RawCapture, frames: readonly ImuFrame[]): number {
  const n = capture.samples.length / 6;
  const times = capture.sampleTimesUs;
  if (!times) throw new Error('capture has no sampleTimesUs');
  const lastTicks = Math.round((times[n - 1] ?? 0) / 25) % TIMESTAMP_WRAP;
  const distance = (f: ImuFrame): number => {
    const d = Math.abs((f.tsTicks % TIMESTAMP_WRAP) - lastTicks);
    return Math.min(d, TIMESTAMP_WRAP - d);
  };
  let nearest = 0;
  frames.forEach((f, i) => {
    if (distance(f) < distance(frames[nearest] ?? f)) nearest = i;
  });
  const expected = (last: number): number[] =>
    frames.slice(last - n + 1, last + 1).flatMap((f) => lowRateRow(f.words));
  const actual = Array.from(capture.samples);
  const match = [0, -1, 1, -2, 2]
    .map((d) => nearest + d)
    .find((last) => {
      const e = expected(last);
      return e.length === actual.length && e.every((v, i) => v === actual[i]);
    });
  expect(match, 'L section matches the IMU frames near tsLast').toBeDefined();
  const first = (match ?? 0) - n + 1;
  if (capture.gyroHr) {
    const h = capture.gyroHr;
    const hFrames = h.data.length / 12;
    const hExpected = frames
      .slice(first + h.startFrame, first + h.startFrame + hFrames)
      .flatMap((f) => highRateRow(f.words));
    expect(Array.from(h.data)).toEqual(hExpected);
  }
  return first;
}
