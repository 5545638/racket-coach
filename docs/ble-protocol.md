# BLE protocol (versions 1 and 2)

Version 1 is described first and is what firmware 0.1 speaks. Firmware 0.2
speaks both: it stays on v1 until the app opts in to [version 2](#version-2)
with HELLO, so apps that know only v1 keep working.

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

Firmware 0.2 (both protocol versions) captures differently: a swing opens at
‖ω‖ > 700 °/s, the peak is tracked, and the capture closes 150 ms after the
rate fell below 100 °/s or 0.8 s after the peak; the window is the last 2.2 s
(229 frames) up to the close, or less when the history is shorter (after
connecting, a mode change or a FIFO reset). Two outboxes hold captures while
they are sent, so a swing during a send is kept; see
[Version 2](#version-2).

## Reliability

Notifications are acknowledged at the link layer, but the sensor's TX queue can
overflow, and Espruino drops a notification into a full queue **silently** (no
exception, no event). Firmware 0.1 tried to retry on an exception that never
comes. Firmware 0.2 paces v1 output (4 packets per 30 ms, not yet measured on
hardware) and cannot recover a dropped packet in v1. The app rejects a capture
on any index gap, count mismatch or CRC mismatch, and resynchronises at the
next CaptureBegin; if the dropped packet was the CaptureEnd, the app learns of
the loss only then.

With firmware 0.2 and no HELLO, v1 captures are built from the L section of
the v2 capture (below): the 2.2 s window is anchored on the peak rate, and the
trigger index is the start of the > 300 °/s run that contains the peak.

## Versioning

Any incompatible change bumps the protocol version. The app rejects captures
with an unknown version and shows the firmware's version in Setup. Version 2
is negotiated (HELLO), not assumed, so v1 apps and v1 firmware keep working
with the other side's newer version.


## Version 2

Design and the reasons behind it: [sensor-v2.md](sensor-v2.md). Code:
`app/src/protocol/messagesV2.ts`, `assemblerV2.ts`, `link.ts`,
`firmware/puck/src/main.js`. **Nothing of v2 has run on hardware yet**; it is
verified against the host harness (`app/test/firmware`), which models the
LSM6DS3TR-C registers and FIFO and a BLE link that drops silently.

### Negotiation

1. Right after enabling notifications the app writes HELLO(protoMax 2,
   probeLen 0), without response, and repeats it once after 250 ms.
2. v2 firmware answers with PROBE (50 bytes; the link truncates it to MTU − 3,
   because the peripheral cannot read the MTU from JS) and STATUS2.
3. The app writes HELLO(2, received PROBE length). The sensor sets the DATA
   payload P = clamp(length − 2, 18, 48) (48 at MTU 53, 18 at MTU 23) and
   answers with STATUS2. Until then P = 18.
4. No PROBE/STATUS2 within 500 ms: the app treats the sensor as v1 and writes
   HELLO(protoMax 1), which tells v2 firmware to stay on v1 (v1 firmware
   ignores it). The app then uses the v1 messages above.

The app's v1 commands (RequestStatus, CaptureStatic) keep working in v2;
RequestStatus is answered with Status and, in v2, also STATUS2. A static
capture arrives as a v2 capture of kind static (104 frames, no H section).

### Capture stream

A capture is frozen into one of two outboxes as a byte **stream**:

- L section, N frames × 12 bytes: ax, ay, az, gx, gy, gz (i16, the v1 sample
  layout). In M416 the gyro values are the mean of the frame's four 416 Hz
  samples, `(g0 + g1 + g2 + g3 + 2) >> 2`.
- H section (M416 swings only), hFrames × 24 bytes: g0 x y z, g1 x y z,
  g2 x y z, g3 x y z for frames hStart … hStart + hFrames − 1 (peak ± 15).

The stream is cut into blocks of P bytes (the last may be shorter). CRC-32
(ISO-HDLC, as v1) covers the whole stream.

Timing: frame f is at `tsLast − (N − 1 − f) · framePeriod`; H sub-sample k at
+k/4 frame; the L gyro mean is centred at +0.375 frame. `tsLast` is the IMU
timestamp (24 bit, 25 µs) estimated from the poll in which the capture closed:
± half a frame absolute [E]; relative frame times are exact. The app unwraps
the 24-bit timer across captures (a wrap is assumed whenever tsLast decreases;
more than one wrap between two captures, i.e. > 419 s apart, is not
detectable, which shifts absolute device time but not times within a capture).
`framePeriod` is measured against the IMU timer over ≥ 2 s (nominal 9.6 ms =
1 / (6666.7 Hz / 64)); `sampleRateHz` in the app stays the nominal 104.

### Messages, sensor → app

| Code | Message | Bytes | Layout |
| --- | --- | --- | --- |
| `0x18` | STATUS2 | 18 | type, proto u8, battery %, fw major, minor, patch, mode u8, P u8, flags u8 (b0 IMU running, b1 outbox A busy, b2 outbox B busy, b3 v2 active), tempIMU i16, fifoOverruns u16, droppedCaptures u16, freeVars u16, errors u8 |
| `0x19` | PROBE | 50 | type, bytes 1 … 49 (truncated by the link) |
| `0x20` | BEGIN_A | 20 | type, capId u8, kind u8, mode u8, nFrames u16, hStart u16, hFrames u16, peakFrame u16, P u8, nBlocks u8, streamLen u16, crc32 u32 |
| `0x21` | BEGIN_B | 18 | type, capId u8, framePeriod_ns u32, tsLast u32 (25 µs, 24 bits used), accel µg/LSB u16, gyro mdps/LSB u16, tempIMU i16, filterCfg u8, flags u8 |
| `0x30 \| (capId & 15)` | DATA | 2 + ≤ P | type, blockIdx u8, stream bytes |
| `0x22` | END | 3 | type, capId u8, nBlocks u8 (repeated after every NAK round) |
| `0x28` | BENCH_RESULT | 20 | type, test u8, part u8, 17 payload bytes (below) |

tempIMU is OUT_TEMP: 256 LSB/°C, 0 = 25 °C, ±15 °C absolute; good for relative
bias tracking. filterCfg: 1 = accelerometer LPF1 at ODR/4 (M104), 2 = LPF2 at
ODR/9 (M416). BEGIN_B flags: b0 short pre-history (fewer than 229 frames),
b1 gyro clipped (any raw sample ≥ 28000 counts), b2 accelerometer clipped
(≥ 32703), b3 the window was cut short by a FIFO reset (overrun).

### Commands, app → sensor (write without response)

| Code | Command | Bytes |
| --- | --- | --- |
| `0x10` | HELLO | protoMax u8, probeLenReceived u8 |
| `0x11` | ACK | capId, nextBlock (cumulative: every block below it arrived), credit |
| `0x12` | NAK | capId, n (≤ 16), n × block index (`0xFE` = resend BEGIN_A and BEGIN_B) |
| `0x13` | DONE | capId, status (0 ok, 1 CRC mismatch, 2 abandoned) |
| `0x14` | PACING | blocksPerTick (1–6, default 2), tickMs (10–200, default 30) |
| `0x15` | MODE | 0 = M104 (default), 1 = M416 (experimental) |
| `0x20` | BENCH | test u8, param u16 |

The sensor matches ACK/NAK/DONE to an outbox by the low four bits of capId,
like DATA, so the app can NAK headers of a capture it knows only from DATA.

### Flow control

- **Sensor.** Each tick (tickMs) sends up to blocksPerTick packets of the
  oldest busy outbox: missing headers, then NAKed blocks, then new blocks,
  never a block beyond `nextBlock + credit − 1` of the latest ACK (credit 24
  before the first ACK), then END once everything was sent and no resend is
  pending. DONE frees the outbox. It is also freed, and counted in
  droppedCaptures, after 5 s without ACK or NAK, or after 6 END rounds in a
  row whose NAKs show no progress (cumulative ACK not advanced and no fewer
  blocks NAKed than in the previous round), or after 20 END rounds.
  *Deviation from sensor-v2.md (3 rounds):* with 30 % random loss in the
  harness, 3 rounds dropped 4 of 120 captures (one block lost three times in a
  row), 6 dropped none.
- **Two outboxes.** A swing that closes while one outbox is sending goes into
  the other; one that closes while both are busy is dropped and counted.
- **App.** Collects blocks per capture in a bitmap; ACKs every 8 new blocks and
  every 100 ms while a capture is open; NAKs holes below the highest received
  block (BLE is ordered, so they are lost) at most every 300 ms per block;
  after 300 ms without packets also NAKs the rest of the credit window and
  missing headers; on END NAKs everything still missing. Complete: CRC check,
  ACK(nBlocks) and DONE. A capture with no packet for 5 s is abandoned
  (DONE 2). A repeated END of a completed capture is answered with DONE again.

### Bench results

Each test answers with BENCH_RESULT parts; offsets below are into the 17-byte
payload, little-endian. T8 (current) and T9 (impact spectrum) need external
equipment or app-side analysis and are answered with part `0xFE`, as are
unknown tests. The procedure is in [bring-up.md](bring-up.md#6-bench-tests-t1t9).

| Test | param | Payload (part 0 unless noted) |
| --- | --- | --- |
| T1 | repetitions (10) | u32 µs per `accelRd(0x3E, 30)` @0, `…120)` @4, `…240)` @8, per `accelWr` @12; u8 repetitions @16 |
| T2 | – | WHO_AM_I @0, CTRL1_XL @1, CTRL2_G @2, mode @3, u16 FIFO words after 200 ms @4, u8 pattern ok @6 (FIFO_PATTERN read 0, 1, 2 … word by word), u16 words before @7 and after @9 a one-frame burst (difference = frame words if the burst wraps 0x3F → 0x3E), u8 frame words @11 |
| T3 | seconds (4) | u32 frame rate in mHz by getTime() @0 and by the IMU timer @4, i32 IMU timer vs getTime() in ppm @8, mode @12, u16 frames @13 |
| T4 | seconds (60) | u16 max FIFO words @0, u16 overruns @2, u16 poll() min @4 / mean @6 / max @8 µs, u16 max gap between polls in ms @10, u32 polls @12 |
| T5 | packets per tick (2) | parts 0 … 199: u16 sequence @0; part `0xFF`: u16 sent @0, u32 duration ms @2, P @6, per tick @7, tick ms @8, PROBE length the app reported @9. The app counts the losses. |
| T6 | – | `process.memory()`: u16 free @0, usage @2, total @4; u32 µs for one extract() of the current ring @6; u16 frames @10 |
| T7 | 1 = reset after reporting | u16 max \|raw\| over captures since reset: ax @0, ay @2, az @4, gx @6, gy @8, gz @10 |

T1 and T2 pause poll() and reset the FIFO afterwards (a swing in progress is
lost). T6 runs extract() into a free outbox and discards it.
