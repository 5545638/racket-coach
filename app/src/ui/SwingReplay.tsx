import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SwingTrace } from '../metrics/analyzeSwing';
import type { Strings } from './strings';
import type { Vec3 } from '../math/vec3';
import { FIGURE, type Point, SHOULDER, project, racketPose, sweetSpotPath } from './swingGeometry';

/** Three-quarter view, drawn at 90 px per metre with the feet near the bottom. */
const SCALE = 90;
const WIDTH = 320;
const HEIGHT = 290;
const GROUND = 40;
const CHART_HEIGHT = 70;
const PLAYBACK_RATE = 0.25;

const px = (p: Point): string =>
  `${(WIDTH / 2 + p.x * SCALE).toFixed(1)},${(HEIGHT - GROUND - p.z * SCALE).toFixed(1)}`;
const polyline = (points: readonly Point[]): string => points.map(px).join(' ');

function Line(props: { from: Vec3; to: Vec3; class?: string }) {
  const [x1, y1] = px(project(props.from)).split(',');
  const [x2, y2] = px(project(props.to)).split(',');
  return <line class={props.class} x1={x1} y1={y1} x2={x2} y2={y2} />;
}

/** Slow-motion three-quarter view of one stroke with an illustrative figure, plus the speed curve. */
export function SwingReplay(props: {
  readonly trace: SwingTrace;
  readonly leverM: number;
  readonly t: Strings;
}) {
  const { trace, leverM, t } = props;
  const last = trace.tipDirection.length - 1;
  const [frame, setFrame] = useState(trace.contact);
  const [playing, setPlaying] = useState(false);
  const position = useRef(trace.contact);

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

  const paths = useMemo(
    () => ({
      preparation: polyline(sweetSpotPath(trace, 0, trace.forwardStart, leverM)),
      forward: polyline(sweetSpotPath(trace, trace.forwardStart, trace.contact, leverM)),
      finish: polyline(sweetSpotPath(trace, trace.contact, last, leverM)),
      contact: px(project(racketPose(trace, trace.contact, leverM).sweetSpot)).split(','),
    }),
    [trace, leverM, last],
  );

  const pose = racketPose(trace, frame, leverM);
  const hip: Vec3 = [0, 0, 0.88];
  const head = px(project([0, 0, FIGURE.shoulderHeight + 0.22])).split(',');
  const maxSpeed = Math.max(1, ...trace.speedMps);
  const chartX = (i: number): number => (i / Math.max(1, last)) * WIDTH;
  const speedLine = trace.speedMps
    .map(
      (v, i) =>
        `${chartX(i).toFixed(1)},${(CHART_HEIGHT - 4 - (v / maxSpeed) * (CHART_HEIGHT - 10)).toFixed(1)}`,
    )
    .join(' ');
  const offsetMs = ((frame - trace.contact) / trace.sampleRateHz) * 1000;

  const toggle = (): void => {
    if (!playing && frame >= last) position.current = 0;
    else position.current = frame;
    setPlaying(!playing);
  };

  return (
    <figure class="replay">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t.replay.label}>
        {/* Illustrative figure at the hitting shoulder; the target is to the right. */}
        <g class="replay-body">
          <circle cx={head[0]} cy={head[1]} r={10} />
          <Line from={SHOULDER} to={hip} />
          <Line from={hip} to={[-0.12, 0.12, 0]} />
          <Line from={hip} to={[0.16, -0.12, 0]} />
          <Line from={SHOULDER} to={pose.hand} />
        </g>
        <polyline class="replay-path muted" points={paths.preparation} />
        <polyline class="replay-path" points={paths.forward} />
        <polyline class="replay-path muted dashed" points={paths.finish} />
        <Line class="replay-handle" from={pose.hand} to={pose.throat} />
        <Line class="replay-head" from={pose.throat} to={pose.tip} />
        <circle class="replay-contact" cx={paths.contact[0]} cy={paths.contact[1]} r={5} />
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
