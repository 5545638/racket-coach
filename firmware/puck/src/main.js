/*
 * Racket Coach firmware v2 for Espruino Puck.js v2 / v2.1 (LSM6DS3TR-C IMU).
 *
 * Role: a deliberately simple sensor (ADR 0001). It reads the IMU FIFO in
 * bursts, detects a swing around its peak racket rate, freezes a window into
 * one of two outboxes and sends it to the app, which does all of the analysis.
 * Design: docs/sensor-v2.md. Wire format: docs/ble-protocol.md.
 *
 * HONESTY NOTE: everything in this file has run only in the host harness
 * (app/test/firmware). Nothing has been measured on a real Puck yet. Items
 * marked [U] must be confirmed by the bench tests (BENCH T1-T9,
 * docs/bring-up.md) before they are relied upon.
 *
 * Written in ES5 for the Espruino interpreter. Upload with the Espruino Web IDE
 * using "Save on Send: Direct to Flash (execute code at boot)".
 */

/* ---------------------------------------------------------------- protocol */
var FW_VERSION = [0, 2, 0];
// Version carried by the v1 messages (CaptureBegin, Status). v1 apps check it.
var PROTOCOL_VERSION = 1;
// Highest protocol this firmware speaks; negotiated with HELLO.
var PROTOCOL_V2 = 2;

var SERVICE_UUID = '7a1c0000-5e2b-4d6f-9c3a-2b8e4f1d6a90';
var DATA_CHARACTERISTIC_UUID = '7a1c0001-5e2b-4d6f-9c3a-2b8e4f1d6a90';
var CONTROL_CHARACTERISTIC_UUID = '7a1c0002-5e2b-4d6f-9c3a-2b8e4f1d6a90';
var DEVICE_NAME_PREFIX = 'RacketCoach';

// Sensor -> app, v1 (kept unchanged for the fallback path).
var MSG_CAPTURE_BEGIN = 0x01;
var MSG_SAMPLE = 0x02;
var MSG_CAPTURE_END = 0x03;
var MSG_STATUS = 0x10;
// Sensor -> app, v2.
var MSG_STATUS2 = 0x18;
var MSG_PROBE = 0x19;
var MSG_BEGIN_A = 0x20;
var MSG_BEGIN_B = 0x21;
var MSG_END = 0x22;
var MSG_BENCH_RESULT = 0x28;
var MSG_DATA = 0x30; // | (capId & 15)

// App -> sensor, v1.
var CMD_REQUEST_STATUS = 0x01;
var CMD_CAPTURE_STATIC = 0x02;
// App -> sensor, v2 (write without response).
var CMD_HELLO = 0x10;
var CMD_ACK = 0x11;
var CMD_NAK = 0x12;
var CMD_DONE = 0x13;
var CMD_PACING = 0x14;
var CMD_MODE = 0x15;
var CMD_BENCH = 0x20;
var NAK_HEADERS = 0xfe; // NAK index meaning "resend BEGIN_A and BEGIN_B"

var KIND_SWING = 0;
var KIND_STATIC = 1;

var MODE_M104 = 0;
var MODE_M416 = 1;
// M416 stays opt-in (the app sends MODE 1) until bench T1 shows that the
// bit-banged I2C keeps up (< ~0.15 ms/byte), see docs/sensor-v2.md.
var DEFAULT_MODE = MODE_M104;

// BEGIN_B flags.
var FLAG_SHORT_HISTORY = 0x01; // window shorter than CAPTURE_MAX_FRAMES
var FLAG_GYRO_CLIPPED = 0x02;
var FLAG_ACCEL_CLIPPED = 0x04;
var FLAG_FIFO_RESET = 0x08; // window cut short by a FIFO reset (overrun)

/* ------------------------------------------------------------------ sensor */
var SAMPLE_RATE_HZ = 104; // nominal frame rate (true: 6666.7 / 64 = 104.17 Hz [V])
var NOMINAL_FRAME_PERIOD_NS = 9600000;
var TIMESTAMP_NS_PER_LSB = 25000; // TIMER_HR = 1 [V]
// LSM6DS3TR-C sensitivities at the ranges configured below (datasheet table 3).
var ACCEL_UG_PER_LSB = 488; // ±16 g
var GYRO_MDPS_PER_LSB = 70; // ±2000 dps
// Clip thresholds; same values as app/src/processing/units.ts. The real gyro
// clip point (28571 vs 32767 counts) is [U] until bench T7.
var GYRO_CLIP_COUNTS = 28000;
var ACCEL_CLIP_COUNTS = 32767 - 64;

// LSM6DS3TR-C register map (datasheet section 9).
var REG_FIFO_CTRL1 = 0x06; // FIFO threshold [7:0]
var REG_FIFO_CTRL2 = 0x07; // FIFO threshold [10:8], timestamp-in-FIFO enable
var REG_FIFO_CTRL3 = 0x08; // DEC_FIFO_GYRO [5:3], DEC_FIFO_XL [2:0]
var REG_FIFO_CTRL4 = 0x09; // 3rd/4th data set decimation (unused)
var REG_FIFO_CTRL5 = 0x0a; // ODR_FIFO [6:3], FIFO_MODE [2:0]
var REG_INT1_CTRL = 0x0d;
var REG_WHO_AM_I = 0x0f; // 0x6A
var REG_CTRL1_XL = 0x10; // ODR_XL [7:4], FS_XL [3:2], LPF1_BW_SEL [1]
var REG_CTRL2_G = 0x11; // ODR_G [7:4], FS_G [3:2]
var REG_CTRL3_C = 0x12; // BDU [6], IF_INC [2]
var REG_CTRL4_C = 0x13; // LPF1_SEL_G [1]
var REG_CTRL6_C = 0x15; // XL_HM_MODE [4] (1 = high performance OFF)
var REG_CTRL7_G = 0x16; // G_HM_MODE [7], HP_EN_G [6]
var REG_CTRL8_XL = 0x17; // LPF2_XL_EN [7], HPCF_XL [6:5]
var REG_CTRL10_C = 0x19; // TIMER_EN [5]
var REG_OUT_TEMP_L = 0x20; // 256 LSB/°C, 0 = 25 °C
var REG_FIFO_STATUS1 = 0x3a; // 0x3A..0x3D: DIFF_FIFO, flags, FIFO_PATTERN
var REG_FIFO_DATA_OUT_L = 0x3e;
var REG_TIMESTAMP0 = 0x40; // 0x40..0x42, 24 bit
var REG_TIMESTAMP2 = 0x42; // writing 0xAA resets the counter (datasheet) [U, T3]
var REG_WAKE_UP_DUR = 0x5c; // TIMER_HR [4]

