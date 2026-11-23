/*
 * Racket Coach firmware for Espruino Puck.js v2 / v2.1 (LSM6DS3TR-C IMU).
 *
 * Role: a deliberately simple sensor. It detects that a swing is happening,
 * records a window around it and streams the raw samples to the app, which
 * does all of the analysis (ADR 0001). Wire format: docs/ble-protocol.md.
 *
 * Written in ES5 for the Espruino interpreter. Upload with the Espruino Web IDE
 * using "Save on Send: Direct to Flash (execute code at boot)".
 */

/* ---------------------------------------------------------------- protocol */
var FW_VERSION = [0, 1, 0];
var PROTOCOL_VERSION = 1;

var SERVICE_UUID = '7a1c0000-5e2b-4d6f-9c3a-2b8e4f1d6a90';
var DATA_CHARACTERISTIC_UUID = '7a1c0001-5e2b-4d6f-9c3a-2b8e4f1d6a90';
var CONTROL_CHARACTERISTIC_UUID = '7a1c0002-5e2b-4d6f-9c3a-2b8e4f1d6a90';
var DEVICE_NAME_PREFIX = 'RacketCoach';

var MSG_CAPTURE_BEGIN = 0x01;
var MSG_SAMPLE = 0x02;
var MSG_CAPTURE_END = 0x03;
var MSG_STATUS = 0x10;

var CMD_REQUEST_STATUS = 0x01;
var CMD_CAPTURE_STATIC = 0x02;

var KIND_SWING = 0;
var KIND_STATIC = 1;

/* ------------------------------------------------------------------ sensor */
var SAMPLE_RATE_HZ = 104;
// LSM6DS3TR-C sensitivities at the ranges configured below (datasheet table 3).
var ACCEL_UG_PER_LSB = 488; // ±16 g
var GYRO_MDPS_PER_LSB = 70; // ±2000 dps
var REG_CTRL1_XL = 0x10;
var REG_CTRL2_G = 0x11;
var CTRL1_XL_104HZ_16G = 0x44; // ODR_XL=0100 (104 Hz), FS_XL=01 (±16 g)
var CTRL2_G_104HZ_2000DPS = 0x4c; // ODR_G=0100 (104 Hz), FS_G=11 (±2000 dps)

/* --------------------------------------------------------- swing detection */
var PRE_TRIGGER_SAMPLES = 125; // 1.2 s of history: ready position and backswing
var MAX_POST_TRIGGER_SAMPLES = 104; // capture length cap: pre-trigger history + 1.0 s
var STATIC_SAMPLES = 104; // 1.0 s for calibration poses
var TRIGGER_COUNTS = Math.round(300000 / GYRO_MDPS_PER_LSB); // 300 dps
var RELEASE_COUNTS = Math.round(100000 / GYRO_MDPS_PER_LSB); // 100 dps
// A capture is only sent once the rate exceeds this; slower motions (waggles,
// a slow backswing) are dropped silently and the ring buffer keeps them as
// history for the real swing.
var CONFIRM_COUNTS = Math.round(700000 / GYRO_MDPS_PER_LSB); // 700 dps
var QUIET_SAMPLES_TO_END = 16; // ~150 ms below release ends the swing
var TRIGGER_SQ = TRIGGER_COUNTS * TRIGGER_COUNTS;
var RELEASE_SQ = RELEASE_COUNTS * RELEASE_COUNTS;
var CONFIRM_SQ = CONFIRM_COUNTS * CONFIRM_COUNTS;
var MAX_CAPTURE_SAMPLES = PRE_TRIGGER_SAMPLES + MAX_POST_TRIGGER_SAMPLES;

var SAMPLE_MESSAGE_BYTES = 16;
var RETRY_MS = 15;

/* ------------------------------------------------------------------- state */
var ring = new Int16Array(PRE_TRIGGER_SAMPLES * 6);
var ringHead = 0; // next write position (samples)
var ringFill = 0;

var capture = new Int16Array(MAX_CAPTURE_SAMPLES * 6);
var cap = null; // active capture, see startCapture()
var pumpScheduled = false;
var sequence = 0;
var connected = false;
// True once the app has written a command, i.e. it has subscribed to
// notifications. Nothing is streamed before that.
var appReady = false;

var sampleMsg = new Uint8Array(SAMPLE_MESSAGE_BYTES);
var sampleView = new DataView(sampleMsg.buffer);

