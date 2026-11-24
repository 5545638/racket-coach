# Puck.js firmware

Target: Espruino **Puck.js v2 or v2.1** (nRF52832, LSM6DS3TR-C). Not v1 or
Puck.js Lite — they have no gyroscope.

## Install

1. Open <https://www.espruino.com/ide/> in Chrome on a computer, or in Bluefy on
   iPhone.
2. Connect to the Puck (it advertises as `Puck.js xxxx` before first upload).
3. In *Settings → Communications*, set **Save on Send** to
   **Direct to Flash (execute code at boot)**.
4. Paste `src/main.js` into the editor and press **Send to Espruino**.
5. Disconnect. The Puck now advertises as `RacketCoach xxxx`.

The Nordic UART service stays enabled, so the IDE can always reconnect and
replace the code.

## Behaviour (firmware 0.2)

Not yet run on hardware: verified only in the host harness (see Tests). Work
through [bring-up](../../docs/bring-up.md) before relying on it.

| State | Power | Activity |
| --- | --- | --- |
| Not connected | IMU powered down, advertising | ~µA |
| Connected | IMU in mode M104 (default) or M416 | FIFO read in bursts every 30 ms into a 2.3 s ring |
| Swing | — | Opens at ‖ω‖ > 700 °/s, tracks the peak, closes 150 ms below 100 °/s or 0.8 s after the peak; the last 2.2 s are frozen into one of two outboxes and sent |

The firmware programs the LSM6DS3TR-C registers itself (`Puck.accelWr` /
`Puck.accelRd`); it never calls `Puck.accelOn`, so Espruino does not read the
IMU behind its back. Register values and their meaning: comments in
`src/main.js` and [sensor-v2.md](../../docs/sensor-v2.md).

| Mode | Gyro | Accelerometer | FIFO frame | Capture |
| --- | --- | --- | --- | --- |
| M104 (default) | 104 Hz | 104 Hz, LPF1 ODR/4 | G, A (12 B) | L section only |
| M416 (experimental) | 416 Hz | 416 Hz, LPF2 ODR/9, FIFO ÷4 → 104 Hz | G0, A0, G1, G2, G3 (30 B) | L section + raw 416 Hz gyro for peak ± 15 frames |

**M416 stays opt-in** (the app's setting "Experimental: 416 Hz gyro", which
sends MODE 1) until bench test T1 shows that the bit-banged I2C keeps up; the
decision rule is in [bring-up](../../docs/bring-up.md#decision-rule-for-m416).

Protocol: an app that sends HELLO gets protocol v2 (store-and-forward with
ACK/NAK/DONE, credit-based flow control, CRC over the stream). An app that does
not (the current app before this version, or any v1 app) gets the v1 messages,
built from the same capture and paced at 4 packets per 30 ms. See
[ble-protocol.md](../../docs/ble-protocol.md).

Temperature comes from the IMU (`OUT_TEMP`); `E.getTemperature()` blocks for
~50 ms and is never called. Every handler runs in try/catch and counts errors
(STATUS2). All buffers are allocated once at boot. The green LED is on while a
capture is waiting to be sent or being sent.

## Bench tests

The firmware runs bench tests T1–T7 on request (BENCH command) and reports
them as BENCH_RESULT messages; from the app, call `racketCoach.runBench(test,
param)` in the browser console (results appear in Session → Diagnostics).
Procedure: [bring-up](../../docs/bring-up.md#6-bench-tests-t1t9).

## Tests

`app/test/firmware` runs this file on Node against a register-level model of
the LSM6DS3TR-C (FIFO with pattern and overrun, burst reads, timestamp, OUT_TEMP,
clipping), fake timers on a virtual clock, and a BLE model that drops
notifications silently when the TX queue is full or at a given loss rate. The
app's real protocol code receives the notifications and must reassemble
captures bit-exactly, in v1 and v2, at MTU 23 and 53, under loss, overrun and
outbox congestion. Run `npm test` in `app/`.

Model assumptions that only hardware can confirm (FIFO pattern order, burst
wrap 0x3F → 0x3E, timestamp reset by writing 0xAA, write without response on
the control characteristic, real TX-queue behaviour) are the subject of the
bench tests.
