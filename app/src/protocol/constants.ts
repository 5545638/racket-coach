/**
 * Wire protocol between the racket sensor and the app.
 * Specification: docs/ble-protocol.md. Keep in sync with firmware/puck/src/main.js
 * (test/firmware/firmware.test.ts enforces this).
 */
export const PROTOCOL_VERSION = 1;

export const SERVICE_UUID = '7a1c0000-5e2b-4d6f-9c3a-2b8e4f1d6a90';
/** Notify: sensor → app messages. */
export const DATA_CHARACTERISTIC_UUID = '7a1c0001-5e2b-4d6f-9c3a-2b8e4f1d6a90';
/** Write: app → sensor commands. */
export const CONTROL_CHARACTERISTIC_UUID = '7a1c0002-5e2b-4d6f-9c3a-2b8e4f1d6a90';

/** Advertised device name prefix. */
export const DEVICE_NAME_PREFIX = 'RacketCoach';

export const MessageType = {
  CaptureBegin: 0x01,
  Sample: 0x02,
  CaptureEnd: 0x03,
  Status: 0x10,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const Command = {
  RequestStatus: 0x01,
  CaptureStatic: 0x02,
} as const;
export type Command = (typeof Command)[keyof typeof Command];

export const CaptureKindCode = {
  Swing: 0,
  Static: 1,
} as const;

/** Message sizes in bytes (all little-endian). */
export const MessageLength = {
  CaptureBegin: 12,
  Sample: 16,
  CaptureEnd: 8,
  Status: 7,
} as const;

/** Values per sample: ax, ay, az, gx, gy, gz. */
export const AXES_PER_SAMPLE = 6;
export const BYTES_PER_SAMPLE = AXES_PER_SAMPLE * 2;

/** Upper bound on samples per capture; protects the app from malformed headers. */
export const MAX_SAMPLES_PER_CAPTURE = 1024;

/* ------------------------------------------------------------------------ */
/* Protocol v2 (docs/ble-protocol.md, "Version 2"). The app opts in with     */
/* HELLO; firmware that does not answer within HELLO_TIMEOUT_MS speaks v1.   */
/* ------------------------------------------------------------------------ */

export const PROTOCOL_VERSION_V2 = 2;

/** Sensor → app message types added in v2. DATA is `Data | (capId & 15)`. */
export const MessageTypeV2 = {
  Status2: 0x18,
  Probe: 0x19,
  BeginA: 0x20,
  BeginB: 0x21,
  End: 0x22,
  BenchResult: 0x28,
  Data: 0x30,
} as const;

/** App → sensor commands added in v2 (written without response). */
export const CommandV2 = {
  Hello: 0x10,
  Ack: 0x11,
  Nak: 0x12,
  Done: 0x13,
  Pacing: 0x14,
  Mode: 0x15,
  Bench: 0x20,
} as const;

export const MessageLengthV2 = {
  Status2: 18,
  Probe: 50,
  BeginA: 20,
  BeginB: 18,
  End: 3,
  BenchResult: 20,
  /** Minimum DATA length: type, block index, at least one byte. */
  DataMin: 3,
} as const;

/** Sensor IMU modes (docs/sensor-v2.md). */
export const SensorMode = {
  /** Accel and gyro at 104 Hz. Default. */
  M104: 0,
  /** Gyro at 416 Hz (H section around the peak), accel at 104 Hz. Experimental. */
  M416: 1,
} as const;
export type SensorModeCode = (typeof SensorMode)[keyof typeof SensorMode];

/** BEGIN_B flags. */
export const CaptureFlag = {
  ShortPreHistory: 0x01,
  GyroClipped: 0x02,
  AccelClipped: 0x04,
  FifoResetInCapture: 0x08,
} as const;

/** DONE status codes. */
export const DoneStatus = {
  Ok: 0,
  CrcMismatch: 1,
  Abandoned: 2,
} as const;

/** NAK index meaning "resend BEGIN_A and BEGIN_B". */
export const NAK_RESEND_HEADERS = 0xfe;
/** Maximum block indices in one NAK. */
export const NAK_MAX_ENTRIES = 16;
/** Credit the sensor assumes before the first ACK; the app grants the same. */
export const DEFAULT_CREDIT = 24;
/** The app ACKs after this many new blocks, or after ACK_INTERVAL_MS. */
export const ACK_EVERY_BLOCKS = 8;
export const ACK_INTERVAL_MS = 100;
/** The app falls back to v1 when HELLO gets no PROBE/STATUS2 within this time. */
export const HELLO_TIMEOUT_MS = 500;
/** DATA payload bytes per block (P) at MTU 53 and MTU 23. */
export const PAYLOAD_BYTES_MAX = 48;
export const PAYLOAD_BYTES_MIN = 18;
/** Frames (L section) and H-section gyro samples per frame. */
export const H_SAMPLES_PER_FRAME = 4;
/** IMU timestamp: 25 µs per LSB, 24 bits. */
export const TIMESTAMP_US_PER_LSB = 25;
export const TIMESTAMP_WRAP = 1 << 24;