/* -------------------------------------------------------------- BLE output */
function notify(bytes) {
  var services = {};
  services[SERVICE_UUID] = {};
  services[SERVICE_UUID][DATA_CHARACTERISTIC_UUID] = { value: bytes, notify: true };
  NRF.updateServices(services);
}

function captureBegin(c) {
  var b = new Uint8Array(12);
  var v = new DataView(b.buffer);
  v.setUint8(0, MSG_CAPTURE_BEGIN);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint8(2, c.sequence);
  v.setUint8(3, c.kind);
  v.setUint16(4, SAMPLE_RATE_HZ, true);
  v.setUint16(6, ACCEL_UG_PER_LSB, true);
  v.setUint16(8, GYRO_MDPS_PER_LSB, true);
  v.setUint16(10, c.triggerIndex, true);
  return b;
}

function sampleMessage(c, index) {
  sampleView.setUint8(0, MSG_SAMPLE);
  sampleView.setUint8(1, c.sequence);
  sampleView.setUint16(2, index, true);
  var o = index * 6;
  for (var k = 0; k < 6; k++) sampleView.setInt16(4 + 2 * k, capture[o + k], true);
  return sampleMsg;
}

function captureEnd(c) {
  var b = new Uint8Array(8);
  var v = new DataView(b.buffer);
  v.setUint8(0, MSG_CAPTURE_END);
  v.setUint8(1, c.sequence);
  v.setUint16(2, c.count, true);
  v.setUint32(4, c.crc, true);
  return b;
}

function statusMessage() {
  var b = new Uint8Array(7);
  var v = new DataView(b.buffer);
  v.setUint8(0, MSG_STATUS);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint8(2, Math.max(0, Math.min(100, Math.round(E.getBattery()))));
  v.setInt8(3, Math.round(E.getTemperature()));
  v.setUint8(4, FW_VERSION[0]);
  v.setUint8(5, FW_VERSION[1]);
  v.setUint8(6, FW_VERSION[2]);
  return b;
}

/**
 * Sends as much of the active capture as the BLE stack accepts. Samples are
 * streamed while the swing is still being recorded, so only the tail is left
 * to send when it ends. On a full TX queue it retries shortly.
 */
function pump() {
  pumpScheduled = false;
  if (!connected) return;
  var c = cap;
  try {
    while (c && c.confirmed) {
      if (!c.beginSent) {
        notify(captureBegin(c));
        c.beginSent = true;
      }
      while (c.sent < c.count) {
        notify(sampleMessage(c, c.sent));
        c.sent++;
      }
      if (!c.closed) return; // wait for more samples
      notify(captureEnd(c));
      cap = null;
      c = null;
      LED2.write(0);
    }
  } catch (e) {
    // NRF_ERROR_RESOURCES: TX queue full. Try again shortly.
    schedulePump(RETRY_MS);
  }
}

function schedulePump(ms) {
  if (pumpScheduled) return;
  pumpScheduled = true;
  setTimeout(pump, ms);
}

/* --------------------------------------------------------------- capturing */
function startCapture(kind) {
  var pre = 0;
  var triggerIndex = 0;
  if (kind === KIND_SWING) {
    // Unroll the ring buffer, oldest sample first.
    var start = (ringHead - ringFill + PRE_TRIGGER_SAMPLES) % PRE_TRIGGER_SAMPLES;
    for (var i = 0; i < ringFill; i++) {
      var src = ((start + i) % PRE_TRIGGER_SAMPLES) * 6;
      for (var k = 0; k < 6; k++) capture[i * 6 + k] = ring[src + k];
    }
    pre = ringFill;
    triggerIndex = pre - 1; // the triggering sample is the newest one in the ring
  }
  cap = {
    kind: kind,
    sequence: 0, // assigned on confirmation, so dropped candidates use no number
    confirmed: false,
    triggerIndex: triggerIndex,
    count: pre,
    sent: 0,
    beginSent: false,
    closed: false,
    quiet: 0,
    crc: 0,
  };
  if (kind === KIND_STATIC) confirmCapture();
}

function confirmCapture() {
  sequence = (sequence + 1) & 0xff;
  cap.sequence = sequence;
  cap.confirmed = true;
  LED2.write(1);
  schedulePump(0);
}

