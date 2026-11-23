# ADR 0005: Coaching thresholds from literature, one cue per stroke

**Status:** accepted

## Context

Feedback needs reference values. Options: learn them from the player's own good
strokes, or take them from biomechanics literature.

## Decision

Start with published values widened by a tolerance band (docs/metrics.md),
stored as data with a source per rule. Speak only the highest-priority fault.

## Consequences

- Works from the first session, no labelling needed.
- Published values describe skilled players and specific strokes (mostly
  topspin forehands); backhand thresholds currently reuse forehand values.
- Rules without a reference are marked `heuristic` and must be tuned with data.
- A later version can personalise thresholds from the player's own
  distribution without changing the rule engine.
