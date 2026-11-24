import type { RawCapture } from '../domain/types';
import { CaptureFlag, PROTOCOL_VERSION_V2 } from '../protocol/constants';

/**
 * Builds the v2 captures the firmware would deliver from a simulated capture
 * at four times the frame rate (e.g. `simulateSwing` at 416.67 Hz), exactly
 * as firmware/puck/src/main.js does (docs/sensor-v2.md):
 *
 * - frame f = samples 4f … 4f + 3 (G0 with A0, then G1, G2, G3);
 * - L section: A0 and the rounded gyro mean (ΣG + 2) >> 2;
 * - peak frame: largest ‖G0‖² (first one on ties);
 * - H section: raw gyro of frames peak − 15 … peak + 15, clamped to the capture;
 * - flags b1/b2 from every raw gyro sample and every A0 (28000 / 32703 counts);
 * - one timestamp per frame (the time of G0/A0).
 *
 * `m104` is the same swing in mode M104 (gyro and accelerometer at the frame
 * rate: every fourth sample). Filters are not modelled.
 */
export function firmwareCaptures(
  highRate: RawCapture,
  options: { readonly hHalfFrames?: number; readonly temperatureRaw?: number } = {},
): { readonly m416: RawCapture; readonly m104: RawCapture } {
  const q = 4;
  const total = highRate.samples.length / 6;
  const n = Math.floor(total / q);
  const s = highRate.samples;
  const at = (i: number, axis: number): number => s[i * 6 + axis] ?? 0;
  const fs = highRate.sampleRateHz;
  const times = highRate.sampleTimesUs;
  const frameTimesUs = Array.from({ length: n }, (_, f) =>
    times ? (times[f * q] ?? 0) : Math.round(((f * q) / fs) * 1e6),
  );
  // The firmware measures the frame period against the IMU timer.
  const spanUs = (frameTimesUs[n - 1] ?? 0) - (frameTimesUs[0] ?? 0);
  const framePeriodNs =
    times && n > 1 ? Math.round((spanUs / (n - 1)) * 1000) : Math.round((q / fs) * 1e9);

  const L = new Int16Array(n * 6);
  const M104 = new Int16Array(n * 6);
  let flags = 0;
  let peak = 0;
  let peakSq = -1;
  for (let f = 0; f < n; f++) {
    const i0 = f * q;
    let gsq = 0;
    for (let a = 0; a < 3; a++) {
      const acc = at(i0, a);
      L[f * 6 + a] = acc;
      M104[f * 6 + a] = acc;
      if (Math.abs(acc) >= 32767 - 64) flags |= CaptureFlag.AccelClipped;
      let sum = 0;
      for (let k = 0; k < q; k++) {
        const g = at(i0 + k, 3 + a);
        sum += g;
        if (Math.abs(g) >= 28000) flags |= CaptureFlag.GyroClipped;
      }
      L[f * 6 + 3 + a] = (sum + 2) >> 2;
      M104[f * 6 + 3 + a] = at(i0, 3 + a);
      gsq += at(i0, 3 + a) ** 2;
    }
    if (gsq > peakSq) {
      peakSq = gsq;
      peak = f;
    }
  }
  const half = options.hHalfFrames ?? 15;
  const hStart = Math.max(0, peak - half);
  const hFrames = Math.min(n - 1, peak + half) - hStart + 1;
  const H = new Int16Array(hFrames * q * 3);
  for (let j = 0; j < hFrames * q; j++) {
    for (let a = 0; a < 3; a++) H[j * 3 + a] = at(hStart * q + j, 3 + a);
  }
  const common = {
    kind: highRate.kind,
    sequence: highRate.sequence,
    sampleRateHz: 104,
    accelGPerLsb: 0.000488,
    gyroDpsPerLsb: 0.07,
    triggerIndex: peak,
    receivedAt: highRate.receivedAt,
    protocolVersion: PROTOCOL_VERSION_V2,
    framePeriodNs,
    sampleTimesUs: frameTimesUs,
    temperatureRaw: options.temperatureRaw ?? -666,
    temperatureC: 25 + (options.temperatureRaw ?? -666) / 256,
    accelUgPerLsb: 488,
    gyroMdpsPerLsb: 70,
  } as const;
  let m104Flags = 0;
  for (let i = 0; i < M104.length; i++) {
    const v = Math.abs(M104[i] ?? 0);
    if (i % 6 < 3 && v >= 32767 - 64) m104Flags |= CaptureFlag.AccelClipped;
    if (i % 6 >= 3 && v >= 28000) m104Flags |= CaptureFlag.GyroClipped;
  }
  return {
    m416: {
      ...common,
      samples: L,
      mode: 'M416',
      gyroHr: { startFrame: hStart, samplesPerFrame: q, data: H },
      flags,
    },
    m104: { ...common, samples: M104, mode: 'M104', flags: m104Flags },
  };
}