function closeCapture() {
  cap.closed = true;
  cap.crc = E.CRC32(new Uint8Array(capture.buffer, 0, cap.count * 12));
  schedulePump(0);
}

function pushRing(a, g) {
  var r = ringHead * 6;
  ring[r] = a.x;
  ring[r + 1] = a.y;
  ring[r + 2] = a.z;
  ring[r + 3] = g.x;
  ring[r + 4] = g.y;
  ring[r + 5] = g.z;
  ringHead = (ringHead + 1) % PRE_TRIGGER_SAMPLES;
  if (ringFill < PRE_TRIGGER_SAMPLES) ringFill++;
}

function onSample(a, g) {
  var gsq = g.x * g.x + g.y * g.y + g.z * g.z;
  // The ring always holds the latest history, also during a capture, so that
  // a swing directly after another still has its preparation phase.
  pushRing(a, g);

  if (cap && !cap.closed) {
    var o = cap.count * 6;
    capture[o] = a.x;
    capture[o + 1] = a.y;
    capture[o + 2] = a.z;
    capture[o + 3] = g.x;
    capture[o + 4] = g.y;
    capture[o + 5] = g.z;
    cap.count++;
    if (cap.kind === KIND_STATIC) {
      if (cap.count >= STATIC_SAMPLES) closeCapture();
    } else {
      if (!cap.confirmed && gsq > CONFIRM_SQ) confirmCapture();
      cap.quiet = gsq < RELEASE_SQ ? cap.quiet + 1 : 0;
      if (cap.quiet >= QUIET_SAMPLES_TO_END || cap.count >= MAX_CAPTURE_SAMPLES) {
        if (cap.confirmed) {
          closeCapture();
        } else {
          cap = null; // too slow to be a stroke: drop without sending anything
          return;
        }
      }
    }
    if (cap.confirmed) schedulePump(0);
    return;
  }

  // A new swing starts only after the previous capture has been fully sent.
  if (!cap && appReady && gsq > TRIGGER_SQ) startCapture(KIND_SWING);
}

/* ---------------------------------------------------------------- commands */
function onCommand(evt) {
  appReady = true;
  var cmd = new Uint8Array(evt.data)[0];
  if (cmd === CMD_REQUEST_STATUS) {
    try {
      notify(statusMessage());
    } catch (e) {
      setTimeout(function () {
        onCommand(evt);
      }, RETRY_MS);
    }
  } else if (cmd === CMD_CAPTURE_STATIC && !cap) {
    startCapture(KIND_STATIC);
  }
}

/* ------------------------------------------------------------------- setup */
function sensorOn() {
  Puck.accelOn(SAMPLE_RATE_HZ);
  Puck.accelWr(REG_CTRL1_XL, CTRL1_XL_104HZ_16G);
  Puck.accelWr(REG_CTRL2_G, CTRL2_G_104HZ_2000DPS);
}

function setup() {
  var services = {};
  services[SERVICE_UUID] = {};
  services[SERVICE_UUID][DATA_CHARACTERISTIC_UUID] = {
    value: [0],
    maxLen: 20,
    readable: true,
    notify: true,
    description: 'Data',
  };
  services[SERVICE_UUID][CONTROL_CHARACTERISTIC_UUID] = {
    value: [0],
    maxLen: 20,
    writable: true,
    onWrite: onCommand,
    description: 'Control',
  };
  // Keep the Nordic UART so the Web IDE can still reprogram the device.
  NRF.setServices(services, { uart: true });

  // getAddress() returns e.g. "e7:8a:12:34:56:78 random"; keep the last 2 bytes.
  var suffix = NRF.getAddress().split(' ')[0].substr(-5).replace(':', '');
  NRF.setAdvertising({}, { name: DEVICE_NAME_PREFIX + ' ' + suffix });

  Puck.on('accel', function (d) {
    onSample(d.acc, d.gyro);
  });

  NRF.on('connect', function () {
    connected = true;
    appReady = false;
    ringFill = 0;
    // 15 ms is the shortest interval iOS grants; it maximises throughput.
    NRF.setConnectionInterval(15);
    sensorOn();
  });

  NRF.on('disconnect', function () {
    connected = false;
    appReady = false;
    cap = null;
    pumpScheduled = false;
    Puck.accelOff(); // the IMU is the main power draw; sleep between sessions
    LED2.write(0);
  });
}

setup();
