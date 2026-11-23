# ADR 0001: Dumb sensor, smart phone

**Status:** accepted

## Context

Analysis could run on the sensor (send only metrics) or on the phone (send raw
samples). The sensor runs an interpreter on a 64 MHz Cortex-M4 from a coin cell;
the analysis is the part most likely to change.

## Decision

The firmware detects swings, buffers and streams raw samples. All analysis is
in the app. Raw captures are stored next to their metrics.

## Consequences

- Algorithms change without reflashing; every stored stroke can be re-analysed.
- Real recorded data becomes test fixtures directly.
- ~2 kB per stroke over BLE (≈ 1 s per stroke at the measured rate); latency is
  hidden by streaming while the swing is still being recorded.
- Higher radio power use than sending metrics only (see bring-up §5).
