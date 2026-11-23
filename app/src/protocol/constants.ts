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
