# ADR 0003: Racket velocity from a rigid-lever model, not from integration

**Status:** accepted; to be validated with video

## Context

Swing path and racket speed need the sweet-spot velocity at contact. Integrating
acceleration is the textbook approach, but the accelerometer saturates at ±16 g
for most of a full swing (centripetal acceleration ≈ ω²r ≈ 50 g), so the
integral is unusable.

## Decision

Model the racket as the end of a rigid lever rotating about a centre on the
extension of its long axis: v = ω × (L x̂). Use the measured ω and the
calibrated axis x̂; L is a user setting.

**Default L = 0.72 m** (changed from 1.0 m). This is the effective radius
TennisEye used for a handle-mounted IMU: ≈ 0.2 m from the butt to the centre
of rotation (Brody, as cited by TennisEye; Mitchell et al. 2001 measured the
serve's instantaneous centre 12.6 cm behind and 18 cm below the butt) plus
0.52 m from the butt to the face centre (docs/research/racket-dynamics.md
§5). It is the best-supported value found, not a validated one: TennisEye
validated ball speed, not racket speed, and no forehand-specific radius was
found. Settings stored with exactly the old default (1.0 m) are migrated to
0.72 m on load; any other stored value is kept.

## Consequences

- Swing-path **direction** is independent of L; speed scales linearly with L.
- Speed is a model estimate. It is meant for a player's own trend, not for
  comparison with published or radar speeds; changing L rescales all speeds.
- Linear hand velocity is invisible to the model. In simulation, 3 m/s of
  upward hand velocity at contact leaves the measured path ≈ 6–7° flatter and
  the speed ≈ 6 % lower than the truth (`app/test/metrics/simulatorRealism.test.ts`).
- Wrist and elbow rotations that move the centre of rotation introduce error;
  quantified during bring-up (§4). A data-driven correction may replace the
  model once labelled data exists.
- No dependency on the accelerometer during the swing, which clips at ±16 g
  in fast swings even in the butt cap (ω²r at ≈ 0.2 m from the centre).
