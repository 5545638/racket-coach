import { TARGET_BANDS } from '../coaching/defaultRules';

const DASH = '—';

/** Typographic minus for display ("−12", not "-12"); never "−0". */
export function minus(text: string): string {
  return text.replace(/^-(?=0*(\.0*)?$)/, '').replace(/^-/, '−');
}

export function deg(value: number | null): string {
  return value === null ? DASH : `${minus(value.toFixed(0))}°`;
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

const signed = (n: number): string => (n < 0 ? `−${-n}` : `${n}`);

/** Target bands shown next to each value, derived from the rule limits (defaultRules.ts). */
export const TARGETS = {
  face: `${signed(TARGET_BANDS.face.min)}…${signed(TARGET_BANDS.face.max)}°`,
  path: `${TARGET_BANDS.path.min}…${TARGET_BANDS.path.max}°`,
  timing: `≥ ${signed(TARGET_BANDS.peakSpeedOffsetMs.min)} ms`,
} as const;
