import type { Strings } from './strings';

const SIZE = 120;
const CENTRE = SIZE / 2;
const LENGTH = 46;
/** Literature target band for topspin groundstrokes, degrees (see docs/metrics.md). */
const TARGET: readonly [number, number] = [-20, -5];

/** End point of the racket face line for a face tilt, seen from the side with the target to the right. */
function end(tiltDeg: number, sign: 1 | -1): string {
  const rad = (tiltDeg * Math.PI) / 180;
  const x = CENTRE - sign * LENGTH * Math.sin(rad);
  const y = CENTRE - sign * LENGTH * Math.cos(rad);
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

/** Side view of the racket face at contact against the target band. */
export function FaceGauge({ tiltDeg, t }: { readonly tiltDeg: number; readonly t: Strings }) {
  const [lo, hi] = TARGET;
  const inTarget = tiltDeg >= lo && tiltDeg <= hi;
  const clamped = Math.max(-60, Math.min(60, tiltDeg));
  return (
    <figure class="gauge">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${t.faceGauge.label}: ${tiltDeg.toFixed(0)}°`}
      >
        <polygon class="gauge-target" points={`${CENTRE},${CENTRE} ${end(lo, 1)} ${end(hi, 1)}`} />
        <polygon
          class="gauge-target"
          points={`${CENTRE},${CENTRE} ${end(lo, -1)} ${end(hi, -1)}`}
        />
        <line class="gauge-axis" x1={CENTRE} y1={8} x2={CENTRE} y2={SIZE - 8} />
        <line
          class={inTarget ? 'gauge-face good' : 'gauge-face fix'}
          x1={end(clamped, 1).split(',')[0]}
          y1={end(clamped, 1).split(',')[1]}
          x2={end(clamped, -1).split(',')[0]}
          y2={end(clamped, -1).split(',')[1]}
        />
        <text class="gauge-label" x={4} y={14}>
          {t.faceGauge.open}
        </text>
        <text class="gauge-label" x={SIZE - 4} y={14} text-anchor="end">
          {t.faceGauge.closed}
        </text>
      </svg>
      <figcaption>{t.faceGauge.label}</figcaption>
    </figure>
  );
}
