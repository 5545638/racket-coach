import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../../src/domain/types';
import { analyzeSwing } from '../../src/metrics/analyzeSwing';
import { toImuSeries } from '../../src/processing/units';
import { encodeCapture } from '../../src/protocol/assembler';
import {
  CaptureFlag,
  Command,
  DEFAULT_CREDIT,
  MessageTypeV2,
  SensorMode,
} from '../../src/protocol/constants';
import { SensorLink } from '../../src/protocol/link';
import {
  type BenchResultMessage,
  decodeCommandV2,
  decodeMessageV2,
  encodeHello,
} from '../../src/protocol/messagesV2';
import { DEFAULT_SWING, simulateSwing } from '../../src/simulation/swingModel';
import { SETUP, SKEWED_MOUNT } from '../helpers';
import { FirmwareHarness, VirtualClock, motionFromSamples, pulseMotion } from './firmwareHarness';
import { type V2Session, expectBitExact, startV2 } from './scenario';

const FRAME_PERIOD_US = 9600; // 6666.7 Hz / 64

const onePulse = (t = 4, peakDps = 1500) => pulseMotion([{ t, peakDps, sigmaS: 0.05 }]);

function diagnostics(s: V2Session) {
  const all = s.events.flatMap((e) => (e.type === 'diagnostics' ? [e.diagnostics] : []));
  return all.at(-1);
}

/** Requests STATUS2 and returns the latest diagnostics. */
function freshDiagnostics(s: V2Session) {
  s.fw.write(Command.RequestStatus);
  s.fw.run(100);
  return diagnostics(s);
}

/**
 * Walks every notify() attempt and every command the sensor received, in
 * order, and checks that no DATA block was sent beyond the latest cumulative
 * ACK's nextBlock + credit − 1. Returns the number of DATA blocks checked.
 */
function expectCreditRespected(fw: FirmwareHarness): number {
  const records = [
    ...fw.txLog.map((r) => ({ seq: r.seq, tx: true, bytes: r.bytes })),
    ...fw.rxLog.map((r) => ({ seq: r.seq, tx: false, bytes: r.bytes })),
  ].sort((a, b) => a.seq - b.seq);
  const window = new Map<number, { capId: number; next: number; credit: number }>();
  let checked = 0;
  for (const r of records) {
    const type = r.bytes[0] ?? 0;
    if (!r.tx) {
      const c = decodeCommandV2(r.bytes);
      if (c?.type === 'ack') {
        const prev = window.get(c.capId & 15);
        window.set(c.capId & 15, {
          capId: prev?.capId ?? c.capId,
          next: Math.max(prev?.next ?? 0, c.nextBlock),
          credit: c.credit,
        });
      }
    } else if (type === MessageTypeV2.BeginA) {
      const capId = r.bytes[1] ?? 0;
      // A new capture with this nibble starts from the default credit (a
      // resent header of the same capture changes nothing).
      if (window.get(capId & 15)?.capId !== capId) {
        window.set(capId & 15, { capId, next: 0, credit: DEFAULT_CREDIT });
      }
    } else if ((type & 0xf0) === MessageTypeV2.Data) {
      const w = window.get(type & 15) ?? { next: 0, credit: DEFAULT_CREDIT };
      expect(r.bytes[1]).toBeLessThan(w.next + w.credit);
      checked++;
    }
  }
  return checked;
}

const commandsOf = (fw: FirmwareHarness, type: string) =>
  fw.rxLog.map((r) => decodeCommandV2(r.bytes)).filter((c) => c?.type === type);

