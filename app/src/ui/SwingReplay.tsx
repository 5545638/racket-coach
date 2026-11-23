import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Vec3 } from '../math/vec3';
import type { SwingTrace } from '../metrics/analyzeSwing';
import type { Strings } from './strings';
import { type Point, project, racketShape, tipPath } from './swingGeometry';

const SCALE = 190; // px per metre
const WIDTH = 320;
const HEIGHT = 300;
const CHART_HEIGHT = 70;
const PLAYBACK_RATE = 0.25;
const DEFAULT_AZIMUTH = (40 * Math.PI) / 180;
/** Frames shown after contact; the rest of the follow-through adds clutter, not information. */
const AFTER_CONTACT_S = 0.15;
const GHOST_EVERY = 3;

const px = (p: Point): string =>
  `${(WIDTH / 2 + p.x * SCALE).toFixed(1)},${(HEIGHT / 2 - p.z * SCALE).toFixed(1)}`;
const points = (ps: readonly Point[]): string => ps.map(px).join(' ');

function Racket(props: {
  readonly trace: SwingTrace;
  readonly frame: number;
  readonly azimuth: number;
  readonly class: string;
}) {
  const shape = racketShape(props.trace, props.frame);
  const at = (p: Vec3): Point => project(p, props.azimuth);
  const [x1, y1] = px(at(shape.butt)).split(',');
  const [x2, y2] = px(at(shape.throat)).split(',');
  return (
    <g class={props.class}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <polygon points={points(shape.head.map(at))} />
    </g>
  );
}

/**
 * Slow-motion replay of the racket's measured orientation through one stroke,
 * with the racket-speed curve. The view can be turned by dragging.
 */
export function SwingReplay(props: { readonly trace: SwingTrace; readonly t: Strings }) {
  const { trace, t } = props;
  const last = trace.tipDirection.length - 1;
  const shownTo = Math.min(last, trace.contact + Math.round(AFTER_CONTACT_S * trace.sampleRateHz));
  const [frame, setFrame] = useState(trace.contact);
  const [playing, setPlaying] = useState(false);
  const [azimuth, setAzimuth] = useState(DEFAULT_AZIMUTH);
  const position = useRef(trace.contact);
  const drag = useRef<number | null>(null);

  // A new stroke: show its contact frame.
  useEffect(() => {
    position.current = trace.contact;
    setFrame(trace.contact);
    setPlaying(false);
  }, [trace]);

  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    let previous: number | null = null;
    const tick = (now: number): void => {
      if (previous !== null) {
        position.current += ((now - previous) / 1000) * trace.sampleRateHz * PLAYBACK_RATE;
      }
      previous = now;
      if (position.current >= last) {
        position.current = last;
        setFrame(last);
        setPlaying(false);
        return;
      }
      setFrame(Math.floor(position.current));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [playing, last, trace.sampleRateHz]);

  const ghosts = useMemo(() => {
    const frames: number[] = [];
    for (let i = trace.forwardStart; i < trace.contact; i += GHOST_EVERY) frames.push(i);
    return frames;
  }, [trace]);

  const maxSpeed = Math.max(1, ...trace.speedMps);
  const chartX = (i: number): number => (i / Math.max(1, last)) * WIDTH;
  const speedLine = trace.speedMps
    .map((v, i) => {
      const y = CHART_HEIGHT - 4 - (v / maxSpeed) * (CHART_HEIGHT - 10);
      return `${chartX(i).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const offsetMs = ((frame - trace.contact) / trace.sampleRateHz) * 1000;

  const toggle = (): void => {
    position.current = !playing && frame >= last ? 0 : frame;
    setPlaying(!playing);
  };

  return (
    <figure class="replay">
      <svg
        class="replay-view"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={t.replay.label}
        onPointerDown={(e) => {
          drag.current = e.clientX;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const dx = e.clientX - drag.current;
          drag.current = e.clientX;
          setAzimuth((a) => a + dx * 0.01);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <polyline
          class="replay-path muted"
          points={points(tipPath(trace, 0, trace.forwardStart, azimuth))}
        />
        <polyline
          class="replay-path"
          points={points(tipPath(trace, trace.forwardStart, trace.contact, azimuth))}
        />
        <polyline
          class="replay-path muted dashed"
          points={points(tipPath(trace, trace.contact, shownTo, azimuth))}
        />
        {ghosts.map((i) => (
          <Racket key={i} trace={trace} frame={i} azimuth={azimuth} class="replay-racket ghost" />
        ))}
        <Racket
          trace={trace}
          frame={trace.contact}
          azimuth={azimuth}
          class="replay-racket contact"
        />
        {frame !== trace.contact && (
          <Racket trace={trace} frame={frame} azimuth={azimuth} class="replay-racket current" />
        )}
      </svg>

      <svg
        class="replay-chart"
        viewBox={`0 0 ${WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={t.replay.speedLabel}
      >
        <line
          class="replay-contact-line"
          x1={chartX(trace.contact)}
          y1={0}
          x2={chartX(trace.contact)}
          y2={CHART_HEIGHT}
        />
        <polyline class="replay-speed" points={speedLine} />
        <line
          class="replay-cursor"
          x1={chartX(frame)}
          y1={0}
          x2={chartX(frame)}
          y2={CHART_HEIGHT}
        />
      </svg>

      <div class="replay-controls">
        <button type="button" onClick={toggle}>
          {playing ? t.replay.pause : t.replay.play}
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={frame}
          aria-label={t.replay.scrub}
          onInput={(e) => {
            setPlaying(false);
            setFrame(Number(e.currentTarget.value));
          }}
        />
        <span class="replay-time">
          {offsetMs > 0 ? '+' : ''}
          {offsetMs.toFixed(0)} ms
        </span>
      </div>
      <figcaption>{t.replay.caption}</figcaption>
    </figure>
  );
}