var FIFO_STATUS2_OVER_RUN = 0x40;
var FIFO_MODE_BYPASS = 0x00;
var FIFO_START_DELAY_MS = 100; // let the filters settle before FIFO starts

/*
 * Per-mode register values (docs/sensor-v2.md, "Register settings").
 * gyroOffsets: word offsets of the gyro samples inside one FIFO frame; the
 * accelerometer sample is always at word 3. Frame layout [E, verify FIFO
 * pattern in T2]: M104 = G, A (6 words); M416 = G0, A0, G1, G2, G3 (15 words).
 */
var MODES = [
  {
    id: MODE_M104,
    ctrl1Xl: 0x46, // 104 Hz, ±16 g, LPF1 at ODR/4
    ctrl2G: 0x4c, // 104 Hz, ±2000 dps
    ctrl8Xl: 0x00, // LPF2 off
    fifoCtrl3: 0x09, // gyro and accel undecimated
    fifoCtrl5: 0x26, // FIFO ODR 104 Hz, continuous
    frameWords: 6,
    gyroOffsets: [0],
    filterCfg: 1, // accel LPF1 ODR/4
  },
  {
    id: MODE_M416,
    ctrl1Xl: 0x64, // 416 Hz, ±16 g
    ctrl2G: 0x6c, // 416 Hz, ±2000 dps
    ctrl8Xl: 0xc0, // accel LPF2 at ODR/9 (46 Hz)
    fifoCtrl3: 0x0c, // gyro undecimated, accel ÷4 -> 104 Hz
    fifoCtrl5: 0x36, // FIFO ODR 416 Hz, continuous
    frameWords: 15,
    gyroOffsets: [0, 6, 9, 12],
    filterCfg: 2, // accel LPF2 ODR/9
  },
];

/* --------------------------------------------------------- swing detection */
var POLL_MS = 30;
var MAX_FRAMES_PER_POLL = 8; // 240 B burst in M416 (T1 measures its cost)
var RING_FRAMES = 237; // CAPTURE_MAX_FRAMES + one burst of newer frames
var MAX_FRAME_BYTES = 30;
var CAPTURE_MAX_FRAMES = 229; // 2.2 s
var STATIC_FRAMES = 104; // 1.0 s for calibration poses
var H_HALF_FRAMES = 15; // raw 416 Hz gyro for peak ± 15 frames (± 144 ms)
var H_MAX_FRAMES = 2 * H_HALF_FRAMES + 1;
var L_BYTES_PER_FRAME = 12;
var H_BYTES_PER_FRAME = 24;
var STREAM_MAX_BYTES = CAPTURE_MAX_FRAMES * L_BYTES_PER_FRAME + H_MAX_FRAMES * H_BYTES_PER_FRAME;

var TRIGGER_COUNTS = Math.round(300000 / GYRO_MDPS_PER_LSB); // 300 dps: v1 trigger index
var RELEASE_COUNTS = Math.round(100000 / GYRO_MDPS_PER_LSB); // 100 dps
var CONFIRM_COUNTS = Math.round(700000 / GYRO_MDPS_PER_LSB); // 700 dps opens a swing
var TRIGGER_SQ = TRIGGER_COUNTS * TRIGGER_COUNTS;
var RELEASE_SQ = RELEASE_COUNTS * RELEASE_COUNTS;
var CONFIRM_SQ = CONFIRM_COUNTS * CONFIRM_COUNTS;
var QUIET_FRAMES_TO_CLOSE = 16; // ~150 ms below release
var MAX_FRAMES_AFTER_PEAK = 83; // ~0.8 s
var PERIOD_SNAPSHOT_TICKS = 80000; // 2 s of 25 µs timestamp ticks
var PERIOD_REANCHOR_TICKS = 12000000; // 300 s

/* ------------------------------------------------------------ transmission */
var P_MIN = 18; // DATA payload at MTU 23 (20-byte notifications)
var P_MAX = 48; // DATA payload at MTU 53 (50-byte notifications)
var PROBE_BYTES = 50;
var DEFAULT_CREDIT = 24;
var DEFAULT_BLOCKS_PER_TICK = 2;
var DEFAULT_TICK_MS = 30;
// v1 has no recovery, so it is paced too: 4 packets per 30 ms. [U, T5]
var V1_PACKETS_PER_TICK = 4;
var OUTBOX_TIMEOUT_MS = 5000; // no ACK/NAK for this long -> drop
// END rounds whose NAKs show no progress before the capture is dropped.
// docs/sensor-v2.md says 3; with 30 % random loss in the harness, 3 dropped
// ~3 % of captures (one block lost three times in a row), 6 dropped none.
var MAX_NAK_ROUNDS = 6;
var MAX_END_ROUNDS = 20; // hard bound on END rounds per capture

var OUTBOX_FREE = 0;
var OUTBOX_BUSY = 1;

var CAP_IDLE = 0;
var CAP_ACTIVE = 1;
var CAP_STATIC = 2;

/* ------------------------------------------------------------------- state */
// All buffers are allocated once at boot.
var ring = new Uint8Array(RING_FRAMES * MAX_FRAME_BYTES);
var ring16 = new Int16Array(ring.buffer);
var outboxes = [newOutbox(), newOutbox()];
var sendQueue = []; // busy outboxes, oldest first
var pkt = new Uint8Array(PROBE_BYTES); // DATA and PROBE packets
var msg20 = new Uint8Array(20); // headers, status, bench results
var msg20View = new DataView(msg20.buffer);
var sampleMsg = new Uint8Array(16); // v1 Sample
var sampleView = new DataView(sampleMsg.buffer);

var connected = false;
// True once the app has written anything, i.e. it has subscribed to
// notifications. Nothing is captured or streamed before that.
var appReady = false;
var v2Active = false; // the app sent HELLO with protoMax >= 2
var payloadBytes = P_MIN; // P, raised by the PROBE handshake
var probeLenReceived = 0;
var blocksPerTick = DEFAULT_BLOCKS_PER_TICK;
var tickMs = DEFAULT_TICK_MS;

var mode = MODES[DEFAULT_MODE];
var imuRunning = false; // FIFO is producing and poll() is armed
var pollTimer = null;
var txTimer = null;
var fifoStartTimer = null;
var benchHold = false; // a bench test owns the FIFO

var frameNo = 0; // absolute number of the next frame to be read
var ringStartFrame = 0; // first valid frame after the last reset
var ringResetByFifo = false; // last ring reset was an overrun/resync
var capState = CAP_IDLE;
var peakFrame = 0;
var peakSq = 0;
var quietFrames = 0;
var staticStartFrame = 0;
var capSeq = 0;