describe('protocol v2 end to end (firmware harness ↔ app link)', () => {
  it('negotiates v2 with a 50-byte PROBE and delivers an M104 capture bit-exactly', () => {
    const s = startV2({ motion: onePulse() });
    s.fw.run(7000);
    expect(s.link.version).toBe(2);
    expect(s.events.find((e) => e.type === 'protocol')).toEqual({ type: 'protocol', version: 2 });
    expect(diagnostics(s)).toMatchObject({
      protocolVersion: 2,
      firmwareVersion: '0.2.0',
      mode: 'M104',
      payloadBytes: 48,
      fifoOverruns: 0,
      droppedCaptures: 0,
      errors: 0,
    });
    expect(s.errors()).toEqual([]);
    const [capture] = s.captures();
    if (!capture) throw new Error('no capture');
    expect(capture).toMatchObject({
      kind: 'swing',
      protocolVersion: 2,
      mode: 'M104',
      sampleRateHz: 104,
      accelUgPerLsb: 488,
      gyroMdpsPerLsb: 70,
      flags: 0,
      firmwareVersion: '0.2.0',
    });
    expect(capture.gyroHr).toBeUndefined();
    expect(capture.samples.length / 6).toBe(229);
    expect(capture.temperatureC).toBeCloseTo(22.4, 1);
    expectBitExact(capture, s.fw.imu.frames);
    // The peak sits where the pulse peaks; the window ends 16 quiet frames later.
    const peak = capture.triggerIndex;
    const rate = (i: number) => Math.abs(capture.samples[i * 6 + 5] ?? 0);
    expect(rate(peak)).toBe(Math.max(...Array.from({ length: 229 }, (_, i) => rate(i))));
    // Timestamps: one per frame, evenly spaced by the measured frame period.
    const times = capture.sampleTimesUs ?? [];
    expect(times).toHaveLength(229);
    expect(capture.framePeriodNs).toBeGreaterThan(9_590_000);
    expect(capture.framePeriodNs).toBeLessThan(9_610_000);
    for (let i = 1; i < times.length; i++) {
      expect(Math.abs((times[i] ?? 0) - (times[i - 1] ?? 0) - FRAME_PERIOD_US)).toBeLessThanOrEqual(
        15,
      );
    }
    expect(s.fw.accelOnCalls).toBe(0);
    expect(s.fw.getTemperatureCalls).toBe(0);
    // The DONE freed the outbox.
    expect(commandsOf(s.fw, 'done')).toEqual([
      { type: 'done', capId: capture.sequence, status: 0 },
    ]);
  });

  it('delivers an M416 capture with the raw 416 Hz gyro around the peak, bit-exactly', () => {
    const s = startV2({ mode: SensorMode.M416, motion: onePulse() });
    s.fw.run(7000);
    expect(diagnostics(s)?.mode).toBe('M416');
    expect(s.fw.imu.regs[0x0a]).toBe(0x36);
    expect(s.fw.imu.regs[0x08]).toBe(0x0c);
    const [capture] = s.captures();
    if (!capture?.gyroHr) throw new Error('no M416 capture');
    expect(capture.mode).toBe('M416');
    const h = capture.gyroHr;
    expect(h.samplesPerFrame).toBe(4);
    expect(h.data.length).toBe(31 * 12);
    expect(h.startFrame).toBe(capture.triggerIndex - 15);
    expectBitExact(capture, s.fw.imu.frames);
    // The 416 Hz samples resolve what the 104 Hz mean smears.
    const hrPeak = Math.max(...Array.from(h.data).filter((_, i) => i % 3 === 2));
    const lPeak = Math.max(...Array.from(capture.samples).filter((_, i) => i % 6 === 5));
    expect(hrPeak).toBeGreaterThanOrEqual(lPeak);
  });

  it('recovers the stroke geometry from a v2 capture (M104 and M416)', () => {
    const { capture: input, truth } = simulateSwing(
      { ...DEFAULT_SWING, faceTiltDeg: 4, swingPathDeg: 8 },
      { ...SETUP, durationS: 2.4, contactTimeS: 1.6 },
    );
    for (const mode of [SensorMode.M104, SensorMode.M416]) {
      const s = startV2({ mode, motion: motionFromSamples(input.samples, 104, 3) });
      s.fw.run(9000);
      const [capture] = s.captures();
      if (!capture) throw new Error('no capture');
      const metrics = analyzeSwing(toImuSeries(capture), SKEWED_MOUNT);
      expect(metrics.impactDetected).toBe(true);
      expect(metrics.faceTiltDeg).toBeCloseTo(truth.faceTiltDeg, 0);
      expect(metrics.swingPathDeg).toBeCloseTo(truth.swingPathDeg, 0);
    }
  });

  it.each([
    [0.01, 11],
    [0.1, 12],
    [0.3, 13],
  ])('recovers from %f packet loss with NAK/resend; CRC verified', (lossRate, seed) => {
    const s = startV2({
      mode: SensorMode.M416,
      ble: { seed },
      motion: pulseMotion([
        { t: 4, peakDps: 1500, sigmaS: 0.05 },
        { t: 9, peakDps: 1800, sigmaS: 0.04 },
      ]),
    });
    s.fw.run(1000); // handshake on a clean link
    expect(s.link.version).toBe(2);
    s.fw.ble.lossRate = lossRate;
    s.fw.run(20000);
    const lost = s.fw.txLog.filter((r) => r.fate === 'lost').length;
    expect(lost).toBeGreaterThan(0);
    expect(s.errors()).toEqual([]);
    const captures = s.captures();
    expect(captures).toHaveLength(2);
    for (const c of captures) expectBitExact(c, s.fw.imu.frames);
    if (lossRate >= 0.1) expect(commandsOf(s.fw, 'nak').length).toBeGreaterThan(0);
    expect(expectCreditRespected(s.fw)).toBeGreaterThan(2 * 73);
    expect(freshDiagnostics(s)?.droppedCaptures).toBe(0);
  });

  it('works at MTU 23: the PROBE arrives truncated and blocks carry 18 bytes', () => {
    const s = startV2({ mode: SensorMode.M416, ble: { mtu: 23 }, motion: onePulse() });
    s.fw.run(16000);
    expect(diagnostics(s)?.payloadBytes).toBe(18);
    expect(commandsOf(s.fw, 'hello')).toContainEqual({
      type: 'hello',
      protoMax: 2,
      probeLenReceived: 20,
    });
    const data = s.fw.txLog.filter((r) => ((r.bytes[0] ?? 0) & 0xf0) === MessageTypeV2.Data);
    expect(data.length).toBeGreaterThanOrEqual(194); // 3492 B / 18
    expect(Math.max(...data.map((r) => r.bytes.length))).toBe(20);
    const [capture] = s.captures();
    if (!capture) throw new Error('no capture');
    expectBitExact(capture, s.fw.imu.frames);
  });

  it('puts a swing during a send into the second outbox and drops (and counts) a third', () => {
    const s = startV2({
      mode: SensorMode.M416,
      motion: pulseMotion([
        { t: 4, peakDps: 1500, sigmaS: 0.04 },
        { t: 5, peakDps: 1600, sigmaS: 0.04 },
        { t: 6, peakDps: 1700, sigmaS: 0.04 },
      ]),
    });
    s.fw.run(1000);
    s.link.pacing(1, 100); // slow link: each capture takes ~7 s
    s.fw.run(5500);
    const d = freshDiagnostics(s);
    expect(d?.droppedCaptures).toBe(1);
    s.fw.run(20000);
    const captures = s.captures();
    expect(captures).toHaveLength(2);
    for (const c of captures) expectBitExact(c, s.fw.imu.frames);
    // The delivered ones are the first two swings, one second apart.
    const peakTime = (c: RawCapture) => c.sampleTimesUs?.[c.triggerIndex] ?? NaN;
    const [a, b] = captures;
    if (!a || !b) throw new Error('missing');
    expect((peakTime(b) - peakTime(a)) / 1e6).toBeCloseTo(1, 1);
    expect(freshDiagnostics(s)?.droppedCaptures).toBe(1);
  });

  it('detects a FIFO overrun (poll stalled 2 s in M416), flags it and delivers nothing corrupt', () => {
    const s = startV2({
      mode: SensorMode.M416,
      motion: pulseMotion([
        { t: 4.3, peakDps: 1500, sigmaS: 0.05 },
        { t: 6.8, peakDps: 1500, sigmaS: 0.05 },
      ]),
    });
    s.fw.run(4000);
    s.fw.stallJs(2000); // JS blocked: the 1.3 s FIFO overflows during the first swing
    s.fw.run(5000);
    expect(freshDiagnostics(s)?.fifoOverruns).toBe(1);
    const captures = s.captures();
    expect(captures).toHaveLength(1); // the swing inside the stall is gone
    const [c] = captures;
    if (!c) throw new Error('no capture');
    expect((c.flags ?? 0) & CaptureFlag.FifoResetInCapture).toBeTruthy();
    expect((c.flags ?? 0) & CaptureFlag.ShortPreHistory).toBeTruthy();
    expect(c.samples.length / 6).toBeLessThan(229);
    expectBitExact(c, s.fw.imu.frames);
    expect(s.errors()).toEqual([]);
  });

  it('absorbs a 2 s stall in M104 (3.3 s FIFO) without losing the swing', () => {
    const s = startV2({ motion: onePulse(4.3) });
    s.fw.run(4300);
    s.fw.stallJs(2000);
    s.fw.run(5000);
    expect(freshDiagnostics(s)?.fifoOverruns).toBe(0);
    const [c] = s.captures();
    if (!c) throw new Error('no capture');
    expect(c.flags).toBe(0);
    expectBitExact(c, s.fw.imu.frames);
  });

  it('flags gyro and accelerometer clipping', () => {
    const s = startV2({
      mode: SensorMode.M416,
      motion: pulseMotion([{ t: 4, peakDps: 2500, sigmaS: 0.05 }], 20),
    });
    s.fw.imu.gyroClip = 28571; // nominal ±2000 dps full scale [U, T7]
    s.fw.run(7000);
    const [c] = s.captures();
    if (!c) throw new Error('no capture');
    expect((c.flags ?? 0) & CaptureFlag.GyroClipped).toBeTruthy();
    expect((c.flags ?? 0) & CaptureFlag.AccelClipped).toBeTruthy();
    expectBitExact(c, s.fw.imu.frames);
  });

  it('unwraps the 24-bit IMU timestamp across captures', () => {
    const s = startV2({
      motion: pulseMotion([
        { t: 4, peakDps: 1500, sigmaS: 0.05 },
        { t: 6, peakDps: 1500, sigmaS: 0.05 },
      ]),
      // The timer wraps ~4.4 s after the IMU starts.
      before: (fw) => (fw.imu.timestampOffset = 2 ** 24 - 4.4 * 40000),
    });
    s.fw.run(9000);
    const captures = s.captures();
    expect(captures).toHaveLength(2);
    const [a, b] = captures;
    if (!a?.sampleTimesUs || !b?.sampleTimesUs) throw new Error('no times');
    const lastA = a.sampleTimesUs.at(-1) ?? NaN;
    const lastB = b.sampleTimesUs.at(-1) ?? NaN;
    expect(lastB).toBeGreaterThan(2 ** 24 * 25); // beyond the first wrap
    expect((lastB - lastA) / 1e6).toBeCloseTo(2, 1);
    for (let i = 1; i < b.sampleTimesUs.length; i++) {
      expect((b.sampleTimesUs[i] ?? 0) - (b.sampleTimesUs[i - 1] ?? 0)).toBeGreaterThan(9000);
    }
    for (const c of captures) expectBitExact(c, s.fw.imu.frames);
  });

  it('frees the outbox after 5 s without ACK and counts the capture as dropped', () => {
    const fw = new FirmwareHarness();
    fw.imu.motion = pulseMotion([
      { t: 3, peakDps: 1500, sigmaS: 0.05 },
      { t: 11, peakDps: 1500, sigmaS: 0.05 },
    ]);
    fw.connectLink();
    fw.write(encodeHello(2, 0));
    fw.run(100);
    fw.write(encodeHello(2, 50));
    fw.run(4500); // an app that never ACKs
    const decoded = () =>
      fw.notifications.flatMap((p) => {
        const type = p[0] ?? 0;
        return type >= 0x18 ? [decodeMessageV2(p)] : [];
      });
    const data = () => decoded().filter((m) => m.type === 'data');
    expect(data()).toHaveLength(DEFAULT_CREDIT); // the credit, then silence
    fw.run(5000);
    fw.write(Command.RequestStatus);
    fw.run(100);
    const status = decoded()
      .filter((m) => m.type === 'status2')
      .at(-1);
    expect(status).toMatchObject({ droppedCaptures: 1, flags: 0b1001 }); // IMU on, v2, outboxes free
    fw.run(3000);
    const begins = decoded().filter((m) => m.type === 'beginA');
    expect(begins.map((m) => m.capId)).toEqual([1, 2]); // the next swing gets an outbox
  });

  it('falls back to v1 with the v2 firmware when the handshake answers are lost', () => {
    const s = startV2({ motion: onePulse(3) });
    s.fw.ble.lossRate = 1; // PROBE and STATUS2 never arrive
    s.fw.run(700);
    expect(s.link.version).toBe(1);
    expect(commandsOf(s.fw, 'hello').at(-1)).toEqual({
      type: 'hello',
      protoMax: 1,
      probeLenReceived: 0,
    });
    s.fw.ble.lossRate = 0;
    s.fw.run(7000);
    const [c] = s.captures();
    expect(c?.protocolVersion).toBeUndefined(); // a v1 capture
    expect(c?.samples.length).toBe(229 * 6);
  });

  it('falls back to v1 when the firmware never answers HELLO (v1 firmware)', () => {
    const clock = new VirtualClock();
    const written: Uint8Array[] = [];
    const link = new SensorLink((b) => written.push(b), clock.linkClock, { wallClock: () => 0 });
    const events: unknown[] = [];
    link.onEvent((e) => events.push(e));
    link.start();
    clock.advance(499);
    expect(link.version).toBeNull();
    clock.advance(2);
    expect(link.version).toBe(1);
    expect(written.map((b) => Array.from(b))).toEqual([
      [0x10, 2, 0],
      [0x10, 2, 0],
      [0x10, 1, 0],
    ]);
    const swing = simulateSwing(DEFAULT_SWING, SETUP).capture;
    for (const p of encodeCapture(swing)) link.push(p);
    expect(events.at(-1)).toMatchObject({ type: 'capture', capture: { samples: swing.samples } });
  });

  it('switches mode on request and restarts the FIFO', () => {
    const s = startV2({ motion: onePulse(5) });
    s.fw.run(1500);
    expect(diagnostics(s)?.mode).toBe('M104');
    s.link.setMode(SensorMode.M416);
    s.fw.run(6000);
    expect(diagnostics(s)?.mode).toBe('M416');
    expect(s.captures()[0]?.mode).toBe('M416');
  });
});

