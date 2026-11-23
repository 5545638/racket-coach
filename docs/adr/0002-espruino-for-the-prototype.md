# ADR 0002: Espruino JavaScript firmware for the prototype

**Status:** accepted for v0; revisit after bring-up

## Context

The user cannot solder, which excludes bare development boards. Puck.js v2 is a
finished nRF52832 device with the required IMU and runs Espruino.

## Decision

Write the firmware in ES5 for Espruino. Keep it small (detect, buffer, stream)
and test it on Node with fakes of the Espruino APIs.

## Consequences

- Programmable wirelessly from a browser, including from the iPhone.
- The interpreter limits the sample rate to roughly 100–200 Hz in practice;
  104 Hz is used.
- Not an industry-standard toolchain. If the product outgrows it, the firmware
  can be rewritten in C (Zephyr / nRF Connect SDK) without touching the app,
  because the wire protocol is versioned and specified independently.
