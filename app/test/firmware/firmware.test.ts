import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AssemblerEvent, CaptureAssembler } from '../../src/protocol/assembler';
import * as protocol from '../../src/protocol/constants';
import {
  DEFAULT_SWING,
  SENSOR_ACCEL_G_PER_LSB,
  SENSOR_GYRO_DPS_PER_LSB,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import { SETUP, SKEWED_MOUNT } from '../helpers';
import { type AccelEvent, FIRMWARE_PATH, FirmwareHarness } from './firmwareHarness';

const source = readFileSync(FIRMWARE_PATH, 'utf8');
const firmwareConst = (name: string): string => {
  const match = new RegExp(`var ${name} = ([^;]+);`).exec(source);
  if (!match?.[1]) throw new Error(`${name} not found in firmware`);
  return match[1].trim();
};

function toEvents(samples: Int16Array): AccelEvent[] {
  const events: AccelEvent[] = [];
  for (let i = 0; i < samples.length; i += 6) {
    const s = (k: number) => samples[i + k] ?? 0;
    events.push({ acc: { x: s(0), y: s(1), z: s(2) }, gyro: { x: s(3), y: s(4), z: s(5) } });
  }
  return events;
}

function assemble(packets: readonly Uint8Array[]): AssemblerEvent[] {
  const assembler = new CaptureAssembler(() => 0);
  return packets.flatMap((p) => assembler.push(p));
}

describe('firmware ↔ app protocol contract', () => {
  it('uses the same identifiers and message codes as the app', () => {
    expect(firmwareConst('PROTOCOL_VERSION')).toBe(String(protocol.PROTOCOL_VERSION));
    expect(firmwareConst('SERVICE_UUID')).toBe(`'${protocol.SERVICE_UUID}'`);
    expect(firmwareConst('DATA_CHARACTERISTIC_UUID')).toBe(
      `'${protocol.DATA_CHARACTERISTIC_UUID}'`,
    );
    expect(firmwareConst('CONTROL_CHARACTERISTIC_UUID')).toBe(
      `'${protocol.CONTROL_CHARACTERISTIC_UUID}'`,
    );
    expect(firmwareConst('DEVICE_NAME_PREFIX')).toBe(`'${protocol.DEVICE_NAME_PREFIX}'`);
    expect(Number(firmwareConst('MSG_CAPTURE_BEGIN'))).toBe(protocol.MessageType.CaptureBegin);
    expect(Number(firmwareConst('MSG_SAMPLE'))).toBe(protocol.MessageType.Sample);
    expect(Number(firmwareConst('MSG_CAPTURE_END'))).toBe(protocol.MessageType.CaptureEnd);
    expect(Number(firmwareConst('MSG_STATUS'))).toBe(protocol.MessageType.Status);
    expect(Number(firmwareConst('CMD_REQUEST_STATUS'))).toBe(protocol.Command.RequestStatus);
    expect(Number(firmwareConst('CMD_CAPTURE_STATIC'))).toBe(protocol.Command.CaptureStatic);
    expect(Number(firmwareConst('ACCEL_UG_PER_LSB'))).toBe(SENSOR_ACCEL_G_PER_LSB * 1e6);
    expect(Number(firmwareConst('GYRO_MDPS_PER_LSB'))).toBe(SENSOR_GYRO_DPS_PER_LSB * 1e3);
  });
});

describe('firmware running in a host harness', () => {
  const swing = simulateSwing(DEFAULT_SWING, SETUP).capture;
  const events = toEvents(swing.samples);

  it('configures the IMU for ±16 g / ±2000 dps at 104 Hz on connect', () => {
    const fw = new FirmwareHarness();
    fw.connect();
    expect(fw.accelOn).toBe(true);
    expect(fw.registerWrites).toEqual([
      [0x10, 0x44],
      [0x11, 0x4c],
    ]);
    fw.disconnect();
    expect(fw.accelOn).toBe(false);
  });

  it.each([
    ['sent as it is recorded', 0, true],
    ['with a congested BLE queue', 3, true],
    ['sent after recording', 0, false],
  ])('streams a swing the app reassembles bit-exactly (%s)', (_name, failEvery, interleave) => {
    const fw = new FirmwareHarness();
    fw.failEvery = failEvery;
    fw.connect();
    for (const e of events) {
      fw.sample(e);
      if (interleave) fw.flushTimers();
    }
    fw.flushTimers();

    const result = assemble(fw.notifications);
    expect(result.map((r) => r.type)).toEqual(['capture']);
    const capture = result[0]?.type === 'capture' ? result[0].capture : null;
    if (!capture) throw new Error('no capture');

    // The window must end with samples that match the input exactly.
    const triggerAt = swing.triggerIndex;
    const startAt = triggerAt - capture.triggerIndex;
    expect(capture.triggerIndex).toBe(Math.min(82, triggerAt));
    const expected = swing.samples.slice(startAt * 6, startAt * 6 + capture.samples.length);
    expect(capture.samples).toEqual(expected);
    // The window covers contact and most of the follow-through.
    const contact = Math.round(SETUP.contactTimeS * SETUP.sampleRateHz);
    expect(startAt + capture.samples.length / 6).toBeGreaterThan(contact + 20);
  });

  it('delivers a window from which the app recovers the stroke geometry', () => {
    const { capture: input, truth } = simulateSwing(
      { ...DEFAULT_SWING, faceTiltDeg: 4, swingPathDeg: 8 },
      { ...SETUP, durationS: 2.4, contactTimeS: 1.6 },
    );
    const fw = new FirmwareHarness();
    fw.connect();
    for (const e of toEvents(input.samples)) {
      fw.sample(e);
      fw.flushTimers();
    }
    const [event] = assemble(fw.notifications);
    if (event?.type !== 'capture') throw new Error('no capture');
    const metrics = analyzeSwing(toImuSeries(event.capture), SKEWED_MOUNT);
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
  });

  it('records a static capture on command and reports status', () => {
    const fw = new FirmwareHarness();
    fw.connect();
    fw.write(protocol.Command.RequestStatus);
    fw.write(protocol.Command.CaptureStatic);
    for (let i = 0; i < 120; i++)
      fw.sample({ acc: { x: 0, y: 0, z: 2049 }, gyro: { x: 1, y: -1, z: 0 } });
    fw.flushTimers();
    const result = assemble(fw.notifications);
    expect(result[0]).toEqual({
      type: 'status',
      status: {
        protocolVersion: 1,
        batteryPercent: 88,
        temperatureC: 22,
        firmwareVersion: '0.1.0',
      },
    });
    expect(result[1]).toMatchObject({
      type: 'capture',
      capture: { kind: 'static', triggerIndex: 0 },
    });
    const capture = result[1]?.type === 'capture' ? result[1].capture : null;
    expect(capture?.samples.length).toBe(104 * 6);
  });

  it('advertises a per-device name from the last two address bytes', () => {
    const fw = new FirmwareHarness();
    expect(fw.advertisedName).toBe('RacketCoach 5678');
  });

  it('streams nothing until the app has subscribed', () => {
    const fw = new FirmwareHarness();
    fw.connectLink();
    for (const e of events) fw.sample(e);
    fw.flushTimers();
    expect(fw.notifications).toHaveLength(0);
  });

  it('drops slow motions that never reach swing speed', () => {
    const waggle = simulateSwing({ ...DEFAULT_SWING, peakRateRadPerS: 9 }, SETUP).capture;
    const fw = new FirmwareHarness();
    fw.connect();
    for (const e of toEvents(waggle.samples)) fw.sample(e);
    fw.flushTimers();
    expect(fw.notifications).toHaveLength(0);
  });

  it('keeps the backswing and its pause inside one stroke capture', () => {
    const { capture: input, truth } = simulateSwing(
      { ...DEFAULT_SWING, backswingRateRadPerS: 6 },
      { ...SETUP, durationS: 2.4, contactTimeS: 1.6 },
    );
    const fw = new FirmwareHarness();
    fw.connect();
    for (const e of toEvents(input.samples)) {
      fw.sample(e);
      fw.flushTimers();
    }
    const result = assemble(fw.notifications);
    expect(result.map((r) => r.type)).toEqual(['capture']);
    const capture = result[0]?.type === 'capture' ? result[0].capture : null;
    if (!capture) throw new Error('no capture');
    const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT);
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
  });

  it('captures back-to-back strokes, each with its own preparation phase', () => {
    const setup = { ...SETUP, durationS: 1.8, contactTimeS: 0.95 };
    const first = simulateSwing({ ...DEFAULT_SWING, faceTiltDeg: -15 }, setup);
    const second = simulateSwing({ ...DEFAULT_SWING, faceTiltDeg: 3, seed: 2 }, setup);
    const fw = new FirmwareHarness();
    fw.connect();
    for (const e of [...toEvents(first.capture.samples), ...toEvents(second.capture.samples)]) {
      fw.sample(e);
      fw.flushTimers();
    }
    const captures = assemble(fw.notifications).flatMap((r) =>
      r.type === 'capture' ? [r.capture] : [],
    );
    expect(captures).toHaveLength(2);
    const faces = captures.map((c) => analyzeSwing(toImuSeries(c), SKEWED_MOUNT).faceTiltDeg);
    expect(faces[0]).toBeCloseTo(first.truth.faceTiltDeg, 0);
    expect(faces[1]).toBeCloseTo(second.truth.faceTiltDeg, 0);
  });

  it('recovers cleanly from a disconnect in the middle of a capture', () => {
    const fw = new FirmwareHarness();
    fw.connect();
    const contact = Math.round(SETUP.contactTimeS * SETUP.sampleRateHz);
    for (const e of events.slice(0, contact)) fw.sample(e);
    fw.disconnect();
    fw.connect();
    for (const e of events) {
      fw.sample(e);
      fw.flushTimers();
    }
    expect(assemble(fw.notifications).map((r) => r.type)).toEqual(['capture']);
  });

  it('ignores a static-capture command while a swing is being captured', () => {
    const fw = new FirmwareHarness();
    fw.connect();
    const contact = Math.round(SETUP.contactTimeS * SETUP.sampleRateHz);
    events.forEach((e, i) => {
      if (i === contact) fw.write(protocol.Command.CaptureStatic);
      fw.sample(e);
      fw.flushTimers();
    });
    const result = assemble(fw.notifications);
    expect(result.map((r) => (r.type === 'capture' ? r.capture.kind : r.type))).toEqual(['swing']);
  });

  it('does not trigger while disconnected', () => {
    const fw = new FirmwareHarness();
    for (const e of events) fw.sample(e);
    fw.flushTimers();
    expect(fw.notifications).toHaveLength(0);
  });
});