var framePeriodNs = NOMINAL_FRAME_PERIOD_NS;
var snapTs = -1; // timestamp snapshot for the frame period estimate
var snapFrames = 0;
var lastPollTs = 0; // timestamp read in the latest poll
var lastPollProduced = 0; // frames produced by the IMU at that moment
var lastPollAt = 0; // getTime() of that timestamp read, s

// Diagnostics (STATUS2, BENCH).
var fifoOverruns = 0;
var droppedCaptures = 0;
var errors = 0;
var stats = newStats();
var maxAbs = [0, 0, 0, 0, 0, 0]; // T7: ax, ay, az, gx, gy, gz since reset

function newOutbox() {
  var buf = new Uint8Array(STREAM_MAX_BYTES);
  return {
    buf: buf,
    buf16: new Int16Array(buf.buffer),
    resend: new Uint8Array(256), // 1 = block queued for resend
    state: OUTBOX_FREE,
  };
}

function newStats() {
  return { maxWords: 0, pollMin: 1e9, pollMax: 0, pollSum: 0, polls: 0, maxGap: 0, lastPoll: 0 };
}

function countError() {
  if (errors < 255) errors++;
}

function nowMs() {
  return getTime() * 1000;
}

/**
 * Cancels a timeout or interval. Espruino throws "Unknown Timeout" for an id
 * that has already fired or been cleared; that must not abort the caller.
 * (clearTimeout and clearInterval are the same function in Espruino.)
 */
