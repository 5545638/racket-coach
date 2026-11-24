import { useState } from 'preact/hooks';
import './report.css';
import { type Frame, innerHeight, labelIndices, linePoints, slotX, ticks, valueY } from './charts';

const FRAME: Frame = { width: 360, height: 168, left: 34, right: 10, top: 10, bottom: 24 };
const MAX_X_LABELS = 6;

export interface Series {
  readonly id: string;
  readonly label: string;
  /** CSS colour (a custom property). */
  readonly color: string;
  readonly values: readonly (number | null)[];
}

interface Common {
  readonly title: string;
  /** Category labels ("07.11"), one per slot. */
  readonly labels: readonly string[];
  /** Spoken description with the numbers. */
  readonly aria: string;
  /** Text shown for the tapped slot. */
  readonly readout: (index: number) => string;
  readonly tapHint: string;
  readonly yFormat?: (v: number) => string;
  readonly compact?: boolean;
  readonly ticks?: number;
}

function Axes({
  max,
  min = 0,
  labels,
  yFormat,
  frame,
  tickCount,
}: {
  readonly max: number;
  readonly min?: number;
  readonly labels: readonly string[];
  readonly yFormat: (v: number) => string;
  readonly frame: Frame;
  readonly tickCount: number;
}) {
  return (
    <g class="chart-axes" aria-hidden="true">
      {ticks(max - min, tickCount).map((t) => {
        const v = min + t;
        const y = valueY(frame, t, max - min);
        return (
          <g key={v}>
            <line class="grid" x1={frame.left} x2={frame.width - frame.right} y1={y} y2={y} />
            <text class="tick" x={frame.left - 5} y={y + 3.5} text-anchor="end">
              {yFormat(v)}
            </text>
          </g>
        );
      })}
      {labelIndices(labels.length, MAX_X_LABELS).map((i) => (
        <text
          key={i}
          class="tick"
          x={slotX(frame, i, labels.length)}
          y={frame.height - 7}
          text-anchor="middle"
        >
          {labels[i]}
        </text>
      ))}
    </g>
  );
}

function Hit({
  frame,
  n,
  selected,
  onSelect,
}: {
  readonly frame: Frame;
  readonly n: number;
  readonly selected: number | null;
  readonly onSelect: (i: number) => void;
}) {
  const w = (frame.width - frame.left - frame.right) / Math.max(1, n);
  return (
    <g>
      {Array.from({ length: n }, (_, i) => (
        <rect
          key={i}
          class={i === selected ? 'hit selected' : 'hit'}
          x={slotX(frame, i, n) - w / 2}
          y={frame.top}
          width={w}
          height={innerHeight(frame)}
          onClick={() => {
            onSelect(i);
          }}
        />
      ))}
    </g>
  );
}

function Readout({ text, hint }: { readonly text: string | null; readonly hint: string }) {
  return (
    <p class="chart-readout" aria-live="polite">
      {text ?? <span class="muted">{hint}</span>}
    </p>
  );
}

export function StackedBars({
  series,
  max,
  ...common
}: Common & { readonly series: readonly Series[]; readonly max: number }) {
  const [selected, setSelected] = useState<number | null>(null);
  const frame = FRAME;
  const n = common.labels.length;
  const yMax = max;
  const barW = Math.min(18, ((frame.width - frame.left - frame.right) / Math.max(1, n)) * 0.7);
  return (
    <figure class="chart">
      <figcaption>{common.title}</figcaption>
      <Legend series={series} />
      <Readout text={selected === null ? null : common.readout(selected)} hint={common.tapHint} />
      <svg viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label={common.aria}>
        <Axes
          max={yMax}
          labels={common.labels}
          yFormat={common.yFormat ?? String}
          frame={frame}
          tickCount={common.ticks ?? 4}
        />
        {Array.from({ length: n }, (_, i) => {
          let base = 0;
          return (
            <g key={i} class={i === selected ? 'bar-stack selected' : 'bar-stack'}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const y0 = valueY(frame, base, yMax);
                base += v;
                const y1 = valueY(frame, base, yMax);
                return (
                  <rect
                    key={s.id}
                    x={slotX(frame, i, n) - barW / 2}
                    y={y1}
                    width={barW}
                    height={Math.max(0.5, y0 - y1)}
                    fill={s.color}
                  />
                );
              })}
            </g>
          );
        })}
        <Hit frame={frame} n={n} selected={selected} onSelect={setSelected} />
      </svg>
    </figure>
  );
}

export function Legend({ series }: { readonly series: readonly Series[] }) {
  return (
    <ul class="legend">
      {series.map((s) => (
        <li key={s.id}>
          <span class="swatch" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export function LineChart({
  series,
  yMax,
  yMin = 0,
  showLegend = true,
  ...common
}: Common & {
  readonly series: readonly Series[];
  readonly yMax: number;
  readonly yMin?: number;
  readonly showLegend?: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const frame: Frame = common.compact ? { ...FRAME, height: 124, bottom: 22 } : FRAME;
  const n = common.labels.length;
  const drawn = series.map((s) => ({ s, ...linePoints(frame, s.values, yMax, yMin) }));
  return (
    <figure class="chart">
      <figcaption>{common.title}</figcaption>
      {showLegend && series.length > 1 && <Legend series={series} />}
      <Readout text={selected === null ? null : common.readout(selected)} hint={common.tapHint} />
      <svg viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label={common.aria}>
        <Axes
          max={yMax}
          min={yMin}
          labels={common.labels}
          yFormat={common.yFormat ?? String}
          frame={frame}
          tickCount={common.ticks ?? (common.compact ? 2 : 4)}
        />
        {selected !== null && (
          <line
            class="cursor"
            x1={slotX(frame, selected, n)}
            x2={slotX(frame, selected, n)}
            y1={frame.top}
            y2={frame.height - frame.bottom}
          />
        )}
        {drawn.map(({ s, points, path }) => (
          <g key={s.id}>
            {path && <path class="line" d={path} stroke={s.color} />}
            {points.map((p, i) =>
              p ? (
                <circle
                  key={i}
                  class={i === selected ? 'dot selected' : 'dot'}
                  cx={p.x}
                  cy={p.y}
                  r={i === selected ? 4.5 : 3}
                  fill={s.color}
                />
              ) : null,
            )}
          </g>
        ))}
        <Hit frame={frame} n={n} selected={selected} onSelect={setSelected} />
      </svg>
    </figure>
  );
}
