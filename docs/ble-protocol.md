# BLE protocol (version 1)

Sensor → app traffic uses notifications on one characteristic; app → sensor
commands are writes to another. All integers are **little-endian**. Every
message fits a default 20-byte ATT payload, so no MTU negotiation is needed.

| | UUID |
| --- | --- |
| Service | `7a1c0000-5e2b-4d6f-9c3a-2b8e4f1d6a90` |
| Data (notify) | `7a1c0001-5e2b-4d6f-9c3a-2b8e4f1d6a90` |
| Control (write) | `7a1c0002-5e2b-4d6f-9c3a-2b8e4f1d6a90` |

The device advertises as `RacketCoach XXXX` (last four hex digits of its
address). The Nordic UART service stays enabled for reprogramming.

Source of truth in code: `app/src/protocol/constants.ts` and
`firmware/puck/src/main.js`; `app/test/firmware/firmware.test.ts` fails if they
diverge.

## Messages (sensor → app)

### `0x01` CaptureBegin — 12 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | type = 0x01 |
| 1 | u8 | protocol version (= 1) |
| 2 | u8 | capture sequence number (wraps at 256) |
| 3 | u8 | kind: 0 = swing, 1 = static (calibration) |
| 4 | u16 | sample rate, Hz |
| 6 | u16 | accelerometer sensitivity, µg/LSB |
| 8 | u16 | gyroscope sensitivity, mdps/LSB |
| 10 | u16 | trigger index: sample at which the swing trigger fired (0 for static) |

Sensitivities make captures self-describing: the app never assumes a sensor
model or range.

### `0x02` Sample — 16 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | type = 0x02 |
| 1 | u8 | capture sequence number |
| 2 | u16 | sample index within the capture, from 0 |
| 4 | 6 × i16 | ax, ay, az, gx, gy, gz (sensor frame, raw counts) |

### `0x03` CaptureEnd — 8 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | type = 0x03 |
| 1 | u8 | capture sequence number |
| 2 | u16 | number of samples sent |
| 4 | u32 | CRC-32/ISO-HDLC over all sample payloads (12 bytes each, in order) |

### `0x10` Status — 7 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | type = 0x10 |
| 1 | u8 | protocol version |
| 2 | u8 | battery, % |
| 3 | i8 | temperature, °C |
| 4–6 | 3 × u8 | firmware version major.minor.patch |

## Commands (app → sensor)

| Byte | Command | Effect |
| --- | --- | --- |
| `0x01` | RequestStatus | Sensor replies with a Status message |
| `0x02` | CaptureStatic | Sensor records 1 s and sends it as a `static` capture. Ignored while a capture is in progress |

## Capture lifecycle

1. Nothing is streamed until the app has written its first command (the app
   sends RequestStatus right after enabling notifications).
2. ‖ω‖ > 300 °/s opens a *candidate*. It is confirmed, and streaming starts,
   once ‖ω‖ exceeds 700 °/s; a candidate that goes quiet first (a waggle, a
   slow backswing) is dropped without sending anything.
3. The capture starts 1.2 s before the trigger (the ring buffer keeps running
   during captures, so back-to-back strokes keep their preparation phase) and
   ends after 150 ms below 100 °/s, or at 229 samples.
4. A new capture starts only after the previous one has been fully sent.

## Reliability

Notifications are acknowledged at the link layer, but the sensor's TX queue can
overflow. The firmware retries on a full queue; the app additionally rejects a
capture on any index gap, count mismatch or CRC mismatch, and resynchronises at
the next CaptureBegin.

## Versioning

Any incompatible change bumps the protocol version. The app rejects captures
with an unknown version and shows the firmware's version in Setup.
