import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import * as protocol from '../../src/protocol/constants';
import {
  DEFAULT_SWING,
  SENSOR_ACCEL_G_PER_LSB,
  SENSOR_GYRO_DPS_PER_LSB,
  simulateSwing,
} from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';
import { FIRMWARE_PATH, FirmwareHarness, motionFromSamples, pulseMotion } from './firmwareHarness';
import { lowRateRow, startV1 } from './scenario';

/*
 * The current (v1) app sends no HELLO: the firmware then emits v1
 * Begin/Sample/End built from the L section, paced at 4 packets per 30 ms.
 *
 * Changed from the v1-firmware tests: the old harness fed Puck 'accel' events
 * and made notify() throw on a full queue, which the old firmware retried.
 * Real Espruino never throws on a full queue; the notification is silently
 * dropped (docs/sensor-v2.md). The harness now models exactly that, plus a
 * register-level IMU with a FIFO, so these tests drive motion through the
 * IMU and run in virtual time. The "congested queue" case now asserts the
 * truth: v1 cannot recover a dropped sample, and the app rejects the capture
 * instead of accepting a corrupt one.
 */

const source = readFileSync(FIRMWARE_PATH, 'utf8');
const firmwareConst = (name: string): string => {
  const match = new RegExp(`var ${name} = ([^;]+);`).exec(source);
  if (!match?.[1]) throw new Error(`${name} not found in firmware`);
  return match[1].trim();
};
const firmwareNumber = (name: string): number => Number(firmwareConst(name));

const SWING_START_S = 3;

describe('firmware ↔ app protocol contract', () => {
  it('uses the same identifiers and message codes as the app', () => {
    expect(firmwareConst('PROTOCOL_VERSION')).toBe(String(protocol.PROTOCOL_VERSION));
    expect(firmwareNumber('PROTOCOL_V2')).toBe(protocol.PROTOCOL_VERSION_V2);
    expect(firmwareConst('SERVICE_UUID')).toBe(`'${protocol.SERVICE_UUID}'`);
    expect(firmwareConst('DATA_CHARACTERISTIC_UUID')).toBe(
      `'${protocol.DATA_CHARACTERISTIC_UUID}'`,
    );
    expect(firmwareConst('CONTROL_CHARACTERISTIC_UUID')).toBe(
      `'${protocol.CONTROL_CHARACTERISTIC_UUID}'`,
    );
    expect(firmwareConst('DEVICE_NAME_PREFIX')).toBe(`'${protocol.DEVICE_NAME_PREFIX}'`);
    expect(firmwareNumber('MSG_CAPTURE_BEGIN')).toBe(protocol.MessageType.CaptureBegin);
    expect(firmwareNumber('MSG_SAMPLE')).toBe(protocol.MessageType.Sample);
    expect(firmwareNumber('MSG_CAPTURE_END')).toBe(protocol.MessageType.CaptureEnd);
    expect(firmwareNumber('MSG_STATUS')).toBe(protocol.MessageType.Status);
    expect(firmwareNumber('CMD_REQUEST_STATUS')).toBe(protocol.Command.RequestStatus);
    expect(firmwareNumber('CMD_CAPTURE_STATIC')).toBe(protocol.Command.CaptureStatic);
    expect(firmwareNumber('ACCEL_UG_PER_LSB')).toBe(SENSOR_ACCEL_G_PER_LSB * 1e6);
    expect(firmwareNumber('GYRO_MDPS_PER_LSB')).toBe(SENSOR_GYRO_DPS_PER_LSB * 1e3);
  });

  it('uses the same v2 codes and limits as the app', () => {
    const t = protocol.MessageTypeV2;
    const c = protocol.CommandV2;
    expect(
      [
        'MSG_STATUS2',
        'MSG_PROBE',
        'MSG_BEGIN_A',
        'MSG_BEGIN_B',
        'MSG_END',
        'MSG_BENCH_RESULT',
        'MSG_DATA',
      ].map(firmwareNumber),
    ).toEqual([t.Status2, t.Probe, t.BeginA, t.BeginB, t.End, t.BenchResult, t.Data]);
    expect(
      ['CMD_HELLO', 'CMD_ACK', 'CMD_NAK', 'CMD_DONE', 'CMD_PACING', 'CMD_MODE', 'CMD_BENCH'].map(
        firmwareNumber,
      ),
    ).toEqual([c.Hello, c.Ack, c.Nak, c.Done, c.Pacing, c.Mode, c.Bench]);
    expect(firmwareNumber('NAK_HEADERS')).toBe(protocol.NAK_RESEND_HEADERS);
    expect(firmwareNumber('DEFAULT_CREDIT')).toBe(protocol.DEFAULT_CREDIT);
    expect(firmwareNumber('P_MIN')).toBe(protocol.PAYLOAD_BYTES_MIN);
    expect(firmwareNumber('P_MAX')).toBe(protocol.PAYLOAD_BYTES_MAX);
    expect(firmwareNumber('MODE_M104')).toBe(protocol.SensorMode.M104);
    expect(firmwareNumber('MODE_M416')).toBe(protocol.SensorMode.M416);
    expect(firmwareConst('DEFAULT_MODE')).toBe('MODE_M104');
    const f = protocol.CaptureFlag;
    expect(
      ['FLAG_SHORT_HISTORY', 'FLAG_GYRO_CLIPPED', 'FLAG_ACCEL_CLIPPED', 'FLAG_FIFO_RESET'].map(
        firmwareNumber,
      ),
    ).toEqual([f.ShortPreHistory, f.GyroClipped, f.AccelClipped, f.FifoResetInCapture]);
  });

  it('never calls Puck.accelOn or the blocking E.getTemperature', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Puck\.accelOn\(/);
    expect(code).not.toMatch(/E\.getTemperature\(/);
  });
});

