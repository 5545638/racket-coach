import type { SessionInfo, StrokeRecord } from '../domain/types';

const CSV_COLUMNS = [
  'time',
  'strokeType',
  'swingSize',
  'swingStyle',
  'impactDetected',
  'headSpeedMps',
  'faceTiltDeg',
  'swingPathDeg',
  'tipElevationDeg',
  'peakSpeedOffsetMs',
  'preparationTimeMs',
  'backswingArcDeg',
  'backswingPauseMs',
  'racketDropDeg',
  'faceAtDropDeg',
  'peakAccelerationOffsetMs',
  'faceClosingRateDps',
  'forwardSwingArcDeg',
  'followThroughArcDeg',
  'attitudeReliable',
  'gyroSaturated',
  'cue',
] as const;

const fmt = (v: number | null): string => (v === null ? '' : v.toFixed(2));

/** One row per stroke; metrics only. */
export function toCsv(strokes: readonly StrokeRecord[]): string {
  const rows = strokes.map((s) => {
    const m = s.metrics;
    return [
      new Date(s.capture.receivedAt).toISOString(),
      m.strokeType,
      m.swingSize,
      m.swingStyle ?? '',
      String(m.impactDetected),
      fmt(m.headSpeedMps),
      fmt(m.faceTiltDeg),
      fmt(m.swingPathDeg),
      fmt(m.tipElevationDeg),
      fmt(m.peakSpeedOffsetMs),
      fmt(m.preparationTimeMs),
      fmt(m.backswingArcDeg),
      fmt(m.backswingPauseMs),
      fmt(m.racketDropDeg),
      fmt(m.faceAtDropDeg),
      fmt(m.peakAccelerationOffsetMs),
      fmt(m.faceClosingRateDps),
      fmt(m.forwardSwingArcDeg),
      fmt(m.followThroughArcDeg),
      String(m.quality.attitudeReliable),
      String(m.quality.gyroSaturated),
      `"${s.cue.text.replace(/"/g, '""')}"`,
    ].join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/** Full-fidelity export including raw sensor data (base64), for offline analysis. */
export function toJson(session: SessionInfo, strokes: readonly StrokeRecord[]): string {
  return JSON.stringify(
    {
      format: 'racket-coach-session',
      version: 1,
      session,
      strokes: strokes.map((s) => ({
        ...s,
        capture: { ...s.capture, samples: int16ToBase64(s.capture.samples) },
      })),
    },
    null,
    2,
  );
}

export function int16ToBase64(values: Int16Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToInt16(encoded: string): Int16Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
