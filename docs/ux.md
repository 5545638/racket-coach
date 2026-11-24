# UX review and redesign brief (2026-11-24)

Screens were captured from the demo at 390 × 844 (iPhone 14) in Estonian.

## Keep

- Dark, high-contrast theme and the colour tokens in `ui/styles.css`
  (green = good, amber = correction), bottom tab bar, safe-area handling.
- One big headline per stroke (stroke type + verdict) with `aria-live` only there.
- Why / Change / Drill blocks for a correction, focus card, face gauge.
- Profile tab (typical stroke, weaknesses, plan), export, diagnostics.

## Replace or fix

| Where | Problem | Change |
|---|---|---|
| Training (Löök) | 17 metric cards with ±σ and "Võrdlust veel pole…" under each: unreadable during play | Training view shows only what a player can use between balls; measurements move to a collapsed "Detailid" section |
| Training | No mode, no session statistics, battery only as "87%" | Status bar with connection dot, battery icon, mode chip, mute; stats strip (strokes per type, last speed, good share) |
| Training | No way to silence speech quickly in a rally | Large mute / "rally" toggle in the status bar; no other interaction needed per stroke |
| Session (Trenn) | Category counts are per element ("Hindamata 99" after 9 strokes) | Count strokes, not elements |
| Session | Feedback list with many "0×" rows | Hide zero rows |
| Session | No speed, consistency, strengths, in-session improvement or next focus summary | Full training report (below) |
| Speech | `say()` cancels the running phrase; no queue, no frequency control, one voice | Priority queue without overlap, configurable frequency, voice profiles, Estonian cues where an Estonian voice exists |
| History | Only weakness sparklines | Multi-session charts: strokes, speed, consistency, fault rate per focus |

## Training screen (top to bottom)

1. Status bar: connection dot + name, battery icon with %, mode chip
   (Õppimine / Treening / Mäng), mute toggle.
2. Stroke card (large): stroke type, verdict colour (good / correction /
   uncertain / not rated), the primary correction title in ≥ 32 px, spoken cue
   below it, "Better"/"Good" feedback in green.
3. Focus line: current focus + confidence, small.
4. Session strip: FH / BH / Serve counts, last and average speed, good share.
5. "Detailid" (collapsed by default): face gauge, measurement groups.

Learning mode expands Why / Change / Drill automatically; match mode shows only
the status bar, the counter and the last spoken persistent fault.

## Session report

Totals (all, forehand, backhand, serve), average estimated speed per stroke
type (marked as an estimate), consistency (spread of path, face and speed versus
the measurement noise floor, as a 0–100 score with its basis shown), strengths
(elements in band most often), most frequent errors, improvement within the
session (first vs second half), main focus for the next session (from the plan).

## History

Inline SVG charts, no chart library, readable at 375 px: strokes per session,
average speed per stroke type, consistency per session, fault rate of the top
weaknesses per session. Each chart has an `aria-label` with its numbers.
