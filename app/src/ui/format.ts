const DASH = '—';

export function deg(value: number | null): string {
  return value === null ? DASH : `${value.toFixed(0)}°`;
}

export function kmh(mps: number, lowerBound = false): string {
  return `${lowerBound ? '≥' : ''}${(mps * 3.6).toFixed(0)} km/h`;
}

/** Milliseconds; `signed` adds an explicit plus for offsets relative to contact. */
export function ms(value: number | null, signed = true): string {
  if (value === null) return DASH;
  return `${signed && value > 0 ? '+' : ''}${value.toFixed(0)} ms`;
}

export function dps(value: number | null): string {
  return value === null ? DASH : `${value.toFixed(0)} °/s`;
}
