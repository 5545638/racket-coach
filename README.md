# Racket Coach

Real-time tennis stroke feedback from a motion sensor in the racket's butt cap.
After each stroke you hear one short correction — _"Face too open"_,
_"Swing low to high"_, _"Finish your swing"_ — in your earphones.

[![CI](https://github.com/5545638/racket-coach/actions/workflows/ci.yml/badge.svg)](https://github.com/5545638/racket-coach/actions/workflows/ci.yml)

> **Status: v0.1, pre-hardware.** The full pipeline runs end-to-end against a
> physics-based simulator and a host harness of the real firmware. Thresholds
> come from published biomechanics and still need validation with recorded
> strokes. See [docs/bring-up.md](docs/bring-up.md).

## How it works

```
 Puck.js in the butt cap ──BLE──▶ Web app on the phone ──speech──▶ earphones
 (detect swing, stream raw IMU)    (attitude, metrics, rules)
```

| Part | Path | What it is |
| --- | --- | --- |
| Firmware | [`firmware/puck`](firmware/puck) | Espruino JavaScript for Puck.js v2: swing trigger, 1.2 s pre-trigger ring buffer, streaming over a custom GATT service |
| App | [`app`](app) | TypeScript + Preact web app served from GitHub Pages; runs in the Bluefy browser on iPhone |
| Mount | [`hardware/buttcap`](hardware/buttcap) | Parametric replacement butt cap carrying the Puck PCB (recommended); [`hardware/clip`](hardware/clip) is a string-bed clamp alternative |
| Docs | [`docs`](docs) | [Architecture](docs/architecture.md), [BLE protocol](docs/ble-protocol.md), [metrics & sources](docs/metrics.md), [ADRs](docs/adr) |

### Metrics per stroke

Stroke type (forehand / backhand / overhead, full / compact) and, per phase:

- **Preparation:** preparation time, take-back size, pause before the swing,
  racket drop and the face at the bottom of it.
- **Contact:** racket speed, **face angle**, **swing path**, timing of peak
  speed and of peak acceleration, how fast the face is closing.
- **Finish:** follow-through arc.

Every cue comes with an explanation, a fix and a drill (Estonian or English),
and each session ends with one focus for next time. Definitions, models and
limitations: [docs/metrics.md](docs/metrics.md).

## Try it without hardware

Open the app and press **Demo**. A simulated sensor speaks the real wire
protocol, so calibration, analysis and feedback run exactly as with a racket.

## Development

```sh
cd app
npm ci
npm run dev        # local dev server
npm run check      # typecheck + lint + format + tests
npm run coverage
```

```sh
cd hardware/buttcap
pip install -r requirements.txt
pytest -q
python buttcap.py --fit-test   # racket side only, to check the fit
python buttcap.py              # writes out/buttcap-puck.3mf
```

Every push runs CI; pushes to `main` deploy the app to GitHub Pages.

### Design principles

- **Dumb sensor, smart phone.** The firmware only records and streams; all
  analysis is in pure, unit-tested TypeScript and can be re-run on stored raw
  data when the algorithms improve ([ADR 0001](docs/adr/0001-dumb-sensor-smart-phone.md)).
- **Hardware-independent.** The app talks to a `SensorTransport` interface;
  Web Bluetooth, the simulator and tests are interchangeable.
- **Honest numbers.** Angles that need an attitude estimate are reported as
  unavailable rather than guessed; clipped gyro data marks speed as a lower
  bound; every threshold names its source.
- **Private.** No server. Data stays on the phone unless you export it.

## License

[MIT](LICENSE)
