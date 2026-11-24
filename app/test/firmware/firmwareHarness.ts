import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../../src/protocol/crc32';
import type { LinkClock } from '../../src/protocol/link';

export const FIRMWARE_PATH = fileURLToPath(
  new URL('../../../firmware/puck/src/main.js', import.meta.url),
);

/* ======================================================================== */
/* Virtual clock                                                            */
/* ======================================================================== */

interface TimerEvent {
  readonly id: number;
  at: number;
  readonly seq: number;
  readonly fn: () => void;
  readonly period: number | null;
}

/**
 * Drives every timer of the firmware (setTimeout/setInterval/getTime), of the
 * BLE model and of the app-side link, so a whole session runs deterministically
 * in virtual time. Like Espruino, a late interval runs once and does not
 * catch up on missed runs.
 */
export class VirtualClock {
  private t = 0;
  private nextId = 1;
  private seq = 0;
  private events: TimerEvent[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms = 0): number {
    return this.add(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): number {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clear(id: unknown): void {
    this.events = this.events.filter((e) => e.id !== id);
  }

  has(id: unknown): boolean {
    return this.events.some((e) => e.id === id);
  }

  /** Time passes while JS is blocked (a long call, or a stalled interpreter). */
  busy(ms: number): void {
    this.t += ms;
  }

  /** Runs every timer due within the next `ms`, in time order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: TimerEvent | undefined;
      for (const e of this.events) {
        if (e.at <= target && (!next || e.at < next.at || (e.at === next.at && e.seq < next.seq))) {
          next = e;
        }
      }
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.period === null) {
        this.clear(next.id);
      } else {
        next.at += next.period;
        if (next.at <= this.t) next.at = this.t + next.period;
      }
      next.fn();
    }
    this.t = Math.max(this.t, target);
  }

  /** Advances in steps until `done()` or `maxMs` elapsed; returns whether done. */
  runUntil(done: () => boolean, maxMs: number, stepMs = 10): boolean {
    for (let elapsed = 0; elapsed < maxMs; elapsed += stepMs) {
      if (done()) return true;
      this.advance(stepMs);
    }
    return done();
  }

  /** A LinkClock view for the app-side SensorLink. */
  get linkClock(): LinkClock {
    return {
      now: () => this.now(),
      setTimeout: (fn, ms) => this.setTimeout(fn, ms),
      clearTimeout: (h) => {
        this.clear(h);
      },
    };
  }

  private add(fn: () => void, ms: number, period: number | null): number {
    const id = this.nextId++;
    this.events.push({ id, at: this.t + Math.max(0, ms), seq: this.seq++, fn, period });
    return id;
  }
}

/* ======================================================================== */
/* LSM6DS3TR-C register model                                               */
/* ======================================================================== */

export type Triple = readonly [number, number, number];
/** Raw counts at time t (s, IMU time since the clock started). */
export type Motion = (tS: number) => { readonly accel: Triple; readonly gyro: Triple };

/** One FIFO pattern cycle as produced (whether or not it was ever read). */
export interface ImuFrame {
  /** Unwrapped 25 µs timer value at the first sample of the frame. */
  readonly tsTicks: number;
  /** FIFO words of the frame, in FIFO order (G, A or G0, A0, G1, G2, G3). */
  readonly words: Int16Array;
  /** FIFO session (bumped on every bypass → continuous restart). */
  readonly session: number;
}

const FIFO_WORDS = 2048; // 4 kB
/** DEC_FIFO_* code → decimation factor (0 = data set not in FIFO). */
const DECIMATION = [0, 1, 2, 3, 4, 8, 16, 32];
const BASE_ODR_HZ = 6666.667;

const REST: ReturnType<Motion> = { accel: [0, 0, 2049], gyro: [0, 0, 0] };

/**
 * Register-level model of the LSM6DS3TR-C as the firmware uses it: CTRL and
 * FIFO_CTRL registers, a 2048-word FIFO in continuous mode with FIFO_PATTERN,
 * overrun (oldest words overwritten, OVER_RUN flag), the FIFO_DATA_OUT
 * burst wrap 0x3F → 0x3E, the 24-bit timestamp (25 µs, reset by writing 0xAA
 * to 0x42), OUT_TEMP and clipping at a configurable count.
 *
 * Simplifications: data sets are produced at the FIFO ODR (not at the
 * sensors' own ODRs), with gyro before accel in a cycle; filters are not
 * modelled. The FIFO pattern order and the burst wrap are assumptions that
 * bench test T2 must confirm on hardware.
 */
export class Lsm6ds3Model {
  readonly regs = new Uint8Array(128);
  readonly writes: [number, number][] = [];
  readonly frames: ImuFrame[] = [];
  motion: Motion = () => REST;
  gyroClip = 32767;
  accelClip = 32767;
  tempC = 22.4;
  /** IMU oscillator relative to the virtual clock (ODR and timer). */
  oscScale = 1;
  /** Timer value right after a reset (to test the 24-bit wrap). */
  timestampOffset = 0;

  private readonly fifo = new Int16Array(FIFO_WORDS);
  private readonly fifoPattern = new Uint16Array(FIFO_WORDS);
  private head = 0;
  private count = 0;
  private overrun = false;
  private running = false;
  private startMs = 0;
  private tick = 0;
  private periodMs = 0;
  private decG = 0;
  private decXl = 0;
  private cycle = 1;
  private patternPos = 0;
  private session = 0;
  private current: number[] | null = null;
  private currentTs = 0;
  private timerStartMs = 0;
  private timerBase = 0;
  private latchedTs = 0;

  constructor(private readonly clock: VirtualClock) {
    this.regs[0x0f] = 0x6a;
  }

  get fifoWords(): number {
    this.sync();
    return this.count;
  }

  write(reg: number, value: number): void {
    this.sync();
    this.writes.push([reg, value]);
    if (reg === 0x42) {
      if (value === 0xaa) this.resetTimer();
      return;
    }
    const before = this.regs[reg] ?? 0;
    this.regs[reg] = value;
    if (reg === 0x19 && value & 0x20 && !(before & 0x20)) this.resetTimer();
    if (reg === 0x0a) this.fifoControl(value);
  }

  read(reg: number): number;
  read(reg: number, count: number): Uint8Array;
  read(reg: number, count?: number): number | Uint8Array {
    this.sync();
    this.latchedTs = this.timestampNow();
    if (count === undefined) return this.readByte(reg);
    const out = new Uint8Array(count);
    let addr = reg;
    const autoIncrement = ((this.regs[0x12] ?? 0) & 0x04) !== 0;
    for (let i = 0; i < count; i++) {
      out[i] = this.readByte(addr);
      if (autoIncrement) addr = addr === 0x3f ? 0x3e : addr + 1;
    }
    return out;
  }

  /** Raw timer ticks (unwrapped) at virtual time tMs. */
  timerAt(tMs: number): number {
    const hr = ((this.regs[0x5c] ?? 0) & 0x10) !== 0;
    const ticksPerMs = (hr ? 40 : 1 / 6.4) * this.oscScale;
    return this.timerBase + Math.floor((tMs - this.timerStartMs) * ticksPerMs);
  }

  /** Produces every FIFO sample due up to now. */
  sync(): void {
    if (!this.running) return;
    const now = this.clock.now();
    while (this.startMs + this.tick * this.periodMs <= now) {
      this.produce(this.tick);
      this.tick++;
    }
  }

  private resetTimer(): void {
    this.timerStartMs = this.clock.now();
    this.timerBase = this.timestampOffset;
  }

  private timestampNow(): number {
    return this.timerAt(this.clock.now()) & 0xffffff;
  }

  private fifoControl(value: number): void {
    const mode = value & 0x07;
    const odrCode = (value >> 3) & 0x0f;
    if (mode === 0 || odrCode === 0) {
      this.running = false;
      this.count = 0;
      this.head = 0;
      this.overrun = false;
      return;
    }
    if (mode !== 6) throw new Error(`FIFO mode ${mode} not modelled`);
    if (this.running) return;
    const ctrl3 = this.regs[0x08] ?? 0;
    this.decG = DECIMATION[(ctrl3 >> 3) & 7] ?? 0;
    this.decXl = DECIMATION[ctrl3 & 7] ?? 0;
    this.cycle = lcm(Math.max(1, this.decG), Math.max(1, this.decXl));
    this.periodMs = 1000 / (BASE_ODR_HZ / 2 ** (10 - odrCode)) / this.oscScale;
    this.running = true;
    this.startMs = this.clock.now();
    this.tick = 1; // first sample one period after enabling
    this.session++;
    this.current = null;
  }

  private produce(tick: number): void {
    const tMs = this.startMs + tick * this.periodMs;
    const pos = (tick - 1) % this.cycle;
    const m = this.motion(tMs / 1000);
    if (pos === 0) {
      this.flushFrame();
      this.patternPos = 0;
      this.current = [];
      this.currentTs = this.timerAt(tMs);
    }
    if (this.decG && pos % this.decG === 0) {
      for (const v of m.gyro) this.push(clip(v, this.gyroClip));
    }
    if (this.decXl && pos % this.decXl === 0) {
      for (const v of m.accel) this.push(clip(v, this.accelClip));
    }
    if (pos === this.cycle - 1) this.flushFrame();
  }

  private flushFrame(): void {
    if (this.current && this.current.length > 0) {
      this.frames.push({
        tsTicks: this.currentTs,
        words: Int16Array.from(this.current),
        session: this.session,
      });
    }
    this.current = null;
  }

  private push(word: number): void {
    this.current?.push(word);
    if (this.count === FIFO_WORDS) {
      this.head = (this.head + 1) % FIFO_WORDS; // continuous mode: oldest overwritten
      this.count--;
      this.overrun = true;
    }
    const at = (this.head + this.count) % FIFO_WORDS;
    this.fifo[at] = word;
    this.fifoPattern[at] = this.patternPos++;
    this.count++;
  }

  private readByte(addr: number): number {
    switch (addr) {
      case 0x20:
      case 0x21: {
        const raw = Math.max(-32768, Math.min(32767, Math.round((this.tempC - 25) * 256)));
        return addr === 0x20 ? raw & 0xff : (raw >> 8) & 0xff;
      }
      case 0x3a:
        return this.count & 0xff;
      case 0x3b:
        return (
          ((this.count >> 8) & 0x07) |
          (this.overrun ? 0x40 : 0) |
          (this.count === FIFO_WORDS ? 0x20 : 0) |
          (this.count === 0 ? 0x10 : 0)
        );
      case 0x3c:
      case 0x3d: {
        const p = this.count > 0 ? (this.fifoPattern[this.head] ?? 0) : 0;
        return addr === 0x3c ? p & 0xff : (p >> 8) & 0x03;
      }
      case 0x3e:
        return this.count > 0 ? (this.fifo[this.head] ?? 0) & 0xff : 0;
      case 0x3f: {
        if (this.count === 0) return 0;
        const hi = ((this.fifo[this.head] ?? 0) >> 8) & 0xff;
        this.head = (this.head + 1) % FIFO_WORDS;
        this.count--;
        return hi;
      }
      case 0x40:
        return this.latchedTs & 0xff;
      case 0x41:
        return (this.latchedTs >> 8) & 0xff;
      case 0x42:
        return (this.latchedTs >> 16) & 0xff;
      default:
        return this.regs[addr] ?? 0;
    }
  }
}

/** Saturates at ±limit (the int16 range when limit is 32767). */
function clip(v: number, limit: number): number {
  const lo = limit >= 32767 ? -32768 : -limit;
  return Math.max(lo, Math.min(limit, Math.round(v)));
}

function lcm(a: number, b: number): number {
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  return (a * b) / gcd(a, b);
}

/* ======================================================================== */
/* BLE model and Espruino runtime                                           */
/* ======================================================================== */

export interface BleOptions {
  /** ATT MTU: notifications are truncated to MTU − 3 bytes. */
  mtu: 23 | 53;
  connIntervalMs: number;
  /** Notifications the link carries per connection event. */
  packetsPerEvent: number;
  /** TX queue of the stack; a notify() into a full queue is DROPPED SILENTLY. */
  txQueue: number;
  /** Probability that a queued notification is lost anyway (silently). */
  lossRate: number;
  seed: number;
}

export interface TxRecord {
  /** Global order of tx and rx records (shared with rxLog). */
  readonly seq: number;
  readonly t: number;
  readonly bytes: Uint8Array;
  readonly fate: 'sent' | 'queue-full' | 'lost';
}

export const DEFAULT_BLE: BleOptions = {
  mtu: 53,
  connIntervalMs: 15,
  packetsPerEvent: 4,
  txQueue: 6,
  lossRate: 0,
  seed: 1,
};

/**
 * Runs the Espruino firmware on Node against fakes of the Espruino APIs it
 * uses (NRF, Puck.accelWr/accelRd, E, LEDs, timers, getTime, process).
 *
 * BLE truth modelled here (docs/sensor-v2.md): NRF.updateServices into a full
 * TX queue does not throw and does not report anything; the notification is
 * simply gone. Notifications leave in connection events, `packetsPerEvent`
 * at a time; app → sensor writes are delivered at the next connection event.
 */
export class FirmwareHarness {
  readonly clock = new VirtualClock();
  readonly imu = new Lsm6ds3Model(this.clock);
  readonly ble: BleOptions;
  /** Notifications the phone received, in order. */
  readonly notifications: Uint8Array[] = [];
  /** Every notify() call by the firmware and what became of it. */
  readonly txLog: TxRecord[] = [];
  /** Commands the firmware received, with the time. */
  readonly rxLog: { readonly seq: number; readonly t: number; readonly bytes: Uint8Array }[] = [];
  advertisedName: string | null = null;
  accelOnCalls = 0;
  getTemperatureCalls = 0;
  /** Simulated I2C cost per byte, µs (time passes while JS waits). */
  i2cUsPerByte = 0;
  /** Write without response lost on the way to the sensor (rare in practice). */
  writeLossRate = 0;

  private readonly handlers = new Map<string, () => void>();
  private controlWrite: ((evt: { data: ArrayBuffer }) => void) | null = null;
  private readonly txQueue: Uint8Array[] = [];
  private readonly rxQueue: Uint8Array[] = [];
  private readonly listeners = new Set<(packet: Uint8Array) => void>();
  private connEvent: number | null = null;
  private linkUp = false;
  private random: () => number;
  private logSeq = 0;

  constructor(ble: Partial<BleOptions> = {}) {
    this.ble = { ...DEFAULT_BLE, ...ble };
    this.random = mulberry32(this.ble.seed);
    const source = readFileSync(FIRMWARE_PATH, 'utf8');
    const NRF = {
      setServices: (
        services: Record<string, Record<string, { onWrite?: (e: { data: ArrayBuffer }) => void }>>,
      ) => {
        for (const service of Object.values(services)) {
          for (const characteristic of Object.values(service)) {
            if (characteristic.onWrite) this.controlWrite = characteristic.onWrite;
          }
        }
      },
      setAdvertising: (_data: unknown, options: { name?: string }) => {
        this.advertisedName = options.name ?? null;
      },
      getAddress: () => 'e7:8a:12:34:56:78 random',
      setConnectionInterval: () => undefined,
      on: (event: string, fn: () => void) => this.handlers.set(`nrf:${event}`, fn),
      updateServices: (services: Record<string, Record<string, { value: Uint8Array }>>) => {
        for (const service of Object.values(services)) {
          for (const characteristic of Object.values(service)) {
            this.enqueue(Uint8Array.from(characteristic.value));
          }
        }
      },
    };
    const busyFor = (bytes: number) => {
      if (this.i2cUsPerByte > 0) this.clock.busy((bytes * this.i2cUsPerByte) / 1000);
    };
    const Puck = {
      on: () => undefined,
      accelOn: () => {
        this.accelOnCalls++;
      },
      accelOff: () => undefined,
      accelWr: (reg: number, value: number) => {
        busyFor(2);
        this.imu.write(reg, value);
      },
      accelRd: (reg: number, count?: number) => {
        busyFor(1 + (count ?? 1));
        return count === undefined ? this.imu.read(reg) : this.imu.read(reg, count);
      },
    };
    const E = {
      getBattery: () => 88,
      CRC32: (data: Uint8Array) => crc32(data),
      getTemperature: () => {
        this.getTemperatureCalls++;
        return 22.4;
      },
    };
    const led = { write: () => undefined };
    // Like Espruino, clearing an id that already fired or was cleared throws.
    const clear = (id: unknown) => {
      if (!this.clock.has(id)) throw new Error('Unknown Timeout');
      this.clock.clear(id);
    };
    const timers = {
      setTimeout: (fn: () => void, ms?: number) => this.clock.setTimeout(fn, ms ?? 0),
      setInterval: (fn: () => void, ms: number) => this.clock.setInterval(fn, ms),
      clearTimeout: clear,
      clearInterval: clear,
    };
    const processFake = {
      // Puck.js v2 figures are placeholders; T6 measures the real ones.
      memory: () => ({ free: 9000, usage: 3000, total: 12000 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(
      'NRF',
      'Puck',
      'E',
      'LED1',
      'LED2',
      'LED3',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
      'getTime',
      'process',
      source,
    ) as (...args: unknown[]) => void;
    run(
      NRF,
      Puck,
      E,
      led,
      led,
      led,
      timers.setTimeout,
      timers.setInterval,
      timers.clearTimeout,
      timers.clearInterval,
      () => this.clock.now() / 1000,
      processFake,
    );
  }

  /** Link up and notifications enabled, without any command written yet. */
  connectLink(): void {
    this.linkUp = true;
    this.connEvent = this.clock.setInterval(() => {
      this.connectionEvent();
    }, this.ble.connIntervalMs);
    this.handlers.get('nrf:connect')?.();
  }

  /**
   * Link up and the v1 app's first command (RequestStatus); runs until the
   * FIFO is streaming and clears the notifications seen so far.
   */
  connect(): void {
    this.connectLink();
    this.write(0x01);
    this.run(300);
    this.notifications.length = 0;
  }

  disconnect(): void {
    this.linkUp = false;
    if (this.connEvent !== null) this.clock.clear(this.connEvent);
    this.connEvent = null;
    this.txQueue.length = 0;
    this.rxQueue.length = 0;
    this.handlers.get('nrf:disconnect')?.();
  }

  /** App → sensor write; delivered at the next connection event. */
  write(command: number | Uint8Array): void {
    if (!this.linkUp) return;
    if (this.writeLossRate > 0 && this.random() < this.writeLossRate) return;
    this.rxQueue.push(typeof command === 'number' ? Uint8Array.of(command) : command.slice());
  }

  /** Subscribes to notifications as the phone receives them. */
  onNotify(listener: (packet: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Runs the virtual clock. */
  run(ms: number): void {
    this.clock.advance(ms);
  }

  /** JS blocked for `ms` (no timers run, the IMU keeps producing). */
  stallJs(ms: number): void {
    this.clock.busy(ms);
  }

  private enqueue(bytes: Uint8Array): void {
    const t = this.clock.now();
    const truncated = bytes.slice(0, this.ble.mtu - 3);
    if (!this.linkUp) return;
    if (this.txQueue.length >= this.ble.txQueue) {
      this.txLog.push({ seq: this.logSeq++, t, bytes: truncated, fate: 'queue-full' });
      return;
    }
    if (this.ble.lossRate > 0 && this.random() < this.ble.lossRate) {
      this.txLog.push({ seq: this.logSeq++, t, bytes: truncated, fate: 'lost' });
      return;
    }
    this.txLog.push({ seq: this.logSeq++, t, bytes: truncated, fate: 'sent' });
    this.txQueue.push(truncated);
  }

  private connectionEvent(): void {
    for (const command of this.rxQueue.splice(0)) {
      this.rxLog.push({ seq: this.logSeq++, t: this.clock.now(), bytes: command });
      this.controlWrite?.({ data: command.slice().buffer });
    }
    for (const packet of this.txQueue.splice(0, this.ble.packetsPerEvent)) {
      this.notifications.push(packet);
      for (const l of this.listeners) l(packet);
    }
  }
}

/* ======================================================================== */
/* Motion sources                                                           */
/* ======================================================================== */

/**
 * Plays back interleaved 6-axis samples (ax ay az gx gy gz, raw counts) from
 * `startS`, linearly interpolated so 416 Hz gyro samples differ from 104 Hz
 * ones. Before and after the recording the first/last sample is held.
 */
export function motionFromSamples(samples: Int16Array, rateHz: number, startS: number): Motion {
  const n = samples.length / 6;
  const at = (i: number, k: number): number => samples[i * 6 + k] ?? 0;
  return (t) => {
    const x = Math.min(n - 1, Math.max(0, (t - startS) * rateHz));
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    const v = (k: number): number => at(i, k) + (at(i + 1, k) - at(i, k)) * f;
    return { accel: [v(0), v(1), v(2)], gyro: [v(3), v(4), v(5)] };
  };
}

export interface Pulse {
  /** Time of the peak, s. */
  readonly t: number;
  readonly peakDps: number;
  readonly sigmaS: number;
}

/**
 * Gaussian racket-rate pulses about the sensor z axis on top of a small
 * deterministic noise, so that every frame is distinct.
 */
export function pulseMotion(pulses: readonly Pulse[], accelExtraG = 0): Motion {
  return (t) => {
    let dps = 0;
    for (const p of pulses) dps += p.peakDps * Math.exp(-0.5 * ((t - p.t) / p.sigmaS) ** 2);
    const n = (k: number): number => Math.round(Math.sin(t * 7919 + k * 13.37) * 4);
    const g = dps / 0.07;
    const a = (accelExtraG * dps) / 1000 / 0.000488;
    return { accel: [n(1) + a, n(2), 2049 + n(3)], gyro: [n(4) + g * 0.3, n(5), g] };
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
