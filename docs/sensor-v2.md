# Sensor firmware and protocol v2

Status: design, 2026-11-24. Nothing here has been measured on hardware yet.
Tags: [V] verified in Espruino source or the ST datasheet/AN5130,
[E] engineering estimate, [U] unknown until the bench tests below run.

## Decision

Run the gyro at 416 Hz and the accelerometer at 104 Hz through the IMU FIFO,
read in bursts by polling from JS, and store-and-forward a **hybrid capture**:
104 Hz for all six axes over the whole window (L section) plus raw 416 Hz gyro
for ±150 ms around peak racket rate (H section). Fallback mode M104 uses the
same FIFO path at 104 Hz only. The choice is gated by bench test T1 (software
I2C byte time); if it is worse than ~0.15 ms/byte, ship M104.

Why not simply "higher": 208 Hz folds the 146 Hz frame mode into the gyro
passband (BW 67 Hz); 833 Hz exceeds the bit-banged I2C budget, RAM and BLE;
a higher rate does not fix accel saturation or gyro clipping. 104 Hz is enough
for swing kinematics (< 20 Hz) but smears the impact and adds ~10 ms delay.

## Hardware facts

- `Puck.accelOn` rates: 1.6, 12.5, 26, 52, 104, 208, 416, 833, 1660 Hz; JS
  cannot read every sample above 208 Hz because Espruino reads one sample per
  idle pass (jswrap_puck.c ~997, ~1840) [V].
- `accelOn` writes CTRL6_C=0x10, CTRL7_G=0x80 (high-performance OFF),
  CTRL3_C=0x44, INT1_CTRL=0x03 [V]. v1 then writes CTRL1_XL=0x44, which clears
  LPF1_BW_SEL: the accel runs at 740 Hz bandwidth sampled at 104 Hz with no
  anti-alias filter (v1 bug).
- `Puck.accelWr(reg, byte)`; `Puck.accelRd(reg, cnt)` is a true burst read
  returning a Uint8Array (undefined if cnt exceeds free stack − 500) [V].
- The IMU is always powered; without `accelOn`, Espruino never reads it or
  emits `accel` events, so JS owns the IMU [V, confirm in T2].
- Timestamp: TIMESTAMP0..2 (0x40–0x42), 24 bit, 25 µs/LSB with
  WAKE_UP_DUR.TIMER_HR=1, enabled by CTRL10_C.TIMER_EN, wraps after ~419 s [V].
  Read once per poll rather than putting it in the FIFO.
- `E.getTemperature()` blocks ~50 ms [V]; use IMU OUT_TEMP (0x20/0x21,
  256 LSB/°C, 0 = 25 °C, ±15 °C absolute) for relative bias tracking.
- BLE: build MTU 53 → 50-byte notifications if the central asks for it; the
  peripheral cannot read the MTU from JS, so probe with a 50-byte PROBE [V].
  Queue-full is ignored silently (no exception, no TX-complete event) [V].
  Up to 6 packets per connection event on nRF52 [V]; iOS interval 15–30 ms
  [E]. Realistic 1.6–3.2 kB/s, up to ~9.6 kB/s [E].

| LSM6DS3TR-C | Value |
|---|---|
| Gyro FS | ±2000 dps max, 70 mdps/LSB [V]; clip point 28571 vs 32767 counts [U, T7] |
| Gyro noise | 5 mdps/√Hz (HP) [V] |
| Gyro bias | ±3 dps, ±0.05 dps/°C [V] |
| Accel | ±16 g max, 0.488 mg/LSB, 130 µg/√Hz HP, ±40 mg offset [V] |
| Gyro BW / phase at 20 Hz (AN5130 Tab. 11) | 104 Hz: 33 Hz, 75°; 208: 67 Hz, 40°; 416: 137 Hz, 23° [V] |

## Feasibility

| | 104 Hz | 208 Hz | 416 Hz | 833 Hz |
|---|---|---|---|---|
| IMU current | 0.36–0.90 mA | 0.45–0.90 | 0.90 | 0.90 |
| I2C time (12 B/sample) | 12 % | 25 % | 50 % (31 % hybrid) | ~100 % ✗ |
| JS per-sample events | 16–26 % | 31–52 % | ✗ | ✗ |
| JS with FIFO chunks | 3–8 % | 3–8 % | 3–8 % | 3–8 % |
| RAM, 2.2 s | 2.7 kB | 5.5 kB | 11 kB (6.9 hybrid) | 22 kB |
| BLE per capture at 3.2 kB/s | 0.9 s | 1.7 s | 3.4 s; hybrid 1.1 s | 6.9 s |
| Rotation/sample at 30 rad/s | 16.5° | 8.3° | 4.1° | 2.1° |
| 146 Hz frame mode | filtered | aliases to 62 Hz | resolved | resolved |

