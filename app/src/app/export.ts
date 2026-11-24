import type { RawCapture, SessionInfo, StrokeRecord } from '../domain/types';

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
  'analysisVersion',
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
      s.analysisVersion === undefined ? '' : String(s.analysisVersion),
    ].join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/**
 * Full-fidelity export including raw sensor data (base64), for offline analysis.
 * Each stroke carries its `analysisVersion`, `analysisParams` and `calibration`
 * (when recorded; strokes saved by older app versions lack them), so a session
 * can be re-analysed exactly without the app's database. Format version 2 only
 * adds those optional stroke fields to version 1. Captures received over
 * protocol v2 carry further optional fields (see RawCapture); `gyroHr.data`
 * is base64 like `samples`.
 */
export function toJson(session: SessionInfo, strokes: readonly StrokeRecord[]): string {
  return JSON.stringify(
    {
      format: 'racket-coach-session',
      version: 2,
      session,
      strokes: strokes.map((s) => ({
        ...s,
        capture: {
          ...s.capture,
          samples: int16ToBase64(s.capture.samples),
          // v2 high-rate gyro section (optional), base64 like the samples.
          ...(s.capture.gyroHr
            ? { gyroHr: { ...s.capture.gyroHr, data: int16ToBase64(s.capture.gyroHr.data) } }
            : {}),
          // A typed array would serialise as an object keyed by index.
          ...(s.capture.sampleTimesUs
            ? { sampleTimesUs: Array.from(s.capture.sampleTimesUs) }
            : {}),
        },
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

/** A session read back from {@link toJson}. */
export interface ImportedSession {
  readonly session: SessionInfo;
  readonly strokes: readonly StrokeRecord[];
}

/**
 * Reads a session written by {@link toJson} (format versions 1 and 2): the
 * raw captures come back with their Int16Array samples and H sections, so
 * every stroke can be re-analysed (app/pipeline.ts `reanalyseStroke`) and
 * gives the same metrics as on the phone. `sampleTimesUs` comes back as a
 * plain array (same values). Throws on anything else.
 */
export function fromJson(text: string): ImportedSession {
  const parsed = JSON.parse(text) as {
    format?: unknown;
    version?: unknown;
    session?: SessionInfo;
    strokes?: (Omit<StrokeRecord, 'capture'> & {
      capture: Omit<RawCapture, 'samples' | 'gyroHr'> & {
        samples: string;
        gyroHr?: { startFrame: number; samplesPerFrame: number; data: string };
      };
    })[];
  };
  if (parsed.format !== 'racket-coach-session' || (parsed.version !== 1 && parsed.version !== 2)) {
    throw new Error('Not a Racket Coach session export');
  }
  if (!parsed.session || !Array.isArray(parsed.strokes))
    throw new Error('Malformed session export');
  return {
    session: parsed.session,
    strokes: parsed.strokes.map((s) => {
      const { samples, gyroHr, ...capture } = s.capture;
      return {
        ...s,
        capture: {
          ...capture,
          samples: base64ToInt16(samples),
          ...(gyroHr ? { gyroHr: { ...gyroHr, data: base64ToInt16(gyroHr.data) } } : {}),
        },
      };
    }),
  };
}