describe('firmware in the host harness: IMU and link', () => {
  it('configures the IMU registers for M104 without accelOn and powers it down on disconnect', () => {
    const fw = new FirmwareHarness();
    fw.connect();
    expect(fw.accelOnCalls).toBe(0);
    const reg = (r: number) => fw.imu.regs[r];
    expect(reg(0x10)).toBe(0x46); // 104 Hz, ±16 g, LPF1 ODR/4
    expect(reg(0x11)).toBe(0x4c); // 104 Hz, ±2000 dps
    expect(reg(0x12)).toBe(0x44); // BDU, IF_INC
    expect(reg(0x08)).toBe(0x09); // FIFO: gyro and accel undecimated
    expect(reg(0x0a)).toBe(0x26); // FIFO 104 Hz continuous
    expect(reg(0x19)).toBe(0x20); // TIMER_EN
    expect(reg(0x5c)).toBe(0x10); // TIMER_HR
    // The FIFO is started 100 ms after the configuration.
    const writes = fw.imu.writes.map(([r]) => r);
    expect(writes.indexOf(0x0a, 1)).toBe(writes.length - 1);
    fw.disconnect();
    expect([reg(0x0a), reg(0x10), reg(0x11)]).toEqual([0, 0, 0]);
  });

  it('advertises a per-device name from the last two address bytes', () => {
    expect(new FirmwareHarness().advertisedName).toBe('RacketCoach 5678');
  });

  it('captures nothing until the app has written a command', () => {
    const fw = new FirmwareHarness();
    fw.imu.motion = pulseMotion([{ t: 3, peakDps: 1500, sigmaS: 0.05 }]);
    fw.connectLink();
    fw.run(6000);
    expect(fw.notifications).toHaveLength(0);
  });

  it('does not run the IMU or trigger while disconnected', () => {
    const fw = new FirmwareHarness();
    fw.imu.motion = pulseMotion([{ t: 1, peakDps: 1500, sigmaS: 0.05 }]);
    fw.run(4000);
    expect(fw.imu.writes).toHaveLength(0);
    expect(fw.notifications).toHaveLength(0);
  });
});