All [E] except rates/currents/BW [V].

## Register settings (no `Puck.accelOn`)

| Reg | M416 | M104 | Meaning |
|---|---|---|---|
| 0x0A FIFO_CTRL5 | 0x00 first | 0x00 first | bypass, clears FIFO |
| 0x12 CTRL3_C | 0x44 | 0x44 | BDU, IF_INC |
| 0x0D INT1_CTRL | 0x00 | 0x00 | no interrupts |
| 0x13 CTRL4_C | 0x00 | 0x00 | gyro LPF1 off |
| 0x15 CTRL6_C | 0x00 | 0x00 | accel high-performance |
| 0x16 CTRL7_G | 0x00 | 0x00 | gyro high-performance, HPF off |
| 0x17 CTRL8_XL | 0xC0 | 0x00 | accel LPF2 ODR/9 (46 Hz) / none |
| 0x10 CTRL1_XL | 0x64 | 0x46 | 416 Hz ±16 g / 104 Hz ±16 g ODR/4 |
| 0x11 CTRL2_G | 0x6C | 0x4C | ±2000 dps at 416 / 104 Hz |
| 0x5C WAKE_UP_DUR | 0x10 | 0x10 | TIMER_HR 25 µs |
| 0x19 CTRL10_C | 0x20 (0x24 if needed [U]) | same | TIMER_EN |
| 0x06/0x07/0x09 | 0x00 | 0x00 | no threshold, no 4th set |
| 0x08 FIFO_CTRL3 | 0x0C | 0x09 | gyro ÷1, accel ÷4 / both ÷1 |
| 0x0A FIFO_CTRL5 (after 100 ms) | 0x36 | 0x26 | FIFO ODR, continuous |

Off: 0x0A, 0x10, 0x11 ← 0. M416 frame = 15 words (30 B) per 9.6 ms in the
order G0, A0, G1, G2, G3 [E, verify FIFO_PATTERN in T2]. M104 frame = 6 words
(12 B): G, A. FIFO is 4096 B: 1.31 s in M416, 3.3 s in M104.

## Firmware structure

- `poll()` every 30 ms: read FIFO_STATUS1..4 (0x3A, 4 B); words =
  s0 | (s1&7)<<8; pattern = s2 | (s3&3)<<8. On OVER_RUN (s1&0x40) or a
  misaligned pattern: reset the FIFO, `overruns++`, invalidate ring and active
  capture. n = min(floor(words/frameWords), 8); burst-read n frames from 0x3E;
  copy into the ring with `ring.set()`; read the timestamp (0x40, 3 B) and keep
  (timestamp, frames produced) snapshots ≥ 2 s apart for the frame period.
  Per frame only ‖ω‖² of G0 is computed in JS.
- Ring: preallocated Uint8Array of 237 frames + Int16Array view.
- State machine anchored on the peak: IDLE→ACTIVE when ‖ω‖ > 700 dps, track
  peak frame; CLOSE after 150 ms below 100 dps or at peak + 0.8 s; capture =
  last min(fill, 229) frames ending at close.