describe('bench commands', () => {
  function bench(s: V2Session, test: number, param: number, runMs: number): BenchResultMessage[] {
    const before = s.events.length;
    s.link.bench(test, param);
    s.fw.run(runMs);
    return s.events
      .slice(before)
      .flatMap((e) => (e.type === 'bench' && e.result.test === test ? [e.result] : []));
  }
  const dv = (r: BenchResultMessage | undefined) => {
    if (!r) throw new Error('no bench result');
    return new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
  };

  it('T1 times FIFO burst reads and register writes', () => {
    const s = startV2();
    s.fw.run(1000);
    s.fw.i2cUsPerByte = 100; // 0.1 ms per byte
    const [r] = bench(s, 1, 10, 200);
    const v = dv(r);
    expect(v.getUint32(0, true)).toBeCloseTo(3100, -1); // (1 + 30) bytes
    expect(v.getUint32(4, true)).toBeCloseTo(12100, -1);
    expect(v.getUint32(8, true)).toBeCloseTo(24100, -1);
    expect(v.getUint32(12, true)).toBeCloseTo(200, -1);
    expect(v.getUint8(16)).toBe(10);
  });

  it('T2 checks WHO_AM_I, register readback, FIFO pattern and burst wrap', () => {
    for (const [mode, words] of [
      [SensorMode.M104, 6],
      [SensorMode.M416, 15],
    ] as const) {
      const s = startV2({ mode });
      s.fw.run(1000);
      const v = dv(bench(s, 2, 0, 400)[0]);
      expect(v.getUint8(0)).toBe(0x6a);
      expect(v.getUint8(1)).toBe(mode === SensorMode.M104 ? 0x46 : 0x64);
      expect(v.getUint8(6)).toBe(1); // pattern 0, 1, 2, … as documented
      expect(v.getUint16(7, true) - v.getUint16(9, true)).toBe(words); // burst wrapped
      expect(v.getUint8(11)).toBe(words);
    }
  });

  it('T3 measures the frame rate against the IMU timer and getTime()', () => {
    // IMU oscillator 200 ppm fast: more frames per CPU second, same per IMU second.
    const s = startV2({ before: (fw) => (fw.imu.oscScale = 1.0002) });
    s.fw.run(1000);
    const v = dv(bench(s, 3, 4, 4200)[0]);
    const nominal = 6666.667 / 64;
    expect(v.getUint32(0, true) / 1000 / (nominal * 1.0002)).toBeCloseTo(1, 2);
    expect(v.getUint32(4, true) / 1000 / nominal).toBeCloseTo(1, 2);
    expect(Math.abs(v.getInt32(8, true) - 200)).toBeLessThan(100);
  });

  it('T4 reports FIFO fill and poll() statistics', () => {
    const s = startV2();
    s.fw.run(1000);
    const v = dv(bench(s, 4, 2, 2200)[0]);
    expect(v.getUint16(0, true)).toBeGreaterThan(0); // max words
    expect(v.getUint16(2, true)).toBe(0); // overruns
    expect(v.getUint16(10, true)).toBeCloseTo(30, -1); // max gap, ms
    expect(v.getUint32(12, true)).toBeGreaterThan(60); // polls
  });

  it('T5 sends 200 numbered packets and a summary', () => {
    const s = startV2();
    s.fw.run(1000);
    const results = bench(s, 5, 3, 3000);
    expect(results.filter((r) => r.part !== 0xff)).toHaveLength(200);
    const v = dv(results.find((r) => r.part === 0xff));
    expect(v.getUint16(0, true)).toBe(200);
    expect(v.getUint8(6)).toBe(48); // P
    expect(v.getUint8(7)).toBe(3);
    expect(v.getUint8(9)).toBe(50); // PROBE length received by the app
  });

  it('T6 reports memory and the duration of extract()', () => {
    const s = startV2({ mode: SensorMode.M416 });
    s.fw.run(3000);
    s.fw.i2cUsPerByte = 0;
    const v = dv(bench(s, 6, 0, 100)[0]);
    expect(v.getUint16(0, true)).toBe(9000);
    expect(v.getUint16(10, true)).toBe(229);
    expect(s.captures()).toHaveLength(0); // the measurement is never sent
    expect(freshDiagnostics(s)?.droppedCaptures).toBe(0);
  });

  it('T7 reports the largest raw value per axis; T8/T9 are not runnable on the sensor', () => {
    const s = startV2({ motion: onePulse(3, 1500) });
    s.fw.run(5000);
    const v = dv(bench(s, 7, 1, 100)[0]);
    expect(v.getUint16(10, true)).toBeCloseTo(1500 / 0.07, -2); // gz
    expect(dv(bench(s, 7, 0, 100)[0]).getUint16(10, true)).toBe(0); // reset by param 1
    expect(bench(s, 8, 0, 100)[0]?.part).toBe(0xfe);
    expect(bench(s, 9, 0, 100)[0]?.part).toBe(0xfe);
  });
});

describe('firmware robustness', () => {
  it('survives disconnects during a send and a bench test without errors', () => {
    const s = startV2({ mode: SensorMode.M416, motion: onePulse(3) });
    s.fw.run(3500); // a capture is being sent
    s.link.bench(5, 1);
    s.fw.run(100);
    s.fw.disconnect();
    expect([s.fw.imu.regs[0x0a], s.fw.imu.regs[0x10], s.fw.imu.regs[0x11]]).toEqual([0, 0, 0]);
    s.fw.run(5000);
    // Reconnect with a fresh link: the counters show no handler errors.
    const again = new SensorLink((b) => {
      s.fw.write(b);
    }, s.fw.clock.linkClock);
    const events: unknown[] = [];
    again.onEvent((e) => events.push(e));
    s.fw.onNotify((p) => {
      again.push(p);
    });
    s.fw.connectLink();
    again.start();
    s.fw.run(1000);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'diagnostics',
        diagnostics: expect.objectContaining({ errors: 0 }) as unknown,
      }),
    );
  });
});