describe('v1 fallback (current app, no HELLO)', () => {
  const swing = simulateSwing(DEFAULT_SWING, { ...SETUP, durationS: 2.4, contactTimeS: 1.6 });

  it('sends a valid v1 capture whose samples are the IMU frames, bit-exact', () => {
    const s = startV1({ motion: motionFromSamples(swing.capture.samples, 104, SWING_START_S) });
    s.fw.run(8000);
    expect(s.events.map((e) => e.type)).toEqual(['capture']);
    const capture = s.captures()[0];
    if (!capture) throw new Error('no capture');
    expect(capture.sampleRateHz).toBe(104);
    expect(capture.protocolVersion).toBeUndefined(); // a plain v1 capture
    const n = capture.samples.length / 6;
    expect(n).toBe(229);
    // Find the window in the produced frames by content: it must be contiguous.
    const rows = s.fw.imu.frames.map((f) => lowRateRow(f.words));
    const first = rows.findIndex((_, i) =>
      rows.slice(i, i + n).every((r, j) => r.every((v, k) => v === capture.samples[j * 6 + k])),
    );
    expect(first).toBeGreaterThanOrEqual(0);
    // The trigger index is the start of the > 300 dps run that holds the peak.
    const rate = (i: number) =>
      Math.hypot(...[3, 4, 5].map((k) => capture.samples[i * 6 + k] ?? 0)) * 0.07;
    expect(rate(capture.triggerIndex)).toBeGreaterThan(300);
    expect(rate(capture.triggerIndex - 1)).toBeLessThanOrEqual(300);
    // The paced stream never overflowed the modelled TX queue.
    expect(s.fw.txLog.every((r) => r.fate === 'sent')).toBe(true);
  });

  it('delivers a window from which the app recovers the stroke geometry', () => {
    const { capture: input, truth } = simulateSwing(
      { ...DEFAULT_SWING, faceTiltDeg: 4, swingPathDeg: 8 },
      { ...SETUP, durationS: 2.4, contactTimeS: 1.6 },
    );
    const s = startV1({ motion: motionFromSamples(input.samples, 104, SWING_START_S) });
    s.fw.run(8000);
    const capture = s.captures()[0];
    if (!capture) throw new Error('no capture');
    const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT);
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
    expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
  });

  it('keeps the backswing and its pause inside one stroke capture', () => {
    const { capture: input, truth } = simulateSwing(
      { ...DEFAULT_SWING, backswingRateRadPerS: 6 },
      { ...SETUP, durationS: 2.4, contactTimeS: 1.6 },
    );
    const s = startV1({ motion: motionFromSamples(input.samples, 104, SWING_START_S) });
    s.fw.run(8000);
    expect(s.events.map((e) => e.type)).toEqual(['capture']);
    const capture = s.captures()[0];
    if (!capture) throw new Error('no capture');
    const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT);
    expect(metrics.impactDetected).toBe(true);
    expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
  });

  it('captures back-to-back strokes, each with its own preparation phase', () => {
    const setup = { ...SETUP, durationS: 1.8, contactTimeS: 0.95 };
    const first = simulateSwing({ ...DEFAULT_SWING, faceTiltDeg: -15 }, setup);
    const second = simulateSwing({ ...DEFAULT_SWING, faceTiltDeg: 3, seed: 2 }, setup);
    const both = new Int16Array([...first.capture.samples, ...second.capture.samples]);
    const s = startV1({ motion: motionFromSamples(both, 104, SWING_START_S) });
    s.fw.run(10000);
    const captures = s.captures();
    expect(captures).toHaveLength(2);
    const faces = captures.map((c) => analyzeSwing(toImuSeries(c), SKEWED_MOUNT).faceTiltDeg);
    // The first window starts in the harness' rest period (the first sample
    // held), the second while the racket still settles from the first
    // follow-through: both anchors are slightly less exact than a real ready
    // position.
    expect(Math.abs((faces[0] ?? NaN) - first.truth.faceTiltDeg)).toBeLessThan(1.5);
    expect(Math.abs((faces[1] ?? NaN) - second.truth.faceTiltDeg)).toBeLessThan(1.5);
  });

  it('drops slow motions that never reach swing speed', () => {
    const waggle = simulateSwing({ ...DEFAULT_SWING, peakRateRadPerS: 9 }, SETUP).capture;
    const s = startV1({ motion: motionFromSamples(waggle.samples, 104, SWING_START_S) });
    s.fw.run(7000);
    expect(s.fw.notifications).toHaveLength(0);
  });

  it('records a static capture on command and reports status with the IMU temperature', () => {
    const s = startV1();
    s.fw.write(protocol.Command.RequestStatus);
    s.fw.write(protocol.Command.CaptureStatic);
    s.fw.run(3000);
    expect(s.events[0]).toEqual({
      type: 'status',
      status: {
        protocolVersion: 1,
        batteryPercent: 88,
        temperatureC: 22,
        firmwareVersion: '0.2.0',
      },
    });
    expect(s.events[1]).toMatchObject({
      type: 'capture',
      capture: { kind: 'static', triggerIndex: 0 },
    });
    const capture = s.captures()[0];
    expect(capture?.samples.length).toBe(104 * 6);
    expect(s.fw.getTemperatureCalls).toBe(0);
  });

  it('ignores a static-capture command while a swing is being captured', () => {
    const s = startV1({ motion: pulseMotion([{ t: 3, peakDps: 1500, sigmaS: 0.08 }]) });
    s.fw.run(2650); // the swing is active at t ≈ 3 s
    s.fw.write(protocol.Command.CaptureStatic);
    s.fw.run(5000);
    expect(s.captures().map((c) => c.kind)).toEqual(['swing']);
  });

  it('recovers cleanly from a disconnect in the middle of a capture', () => {
    const s = startV1({ motion: pulseMotion([{ t: 3, peakDps: 1500, sigmaS: 0.05 }]) });
    s.fw.run(2700);
    s.fw.disconnect();
    s.fw.imu.motion = pulseMotion([{ t: 7, peakDps: 1500, sigmaS: 0.05 }]);
    s.fw.connect();
    s.fw.run(7000);
    // The status answers the reconnect's RequestStatus.
    expect(s.events.map((e) => e.type)).toEqual(['status', 'capture']);
  });

  it('cannot recover silently dropped notifications: the app rejects the capture', () => {
    // A link far slower than the pacing assumes (one packet per 30 ms event,
    // two queued): the stack drops notifications without telling anyone.
    const s = startV1({
      ble: { connIntervalMs: 30, packetsPerEvent: 1, txQueue: 2 },
      motion: pulseMotion([{ t: 3, peakDps: 1500, sigmaS: 0.05 }]),
    });
    s.fw.run(12000);
    expect(s.fw.txLog.some((r) => r.fate === 'queue-full')).toBe(true);
    // Nothing corrupt is accepted. (The End message itself may be among the
    // dropped ones, so the app may not even learn that a capture was lost.)
    expect(s.captures()).toHaveLength(0);
  });
});
