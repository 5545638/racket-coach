/**
 * Pure geometry of the inline-SVG charts (no rendering): scales, ticks and
 * paths. Coordinates are rounded to 0.1 so snapshots and aria text stay stable.
 */

export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const innerWidth = (f: Frame): number => f.width - f.left - f.right;
export const innerHeight = (f: Frame): number => f.height - f.top - f.bottom;

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Centre x of slot `i` of `n` equal slots across the frame (bars and categories). */
export function slotX(f: Frame, i: number, n: number): number {
  return round1(f.left + (innerWidth(f) * (i + 0.5)) / Math.max(1, n));
}

/** y of `value` on a 0…max scale (0 at the bottom). */
export function valueY(f: Frame, value: number, max: number): number {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return round1(f.top + innerHeight(f) * (1 - share));
}

/** Smallest "nice" axis maximum (1, 2, 2.5, 5 × 10ⁿ) ≥ `value`; at least `floor`. */
export function niceMax(value: number, floor = 1): number {
  const v = Math.max(value, floor);
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v - 1e-9) return m * exp;
  return 10 * exp;
}

/** Evenly spaced tick values 0…max (inclusive), `count` intervals. */
export function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max * i) / count);
}

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/**
 * Line through `values` (null = no data) at slot positions; a null breaks the
 * line. Returns the points and the SVG path (empty when no segment has two
 * points).
 */
export function linePoints(
  f: Frame,
  values: readonly (number | null)[],
  max: number,
  min = 0,
): { points: (Pt | null)[]; path: string } {
  const points = values.map((v, i) =>
    v === null
      ? null
      : {
          x: slotX(f, i, values.length),
          y: valueY(f, v - min, max - min),
        },
  );
  let open = false;
  const parts: string[] = [];
  for (const p of points) {
    if (p === null) {
      open = false;
      continue;
    }
    parts.push(`${open ? 'L' : 'M'}${p.x} ${p.y}`);
    open = true;
  }
  const path = parts.join(' ');
  return { points, path };
}

/** "07.11" from a timestamp, local time. */
export function dayMonth(timestamp: number): string {
  const d = new Date(timestamp);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}`;
}

/** Indices of the labels to draw so that at most `max` are shown, always the last. */
export function labelIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / max);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}
