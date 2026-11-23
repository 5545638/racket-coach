# Butt cap for Puck.js (recommended mount)

Replaces the stock butt cap. The racket side copies the stock Wilson Blade cap
(flange plus octagonal collar with a snap ridge), so it mounts like the
original; the outside carries a cup for the bare Puck.js PCB.

![Preview](buttcap-preview.png)

| | |
| --- | --- |
| Footprint | 34 × 35 mm: the cup (31.8 mm) never extends past the flange or the grip |
| Added length | ≈ 12 mm |
| Mass | ≈ 5 g printed + 7 g PCB with coin cell |
| Material | PETG, 100 % infill, printed as exported (no supports) |

Why here and not on the strings: no change to string-bed feel, much smaller
impact shocks for the coin cell, a mount as strong as the original cap, and a
balance shift towards the handle rather than the head. The trade-off is that
contact location on the string bed cannot be estimated from the handle.

## Workflow

1. Print `--fit-test` (racket side only, ~10 min). Check it seats in the handle
   like the stock cap: tight, no wobble.
2. Adjust parameters if needed and print the full cap:

```sh
pip install -r requirements.txt
python buttcap.py --fit-test --collar-clearance 0.1   # looser collar
python buttcap.py --collar-width 27.2 --collar-length 28.1
pytest -q
```

3. Snap the Puck PCB (coin cell towards the racket) into the cup past the
   fingers, fit the cap, and fix it like the original (the stock staples, or
   re-wrap the grip over the flange).
4. Re-run calibration in the app.

Default dimensions were read from photos of a Wilson Blade cap against a ruler
(±0.5 mm). Other racket models need their own measurements; every dimension is
a parameter in `ButtCapParams`.