- `extract()` (synchronous, FIFO absorbs the time) builds an immutable outbox:
  L = N × 12 B (ax, ay, az, mean gx, gy, gz over the frame's gyro samples), H =
  Nh × 24 B raw gyro for frames peak−15 … peak+15. CRC32 over the stream;
  OUT_TEMP. Two outboxes; if both busy, drop the capture and count it.
- `tx()` on a timer sends `blocksPerTick` blocks per `tickMs`; block k is a
  zero-copy view of the outbox. Every handler in try/catch with an error
  counter; all buffers allocated once at boot.

## Protocol v2 (little-endian)

The app opts in with HELLO. Without it the firmware emits v1 Begin/Sample/End
from the L section (paced), so old apps keep working.

App → sensor (write without response):

| Code | Message | Bytes |
|---|---|---|
| 0x10 | HELLO | protoMax, probeLenReceived (0 first; sensor answers PROBE + STATUS2; app resends with the received length) |
| 0x11 | ACK | capId, nextBlock, credit (cumulative; never send beyond nextBlock + credit − 1; default credit 24; app ACKs every 8 blocks or 100 ms) |
| 0x12 | NAK | capId, n, idx × n (n ≤ 16; 0xFE = resend headers) |
| 0x13 | DONE | capId, status (frees the outbox; also freed after 5 s without ACK or 3 NAK rounds → dropped++) |
| 0x14 | PACING | blocksPerTick, tickMs (default 2, 30) |
| 0x15 | MODE | 0 = M104, 1 = M416 |
| 0x20 | BENCH | test, param u16 |

Sensor → app (v1 types 0x01–0x03 and 0x10 unchanged):

| Code | Message | Layout |
|---|---|---|
| 0x18 | STATUS2 (18 B) | type, proto, batt %, fw×3, mode, P, flags, tempIMU i16, fifoOverruns u16, droppedCaptures u16, freeVars u16, errors u8 |
| 0x19 | PROBE (50 B) | type, bytes 1..49 |
| 0x20 | BEGIN_A (20 B) | type, capId, kind, mode, nFrames u16, hStart u16, hFrames u16, peakFrame u16, P u8, nBlocks u8, streamLen u16, crc32 u32 |
| 0x21 | BEGIN_B (18 B) | type, capId, framePeriod_ns u32, tsLast u32 (25 µs, 24 bits), accel µg/LSB u16, gyro mdps/LSB u16, tempIMU i16, filterCfg u8, flags u8 (b0 short pre-history, b1 gyro clipped, b2 accel clipped, b3 FIFO reset inside capture) |
| 0x30 \| (capId & 15) | DATA | byte 1 = blockIdx, then ≤ P stream bytes (P = 48, or 18 at MTU 23) |
| 0x22 | END | capId, nBlocks (repeated after each NAK round) |
| 0x28 | BENCH_RESULT | test, part, 17 B |

Timing: frame f is at tsLast − (N−1−f)·framePeriod; H sub-sample k is at +k/4
frame; the L gyro mean is centred at +0.375 frame (M416).

## Bench tests (firmware command BENCH)

| Test | Reports |
|---|---|
| T1 | µs for accelRd(0x3E, 30/120/240) and accelWr — gates 416 Hz |
| T2 | FIFO_PATTERN order, burst wrap, accelWr without accelOn |
| T3 | Achieved ODR per mode from IMU timestamps vs getTime() over 4 s |
| T4 | 60 s: max FIFO fill, overruns, poll() min/mean/max, max poll gap |
| T5 | 200 numbered blocks at 1..6 per tick: loss, bytes/s, PROBE length, indications |
| T6 | process.memory() with all buffers, extract() duration |
| T7 | Max |raw| per axis since reset (clip point 32767 vs 28571) |
| T8 | Current per mode (external meter), CR2032 sag under TX |
| T9 | Spectrum of a 416 Hz impact: is the 146 Hz mode visible at the butt cap? |

## v1 defects fixed by this design

1. Queue-full never throws, so the v1 retry is dead code and captures get gaps.
2. Long JS (pump loop, 750-element copy, 50 ms temperature read) silently
   drops IMU samples; indices hide it.
3. Window anchored to the first 300 dps crossing + 1.0 s truncates slow swings.
4. No second buffer; swings during a send are lost without a counter.
5. Accel aliasing (no anti-alias filter).
6. `appReady` does not prove CCCD subscription; MTU fixed at 20.

## App side

Implemented in the app (analysis version 6; details and simulation results
in docs/metrics.md, "v2 captures"):

- **Assembly**: `protocol/assemblerV2.ts` turns BEGIN_A/B + DATA into a
  `RawCapture` with L (`samples`), H (`gyroHr`), frame times (`sampleTimesUs`,
  unwrapped µs, derived from tsLast and framePeriod_ns), `framePeriodNs`,
  `flags`, `temperatureRaw`/`temperatureC`, `accelUgPerLsb`/`gyroMdpsPerLsb`,
  `filter` (filterCfg), `mode`. The capture is stored and exported verbatim.
- **Sensitivities → ranges**: 70 mdps/LSB → ±2000 dps, 488 µg/LSB → ±16 g
  (and the other integer datasheet values); an unknown value rejects the
  capture.
- **Flags**: b3 + b0 → data lost before the first frame (the first sample is a
  gap); b3 alone → unlocated loss (nothing rated); b1 → M416 frame means
  ≥ 0.9 × clip level, and frames whose raw H samples clipped, are treated as
  clipped (the mean can hide a clipped sub-sample); b1/b2 that the samples
  cannot locate → every sample suspect.
- **M416**: the analysis runs on a 416.7 Hz splice: A0 interpolated linearly,
  frame means as samples at f + 0.375 interpolated by a cubic, the raw H gyro
  at its exact times. Contact onset uses accelerometer jumps between frames
  only and is refined to the sub-sample with the raw gyro. In simulation the
  splice matches the true 416 Hz samples within 0.1° / 0.2 ms; M104 is up to
  4° and 7 ms off. Analysing only the frame means (no splice) is worse than
  M104, because the frame containing the impact averages in the post-impact
  rate.
- **Temperature**: stored with the calibration; > 10 °C from it → quality
  warning and a hint in Setup to recalibrate. The per-capture gyro bias
  re-estimation removes most of the drift anyway.
- **Not yet used**: `filterCfg` (provenance only), STATUS2 counters other than
  temperature (diagnostics display only).