function cancelTimer(id) {
  if (!id) return;
  try {
    clearTimeout(id);
  } catch (e) {
    // already gone
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ---------------------------------------------------------------- IMU (I2C) */
function wr(reg, value) {
  Puck.accelWr(reg, value);
}

function readTempRaw() {
  var t = Puck.accelRd(REG_OUT_TEMP_L, 2);
  if (!t) return 0;
  var v = t[0] | (t[1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readTimestamp() {
  var t = Puck.accelRd(REG_TIMESTAMP0, 3);
  return t ? t[0] | (t[1] << 8) | (t[2] << 16) : 0;
}

/**
 * Configures the IMU registers directly. Puck.accelOn is never called: it
 * would set the IMU to its own defaults and make Espruino read one sample per
 * idle pass, which steals the data from the FIFO [V, confirm T2].
 */
function imuConfigure(m) {
  wr(REG_FIFO_CTRL5, FIFO_MODE_BYPASS); // stop and clear the FIFO
  wr(REG_CTRL3_C, 0x44); // BDU, register address auto-increment
  wr(REG_INT1_CTRL, 0x00); // no interrupts: JS polls
  wr(REG_CTRL4_C, 0x00); // gyro LPF1 off
  wr(REG_CTRL6_C, 0x00); // accel high-performance mode
  wr(REG_CTRL7_G, 0x00); // gyro high-performance mode, HPF off
  wr(REG_CTRL8_XL, m.ctrl8Xl);
  wr(REG_CTRL1_XL, m.ctrl1Xl);
  wr(REG_CTRL2_G, m.ctrl2G);
  wr(REG_WAKE_UP_DUR, 0x10); // TIMER_HR: 25 µs timestamp LSB
  wr(REG_CTRL10_C, 0x20); // TIMER_EN (0x24 if the timer needs FUNC_EN [U])
  wr(REG_TIMESTAMP2, 0xaa); // reset the timestamp counter
  wr(REG_FIFO_CTRL1, 0x00); // no threshold
  wr(REG_FIFO_CTRL2, 0x00); // no timestamp in the FIFO
  wr(REG_FIFO_CTRL4, 0x00); // no 3rd/4th data set
  wr(REG_FIFO_CTRL3, m.fifoCtrl3);
}

function imuStart() {
  imuStop();
  imuConfigure(mode);
  fifoStartTimer = setTimeout(function () {
    fifoStartTimer = null;
    try {
      wr(REG_FIFO_CTRL5, mode.fifoCtrl5);
      resetRing(false);
      imuRunning = true;
      stats.lastPoll = nowMs();
      pollTimer = setInterval(poll, POLL_MS);
    } catch (e) {
      countError();
    }
  }, FIFO_START_DELAY_MS);
}

function imuStop() {
  cancelTimer(fifoStartTimer);
  cancelTimer(pollTimer);
  fifoStartTimer = null;
  pollTimer = null;
  imuRunning = false;
  abortCapture(false);
}

/** Power down: accel and gyro ODR 0, FIFO bypass. */
function imuOff() {
  imuStop();
  wr(REG_FIFO_CTRL5, FIFO_MODE_BYPASS);
  wr(REG_CTRL1_XL, 0x00);
  wr(REG_CTRL2_G, 0x00);
}

/** Clears the FIFO (bypass, then continuous again) and the ring. */
function resyncFifo(countAsOverrun) {
  wr(REG_FIFO_CTRL5, FIFO_MODE_BYPASS);
  wr(REG_FIFO_CTRL5, mode.fifoCtrl5);
  if (countAsOverrun && fifoOverruns < 65535) fifoOverruns++;
  resetRing(true); // data was lost or consumed: a swing in progress is dropped
}

function resetRing(byFifo) {
  abortCapture(byFifo);
  ringStartFrame = frameNo;
  ringResetByFifo = byFifo;
  snapTs = -1;
}

/** Abandons a swing being recorded; counted when data was lost (overrun). */
function abortCapture(countIt) {
  if (capState !== CAP_IDLE && countIt && droppedCaptures < 65535) droppedCaptures++;
  capState = CAP_IDLE;
}

/* ------------------------------------------------------------------ poll() */
function poll() {
  if (!imuRunning || benchHold) return;
  var t0 = getTime();
  try {
    pollFifo();
  } catch (e) {
    countError();
  }
  recordPollStats(t0, getTime());
}

/**
 * One FIFO pass: status (4 B), up to MAX_FRAMES_PER_POLL whole frames in one
 * burst, then the timestamp (3 B). Per frame only ‖ω‖² of G0 is computed.
 */
function pollFifo() {
  var st = Puck.accelRd(REG_FIFO_STATUS1, 4);
  if (!st) {
    countError();
    return;
  }
  var words = st[0] | ((st[1] & 0x07) << 8); // DIFF_FIFO: unread 16-bit words
  var pattern = st[2] | ((st[3] & 0x03) << 8); // FIFO_PATTERN of the next word
  if (words > stats.maxWords) stats.maxWords = words;
  if (st[1] & FIFO_STATUS2_OVER_RUN || pattern !== 0) {
    // Overrun (old data overwritten) or misaligned: nothing in the ring can
    // be trusted to be contiguous any more.
    resyncFifo(true);
    return;
  }
  var available = Math.floor(words / mode.frameWords);
  var n = Math.min(available, MAX_FRAMES_PER_POLL);
  var first = frameNo;
  if (n > 0 && !readFrames(n)) return;
  var ts = readTimestamp();
  lastPollAt = getTime();
  lastPollTs = ts;
  lastPollProduced = frameNo + (available - n);
  trackFramePeriod(ts, lastPollProduced);
  for (var f = first; f < frameNo; f++) onFrame(f);
}

function readFrames(n) {
  var fb = mode.frameWords * 2;
  var data = Puck.accelRd(REG_FIFO_DATA_OUT_L, n * fb); // FIFO output wraps 0x3F->0x3E [U, T2]
  if (!data || data.length !== n * fb) {
    countError();
    resyncFifo(false);
    return false;
  }
  var slot = frameNo % RING_FRAMES;
  var head = Math.min(n, RING_FRAMES - slot);
  ring.set(data.subarray(0, head * fb), slot * fb);
  if (head < n) ring.set(data.subarray(head * fb, n * fb), 0);
  frameNo += n;
  return true;
}

/**
 * Frame period in IMU timer units, from (timestamp, frames produced) against
 * an anchor snapshot once >= 2 s apart. The anchor is kept, so the baseline
 * grows and the ±1 frame counting error shrinks; it is moved after 300 s,
 * before the 24-bit timer (419 s) could wrap twice. Verifies ODR and
 * decimation; the IMU oscillator itself is checked against getTime() in T3.
 */
function trackFramePeriod(ts, produced) {
  if (snapTs < 0) {
    snapTs = ts;
    snapFrames = produced;
    return;
  }
  var dt = (ts - snapTs) & 0xffffff;
  if (dt < PERIOD_SNAPSHOT_TICKS) return;
  var df = produced - snapFrames;
  if (df > 0) {
    var p = (dt * TIMESTAMP_NS_PER_LSB) / df;
    if (Math.abs(p - NOMINAL_FRAME_PERIOD_NS) < NOMINAL_FRAME_PERIOD_NS * 0.05) {
      framePeriodNs = Math.round(p);
    }
  }
  if (dt > PERIOD_REANCHOR_TICKS) {
    snapTs = ts;
    snapFrames = produced;
  }
}

function recordPollStats(t0, t1) {
  var us = (t1 - t0) * 1e6;
  if (us < stats.pollMin) stats.pollMin = us;
  if (us > stats.pollMax) stats.pollMax = us;
  stats.pollSum += us;
  stats.polls++;
  var gap = t0 * 1000 - stats.lastPoll;
  if (stats.polls > 1 && gap > stats.maxGap) stats.maxGap = gap;
  stats.lastPoll = t0 * 1000;
}

/* --------------------------------------------------- peak-anchored capture */
function frameGyroSq(f) {
  var w = (f % RING_FRAMES) * mode.frameWords;
  var gx = ring16[w];
  var gy = ring16[w + 1];
  var gz = ring16[w + 2];
  return gx * gx + gy * gy + gz * gz;
}

/**
 * IDLE -> ACTIVE when ‖ω‖ > 700 dps; track the peak; close 150 ms after the
 * rate fell below 100 dps or 0.8 s after the peak. The window is the last
 * min(available, 229) frames ending at the close.
 */
function onFrame(f) {
  var gsq = frameGyroSq(f);
  if (capState === CAP_STATIC) {
    if (f - staticStartFrame + 1 >= STATIC_FRAMES) closeCapture(f, KIND_STATIC);
    return;
  }
  if (capState === CAP_IDLE) {
    if (appReady && gsq > CONFIRM_SQ) {
      capState = CAP_ACTIVE;
      peakFrame = f;
      peakSq = gsq;
      quietFrames = 0;
    }
    return;
  }
  if (gsq > peakSq) {
    peakSq = gsq;
    peakFrame = f;
  }
  quietFrames = gsq < RELEASE_SQ ? quietFrames + 1 : 0;
  if (quietFrames >= QUIET_FRAMES_TO_CLOSE || f >= peakFrame + MAX_FRAMES_AFTER_PEAK) {
    closeCapture(f, KIND_SWING);
  }
}

function closeCapture(f, kind) {
  capState = CAP_IDLE;
  var n = Math.min(f - ringStartFrame + 1, kind === KIND_STATIC ? STATIC_FRAMES : CAPTURE_MAX_FRAMES);
  if (n < 1) return;
  var flags = 0;
  if (kind === KIND_SWING && n < CAPTURE_MAX_FRAMES) {
    flags |= FLAG_SHORT_HISTORY;
    if (ringResetByFifo) flags |= FLAG_FIFO_RESET;
  }
  extract(f - n + 1, n, kind === KIND_SWING ? peakFrame : f - n + 1, kind, f, flags);
}

function startStatic() {
  if (!imuRunning || capState !== CAP_IDLE) return; // ignored during a swing
  capState = CAP_STATIC;
  staticStartFrame = frameNo;
}

/* --------------------------------------------------------------- extract() */
function freeOutbox() {
  for (var i = 0; i < outboxes.length; i++) if (outboxes[i].state === OUTBOX_FREE) return outboxes[i];
  return null;
}

/**
 * Freezes frames [first, first + n) into an outbox, synchronously (the FIFO
 * absorbs the time: 3.3 s in M104, 1.3 s in M416; T6 measures it).
 * Stream = L section (n × 12 B: ax ay az gx gy gz, gyro = mean of the frame's
 * gyro samples) + H section (raw 416 Hz gyro, 24 B per frame, M416 only).
 */
function extract(first, n, peak, kind, closeFrame, flags) {
  var o = freeOutbox();
  if (!o) {
    if (droppedCaptures < 65535) droppedCaptures++; // both outboxes busy
    return null;
  }
  var pk = peak - first;
  var hStart = 0;
  var hFrames = 0;
  if (kind === KIND_SWING && mode.id === MODE_M416) {
    hStart = Math.max(0, pk - H_HALF_FRAMES);
    hFrames = Math.min(n - 1, pk + H_HALF_FRAMES) - hStart + 1;
  }
  flags |= fillLowRate(o, first, n);
  fillHighRate(o, first + hStart, hFrames, n * 6);
  var len = n * L_BYTES_PER_FRAME + hFrames * H_BYTES_PER_FRAME;
  capSeq = (capSeq + 1) & 0xff;

  o.state = OUTBOX_BUSY;
  o.capId = capSeq;
  o.kind = kind;
  o.mode = mode.id;
  o.filterCfg = mode.filterCfg;
  o.n = n;
  o.hStart = hStart;
  o.hFrames = hFrames;
  o.peak = pk;
  o.trigger = kind === KIND_SWING ? triggerIndex(o, pk) : 0;
  o.len = len;
  o.crc = E.CRC32(new Uint8Array(o.buf.buffer, 0, len));
  o.P = payloadBytes;
  o.nBlocks = Math.ceil(len / o.P);
  o.framePeriodNs = framePeriodNs;
  o.tsLast = lastFrameTimestamp(closeFrame);
  o.temp = readTempRaw(); // IMU OUT_TEMP; E.getTemperature() would block ~50 ms
  o.flags = flags;
  o.v1 = !v2Active;
  resetOutboxTx(o);
  sendQueue.push(o);
  LED2.write(1);
  return o;
}

/** L section; returns the clip flags. Also tracks T7 maxima. */
function fillLowRate(o, first, n) {
  var go = mode.gyroOffsets;
  var k = go.length; // 1 or 4
  var fw = mode.frameWords;
  var out = o.buf16;
  var flags = 0;
  for (var i = 0; i < n; i++) {
    var w = ((first + i) % RING_FRAMES) * fw;
    var d = i * 6;
    for (var a = 0; a < 3; a++) {
      var acc = ring16[w + 3 + a];
      out[d + a] = acc;
      var aa = acc < 0 ? -acc : acc;
      if (aa > maxAbs[a]) maxAbs[a] = aa;
      if (aa >= ACCEL_CLIP_COUNTS) flags |= FLAG_ACCEL_CLIPPED;
      var sum = 0;
      for (var j = 0; j < k; j++) {
        var g = ring16[w + go[j] + a];
        sum += g;
        var ga = g < 0 ? -g : g;
        if (ga > maxAbs[3 + a]) maxAbs[3 + a] = ga;
        if (ga >= GYRO_CLIP_COUNTS) flags |= FLAG_GYRO_CLIPPED;
      }
      out[d + 3 + a] = k === 1 ? sum : (sum + 2) >> 2; // mean of 4, rounded
    }
  }
  return flags;
}

/** H section: G0, G1, G2, G3 (x, y, z each) per frame, starting at int16 index `at`. */
function fillHighRate(o, first, hFrames, at) {
  var go = mode.gyroOffsets;
  var fw = mode.frameWords;
  var out = o.buf16;
  for (var h = 0; h < hFrames; h++) {
    var w = ((first + h) % RING_FRAMES) * fw;
    for (var j = 0; j < go.length; j++) {
      out[at++] = ring16[w + go[j]];
      out[at++] = ring16[w + go[j] + 1];
      out[at++] = ring16[w + go[j] + 2];
    }
  }
}

/** v1 trigger index: start of the run above 300 dps that contains the peak. */
function triggerIndex(o, pk) {
  var i = pk;
  while (i > 0) {
    var d = (i - 1) * 6 + 3;
    var gx = o.buf16[d];
    var gy = o.buf16[d + 1];
    var gz = o.buf16[d + 2];
    if (gx * gx + gy * gy + gz * gz <= TRIGGER_SQ) break;
    i--;
  }
  return i;
}

/**
 * IMU timestamp (24 bit, 25 µs) of frame f, from the latest poll. The newest
 * produced frame is assumed half a period before the timestamp read [E]:
 * absolute error up to ± half a frame, relative frame times are exact.
 */
function lastFrameTimestamp(f) {
  var ticks = Math.round(((lastPollProduced - 1 - f + 0.5) * framePeriodNs) / TIMESTAMP_NS_PER_LSB);
  return (lastPollTs - ticks) & 0xffffff;
}

/* -------------------------------------------------------------- BLE output */
function notify(bytes) {
  // A full TX queue is ignored silently by Espruino [V]: no exception, no
  // event. Pacing and the v2 ACK/NAK protocol are the only defences.
  try {
    var services = {};
    services[SERVICE_UUID] = {};
    services[SERVICE_UUID][DATA_CHARACTERISTIC_UUID] = { value: bytes, notify: true };
    NRF.updateServices(services);
  } catch (e) {
    countError();
  }
}

function msg(len) {
  return new Uint8Array(msg20.buffer, 0, len);
}

function batteryPercent() {
  return clamp(Math.round(E.getBattery()), 0, 100);
}

/** v1 Status. Temperature from the IMU (E.getTemperature blocks ~50 ms). */
function statusMessage() {
  var v = msg20View;
  v.setUint8(0, MSG_STATUS);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint8(2, batteryPercent());
  v.setInt8(3, clamp(Math.round(25 + readTempRaw() / 256), -128, 127));
  v.setUint8(4, FW_VERSION[0]);
  v.setUint8(5, FW_VERSION[1]);
  v.setUint8(6, FW_VERSION[2]);
  return msg(7);
}

function status2Message() {
  var v = msg20View;
  var flags = (imuRunning ? 1 : 0) | (outboxes[0].state ? 2 : 0) | (outboxes[1].state ? 4 : 0);
  if (v2Active) flags |= 8;
  v.setUint8(0, MSG_STATUS2);
  v.setUint8(1, PROTOCOL_V2);
  v.setUint8(2, batteryPercent());
  v.setUint8(3, FW_VERSION[0]);
  v.setUint8(4, FW_VERSION[1]);
  v.setUint8(5, FW_VERSION[2]);
  v.setUint8(6, mode.id);
  v.setUint8(7, payloadBytes);
  v.setUint8(8, flags);
  v.setInt16(9, readTempRaw(), true);
  v.setUint16(11, fifoOverruns, true);
  v.setUint16(13, droppedCaptures, true);
  v.setUint16(15, freeVars(), true);
  v.setUint8(17, errors);
  return msg(18);
}

function freeVars() {
  try {
    return clamp(process.memory(false).free, 0, 65535); // false: no GC pass
  } catch (e) {
    return 0;
  }
}

function probeMessage() {
  pkt[0] = MSG_PROBE;
  for (var i = 1; i < PROBE_BYTES; i++) pkt[i] = i;
  return pkt; // the stack truncates it to MTU - 3; the app reports the length
}

function beginA(o) {
  var v = msg20View;
  v.setUint8(0, MSG_BEGIN_A);
  v.setUint8(1, o.capId);
  v.setUint8(2, o.kind);
  v.setUint8(3, o.mode);
  v.setUint16(4, o.n, true);
  v.setUint16(6, o.hStart, true);
  v.setUint16(8, o.hFrames, true);
  v.setUint16(10, o.peak, true);
  v.setUint8(12, o.P);
  v.setUint8(13, o.nBlocks);
  v.setUint16(14, o.len, true);
  v.setUint32(16, o.crc >>> 0, true);
  return msg(20);
}

function beginB(o) {
  var v = msg20View;
  v.setUint8(0, MSG_BEGIN_B);
  v.setUint8(1, o.capId);
  v.setUint32(2, o.framePeriodNs, true);
  v.setUint32(6, o.tsLast, true);
  v.setUint16(10, ACCEL_UG_PER_LSB, true);
  v.setUint16(12, GYRO_MDPS_PER_LSB, true);
  v.setInt16(14, o.temp, true);
  v.setUint8(16, o.filterCfg);
  v.setUint8(17, o.flags);
  return msg(18);
}

function endMessage(o) {
  msg20[0] = MSG_END;
  msg20[1] = o.capId;
  msg20[2] = o.nBlocks;
  return msg(3);
}

/** DATA block k: 2-byte header + a slice of the outbox (copied into pkt). */
function dataMessage(o, k) {
  var off = k * o.P;
  var len = Math.min(o.P, o.len - off);
  pkt[0] = MSG_DATA | (o.capId & 15);
  pkt[1] = k;
  pkt.set(new Uint8Array(o.buf.buffer, off, len), 2);
  return new Uint8Array(pkt.buffer, 0, len + 2);
}

/* v1 fallback messages, built from the L section (same 12-byte layout). */
function v1Begin(o) {
  var v = msg20View;
  v.setUint8(0, MSG_CAPTURE_BEGIN);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint8(2, o.capId);
  v.setUint8(3, o.kind);
  v.setUint16(4, SAMPLE_RATE_HZ, true);
  v.setUint16(6, ACCEL_UG_PER_LSB, true);
  v.setUint16(8, GYRO_MDPS_PER_LSB, true);
  v.setUint16(10, o.trigger, true);
  return msg(12);
}

function v1Sample(o, i) {
  sampleView.setUint8(0, MSG_SAMPLE);
  sampleView.setUint8(1, o.capId);
  sampleView.setUint16(2, i, true);
  sampleMsg.set(new Uint8Array(o.buf.buffer, i * 12, 12), 4);
  return sampleMsg;
}

function v1End(o) {
  var v = msg20View;
  v.setUint8(0, MSG_CAPTURE_END);
  v.setUint8(1, o.capId);
  v.setUint16(2, o.n, true);
  v.setUint32(4, E.CRC32(new Uint8Array(o.buf.buffer, 0, o.n * 12)) >>> 0, true);
  return msg(8);
}

/* -------------------------------------------------------------------- tx() */
function resetOutboxTx(o) {
  o.hdrA = true;
  o.hdrB = true;
  o.nextSend = 0;
  o.ackNext = 0;
  o.credit = DEFAULT_CREDIT;
  for (var i = 0; i < 256; i++) o.resend[i] = 0;
  o.resendCount = 0;
  o.endPending = true;
  o.endsSent = 0;
  o.noProgress = 0;
  o.nakedThisRound = 0;
  o.nakedLastRound = 0;
  o.ackAtLastEnd = 0;
  o.lastHeard = nowMs();
  o.v1Next = 0;
}

function startTx() {
  cancelTimer(txTimer);
  txTimer = setInterval(tx, tickMs);
}

function tx() {
  try {
    if (!connected || !sendQueue.length) return;
    var o = sendQueue[0];
    if (o.v1) {
      txV1(o, V1_PACKETS_PER_TICK);
      return;
    }
    if (nowMs() - o.lastHeard > OUTBOX_TIMEOUT_MS) {
      dropOutbox(o);
      return;
    }
    for (var i = 0; i < blocksPerTick; i++) if (!txNextV2(o)) break;
  } catch (e) {
    countError();
  }
}

/** Sends one packet of outbox o if flow control allows; returns false if not. */
function txNextV2(o) {
  if (o.hdrA) {
    o.hdrA = false;
    notify(beginA(o));
    return true;
  }
  if (o.hdrB) {
    o.hdrB = false;
    notify(beginB(o));
    return true;
  }
  // Never beyond nextBlock + credit - 1 of the latest cumulative ACK.
  var limit = Math.min(o.nBlocks, o.ackNext + o.credit);
  if (o.resendCount > 0) {
    for (var k = o.ackNext; k < limit; k++) {
      if (o.resend[k]) {
        o.resend[k] = 0;
        o.resendCount--;
        notify(dataMessage(o, k));
        return true;
      }
    }
  }
  if (o.nextSend < limit) {
    notify(dataMessage(o, o.nextSend++));
    return true;
  }
  if (o.nextSend >= o.nBlocks && o.endPending && o.resendCount === 0) {
    sendEnd(o);
    return true;
  }
  return false;
}

/** END closes one round; rounds whose NAKs show no progress are limited. */
function sendEnd(o) {
  o.endPending = false;
  if (o.endsSent > 0) {
    var progress = o.ackNext > o.ackAtLastEnd || o.nakedThisRound < o.nakedLastRound;
    o.noProgress = progress ? 0 : o.noProgress + 1;
    if (o.noProgress >= MAX_NAK_ROUNDS || o.endsSent >= MAX_END_ROUNDS) {
      dropOutbox(o);
      return;
    }
  }
  o.nakedLastRound = o.nakedThisRound;
  o.nakedThisRound = 0;
  o.ackAtLastEnd = o.ackNext;
  o.endsSent++;
  notify(endMessage(o));
}

function txV1(o, budget) {
  for (var i = 0; i < budget; i++) {
    if (o.v1Next === 0) notify(v1Begin(o));
    else if (o.v1Next <= o.n) notify(v1Sample(o, o.v1Next - 1));
    else {
      notify(v1End(o));
      releaseOutbox(o);
      return;
    }
    o.v1Next++;
  }
}

function releaseOutbox(o) {
  o.state = OUTBOX_FREE;
  var i = sendQueue.indexOf(o);
  if (i >= 0) sendQueue.splice(i, 1);
  if (sendQueue.length) sendQueue[0].lastHeard = nowMs(); // its timeout starts now
  else LED2.write(0);
}

function dropOutbox(o) {
  if (droppedCaptures < 65535) droppedCaptures++;
  releaseOutbox(o);
}

/** Outbox for a capture id; matched on the low 4 bits like DATA packets. */
function findOutbox(capId) {
  for (var i = 0; i < outboxes.length; i++) {
    var o = outboxes[i];
    if (o.state === OUTBOX_BUSY && !o.v1 && (o.capId & 15) === (capId & 15)) return o;
  }
  return null;
}

function onAck(capId, next, credit) {
  var o = findOutbox(capId);
  if (!o) return;
  o.lastHeard = nowMs();
  next = Math.min(next, o.nBlocks);
  for (var k = o.ackNext; k < next; k++) {
    if (o.resend[k]) {
      o.resend[k] = 0;
      o.resendCount--;
    }
  }
  if (next > o.ackNext) o.ackNext = next;
  if (credit > 0) o.credit = credit;
}

function onNak(d) {
  var o = findOutbox(d[1]);
  if (!o) return;
  o.lastHeard = nowMs();
  var n = Math.min(d[2] | 0, d.length - 3);
  for (var i = 0; i < n; i++) {
    var k = d[3 + i];
    if (k === NAK_HEADERS) {
      o.hdrA = true;
      o.hdrB = true;
    } else if (k < o.nBlocks && k >= o.ackNext && !o.resend[k]) {
      o.resend[k] = 1;
      o.resendCount++;
    }
  }
  o.nakedThisRound += n;
  o.endPending = true; // END again once the resends are out
}

function onDone(capId) {
  var o = findOutbox(capId);
  if (o) releaseOutbox(o);
}

/* ---------------------------------------------------------------- commands */
function onHello(protoMax, probeLen) {
  if (!(protoMax >= PROTOCOL_V2)) {
    v2Active = false; // the app fell back to v1 explicitly
    return;
  }
  v2Active = true;
  if (!probeLen) {
    notify(probeMessage());
  } else {
    probeLenReceived = probeLen;
    payloadBytes = clamp(probeLen - 2, P_MIN, P_MAX);
  }
  notify(status2Message());
}

function setPacing(perTick, ms) {
  blocksPerTick = clamp(perTick | 0, 1, 6);
  tickMs = clamp(ms | 0, 10, 200);
  if (connected) startTx();
}

function setMode(id) {
  var m = MODES[id];
  if (!m) return;
  if (m !== mode) {
    mode = m;
    if (connected) imuStart();
  }
  notify(status2Message());
}

function handleCommand(d) {
  switch (d[0]) {
    case CMD_REQUEST_STATUS:
      notify(statusMessage());
      if (v2Active) notify(status2Message());
      break;
    case CMD_CAPTURE_STATIC:
      startStatic();
      break;
    case CMD_HELLO:
      onHello(d[1], d[2]);
      break;
    case CMD_ACK:
      onAck(d[1], d[2] | 0, d[3] | 0);
      break;
    case CMD_NAK:
      onNak(d);
      break;
    case CMD_DONE:
      onDone(d[1]);
      break;
    case CMD_PACING:
      setPacing(d[1], d[2]);
      break;
    case CMD_MODE:
      setMode(d[1]);
      break;
    case CMD_BENCH:
      runBench(d[1], (d[2] | 0) | ((d[3] | 0) << 8));
      break;
  }
}

function onControlWrite(evt) {
  try {
    appReady = true;
    handleCommand(new Uint8Array(evt.data));
  } catch (e) {
    countError();
  }
}

/* ------------------------------------------------------------ bench tests */
/*
 * BENCH test, param -> one or more BENCH_RESULT (type, test, part, 17 bytes).
 * Payload layouts are documented in docs/ble-protocol.md. T8 (current) and
 * T9 (impact spectrum) need external equipment or app-side analysis and are
 * answered with part 0xFE ("not runnable on the sensor").
 */
var benchBusy = false;
var benchTimer = null; // pending timeout/interval of an asynchronous test

function benchResult(test, part, fill) {
  for (var i = 0; i < 20; i++) msg20[i] = 0;
  msg20[0] = MSG_BENCH_RESULT;
  msg20[1] = test;
  msg20[2] = part;
  if (fill) fill(msg20View);
  notify(msg(20));
}

function benchDone() {
  benchBusy = false;
  benchTimer = null;
  if (benchHold) {
    benchHold = false;
    if (imuRunning) resyncFifo(false); // bench reads consumed FIFO data
  }
}

function runBench(test, param) {
  if (benchBusy) return;
  benchBusy = true;
  try {
    if (test === 1) benchT1(param || 10);
    else if (test === 2) benchT2();
    else if (test === 3) benchT3(param || 4);
    else if (test === 4) benchT4(param || 60);
    else if (test === 5) benchT5(param || 2);
    else if (test === 6) benchT6();
    else if (test === 7) benchT7(param);
    else {
      benchResult(test, 0xfe);
      benchDone();
    }
  } catch (e) {
    countError();
    benchDone();
  }
}

/** T1: µs per accelRd(0x3E, 30/120/240) and per accelWr. Gates M416. */
function benchT1(reps) {
  benchHold = true;
  var sizes = [30, 120, 240];
  var us = [];
  for (var s = 0; s < sizes.length; s++) {
    var t0 = getTime();
    for (var r = 0; r < reps; r++) Puck.accelRd(REG_FIFO_DATA_OUT_L, sizes[s]);
    us.push(((getTime() - t0) * 1e6) / reps);
  }
  var t1 = getTime();
  for (var q = 0; q < reps; q++) wr(REG_CTRL10_C, 0x20);
  us.push(((getTime() - t1) * 1e6) / reps);
  benchResult(1, 0, function (v) {
    for (var i = 0; i < 4; i++) v.setUint32(3 + 4 * i, Math.round(us[i]), true);
    v.setUint8(19, clamp(reps, 0, 255));
  });
  benchDone();
}

/** T2: WHO_AM_I, register readback without accelOn, FIFO pattern and burst wrap. */
function benchT2() {
  benchHold = true;
  if (imuRunning) resyncFifo(false);
  benchTimer = setTimeout(function () {
    try {
      var fw = mode.frameWords;
      var st0 = Puck.accelRd(REG_FIFO_STATUS1, 4);
      var w0 = st0[0] | ((st0[1] & 7) << 8);
      var patternOk = 1;
      for (var i = 0; i < fw; i++) {
        var st = Puck.accelRd(REG_FIFO_STATUS1, 4);
        if ((st[2] | ((st[3] & 3) << 8)) !== i) patternOk = 0;
        Puck.accelRd(REG_FIFO_DATA_OUT_L, 2); // one word
      }
      var st1 = Puck.accelRd(REG_FIFO_STATUS1, 4);
      var w1 = st1[0] | ((st1[1] & 7) << 8);
      Puck.accelRd(REG_FIFO_DATA_OUT_L, fw * 2); // one frame as a burst
      var st2 = Puck.accelRd(REG_FIFO_STATUS1, 4);
      var w2 = st2[0] | ((st2[1] & 7) << 8);
      var who = Puck.accelRd(REG_WHO_AM_I);
      var c1 = Puck.accelRd(REG_CTRL1_XL);
      var c2 = Puck.accelRd(REG_CTRL2_G);
      benchResult(2, 0, function (v) {
        v.setUint8(3, who);
        v.setUint8(4, c1);
        v.setUint8(5, c2);
        v.setUint8(6, mode.id);
        v.setUint16(7, w0, true);
        v.setUint8(9, patternOk);
        v.setUint16(10, w1, true);
        v.setUint16(12, w2, true); // w1 - w2 ≈ fw words if the burst wraps
        v.setUint8(14, fw);
      });
    } catch (e) {
      countError();
    }
    benchDone();
  }, 200);
}

/** T3: achieved frame rate from IMU timestamps and from getTime() over `s` seconds. */
function benchT3(s) {
  var t0 = lastPollAt;
  var ts0 = lastPollTs;
  var f0 = lastPollProduced;
  benchTimer = setTimeout(function () {
    try {
      var dt = lastPollAt - t0;
      var dts = ((lastPollTs - ts0) & 0xffffff) * TIMESTAMP_NS_PER_LSB * 1e-9;
      var df = lastPollProduced - f0;
      benchResult(3, 0, function (v) {
        v.setUint32(3, Math.round((df / dt) * 1000), true); // mHz, phone-independent CPU clock
        v.setUint32(7, dts > 0 ? Math.round((df / dts) * 1000) : 0, true); // mHz, IMU clock
        v.setInt32(11, dt > 0 ? Math.round((dts / dt - 1) * 1e6) : 0, true); // IMU vs CPU, ppm
        v.setUint8(15, mode.id);
        v.setUint16(16, clamp(df, 0, 65535), true);
      });
    } catch (e) {
      countError();
    }
    benchDone();
  }, s * 1000);
}

/** T4: FIFO and poll() statistics over `s` seconds. */
function benchT4(s) {
  stats = newStats();
  stats.lastPoll = nowMs();
  var o0 = fifoOverruns;
  benchTimer = setTimeout(function () {
    try {
      benchResult(4, 0, function (v) {
        v.setUint16(3, stats.maxWords, true);
        v.setUint16(5, fifoOverruns - o0, true);
        v.setUint16(7, clamp(Math.round(stats.polls ? stats.pollMin : 0), 0, 65535), true);
        v.setUint16(9, clamp(Math.round(stats.polls ? stats.pollSum / stats.polls : 0), 0, 65535), true);
        v.setUint16(11, clamp(Math.round(stats.pollMax), 0, 65535), true);
        v.setUint16(13, clamp(Math.round(stats.maxGap), 0, 65535), true);
        v.setUint32(15, stats.polls, true);
      });
    } catch (e) {
      countError();
    }
    benchDone();
  }, s * 1000);
}

/** T5: 200 numbered packets at `perTick` per tick; the app counts the losses. */
function benchT5(perTick) {
  var sent = 0;
  var t0 = getTime();
  perTick = clamp(perTick, 1, 6);
  var timer = (benchTimer = setInterval(function () {
    try {
      for (var i = 0; i < perTick && sent < 200; i++) {
        var k = sent++;
        benchResult(5, k & 0xff, function (v) {
          v.setUint16(3, k, true);
        });
      }
      if (sent >= 200) {
        cancelTimer(timer);
        var ms = Math.round((getTime() - t0) * 1000);
        benchResult(5, 0xff, function (v) {
          v.setUint16(3, sent, true);
          v.setUint32(5, ms, true);
          v.setUint8(9, payloadBytes);
          v.setUint8(10, perTick);
          v.setUint8(11, tickMs);
          v.setUint8(12, probeLenReceived);
        });
        benchDone();
      }
    } catch (e) {
      countError();
      cancelTimer(timer);
      benchDone();
    }
  }, tickMs));
}

/** T6: memory with all buffers allocated, and the duration of extract(). */
function benchT6() {
  var mem = process.memory();
  var us = 0;
  var n = Math.min(frameNo - ringStartFrame, CAPTURE_MAX_FRAMES);
  if (n > 0 && freeOutbox()) {
    var t0 = getTime();
    var o = extract(frameNo - n, n, frameNo - 1 - (n >> 1), KIND_SWING, frameNo - 1, 0);
    us = (getTime() - t0) * 1e6;
    if (o) releaseOutbox(o); // measurement only, never sent
    capSeq = (capSeq - 1) & 0xff;
  }
  benchResult(6, 0, function (v) {
    v.setUint16(3, clamp(mem.free, 0, 65535), true);
    v.setUint16(5, clamp(mem.usage, 0, 65535), true);
    v.setUint16(7, clamp(mem.total, 0, 65535), true);
    v.setUint32(9, Math.round(us), true);
    v.setUint16(13, clamp(n, 0, 65535), true);
  });
  benchDone();
}

/** T7: largest |raw| per axis seen in captures since the last reset (param 1 resets). */
function benchT7(reset) {
  benchResult(7, 0, function (v) {
    for (var i = 0; i < 6; i++) v.setUint16(3 + 2 * i, clamp(maxAbs[i], 0, 65535), true);
  });
  if (reset === 1) maxAbs = [0, 0, 0, 0, 0, 0];
  benchDone();
}

/* ------------------------------------------------------------------- setup */
function onConnect() {
  try {
    connected = true;
    appReady = false;
    v2Active = false;
    payloadBytes = P_MIN;
    probeLenReceived = 0;
    blocksPerTick = DEFAULT_BLOCKS_PER_TICK;
    tickMs = DEFAULT_TICK_MS;
    mode = MODES[DEFAULT_MODE];
    // 15 ms is the shortest interval iOS grants; it maximises throughput.
    NRF.setConnectionInterval(15);
    imuStart();
    startTx();
  } catch (e) {
    countError();
  }
}

function onDisconnect() {
  try {
    connected = false;
    appReady = false;
    v2Active = false;
    cancelTimer(txTimer);
    txTimer = null;
    for (var i = 0; i < outboxes.length; i++) outboxes[i].state = OUTBOX_FREE;
    sendQueue = [];
    cancelTimer(benchTimer);
    benchBusy = false;
    benchTimer = null;
    benchHold = false;
    imuOff(); // the IMU is the main power draw; sleep between sessions
    LED2.write(0);
  } catch (e) {
    countError();
  }
}

function setup() {
  var services = {};
  services[SERVICE_UUID] = {};
  services[SERVICE_UUID][DATA_CHARACTERISTIC_UUID] = {
    value: [0],
    maxLen: PROBE_BYTES, // 50-byte notifications when the central negotiated MTU 53
    readable: true,
    notify: true,
    description: 'Data',
  };
  services[SERVICE_UUID][CONTROL_CHARACTERISTIC_UUID] = {
    value: [0],
    maxLen: 20,
    // Espruino enables write and write-without-response together [U, T5].
    writable: true,
    onWrite: onControlWrite,
    description: 'Control',
  };
  // Keep the Nordic UART so the Web IDE can still reprogram the device.
  NRF.setServices(services, { uart: true });

  // getAddress() returns e.g. "e7:8a:12:34:56:78 random"; keep the last 2 bytes.
  var suffix = NRF.getAddress().split(' ')[0].substr(-5).replace(':', '');
  NRF.setAdvertising({}, { name: DEVICE_NAME_PREFIX + ' ' + suffix });

  NRF.on('connect', onConnect);
  NRF.on('disconnect', onDisconnect);
}

setup();
