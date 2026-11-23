import type { StrokeType } from '../domain/types';

export const STROKE_LABEL: Record<StrokeType, string> = {
  forehand: 'Forehand',
  backhand: 'Backhand',
  overhead: 'Overhead',
};

export function deg(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)}°`;
}

export function kmh(mps: number, lowerBound = false): string {
  return `${lowerBound ? '≥' : ''}${(mps * 3.6).toFixed(0)} km/h`;
}

export function ms(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(0)} ms`;
}
