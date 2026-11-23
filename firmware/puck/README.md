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

## Behaviour

| State | Power | Activity |
| --- | --- | --- |
| Not connected | IMU off, advertising | ~µA |
| Connected, idle | IMU on at 104 Hz | Ring buffer of the last 1.2 s |
| Swing | — | Candidate at ‖ω‖ > 300 °/s, confirmed at > 700 °/s; streams buffer + live samples; ends after 150 ms below 100 °/s (see [capture lifecycle](../../docs/ble-protocol.md#capture-lifecycle)) |

The green LED is on while a capture is being sent.

## Tests

`app/test/firmware` runs this file on Node with fakes of the Espruino APIs and
checks that its output is decoded bit-exactly by the app, including when the
BLE queue is congested. Run `npm test` in `app/`.

Protocol: [docs/ble-protocol.md](../../docs/ble-protocol.md).
