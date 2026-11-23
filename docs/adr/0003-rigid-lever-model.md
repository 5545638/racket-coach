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

## Consequences

- Swing-path **direction** is independent of L; speed scales linearly with L.
- Wrist and elbow rotations that move the centre of rotation introduce error;
  quantified during bring-up (§4). A data-driven correction may replace the
  model once labelled data exists.
- No dependency on the saturated accelerometer during the swing.
