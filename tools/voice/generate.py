#!/usr/bin/env python3
"""Pre-generates Racket Coach's natural English voice clips.

Reads tools/voice/phrases.json (written by export-phrases.mjs), synthesises
every English phrase with each voice profile using Kokoro-82M (kokoro-onnx),
trims silence, normalises loudness and encodes mono AAC (.m4a), writing

    app/public/voice/en-<profile>/<sha1(key)>.m4a
    app/public/voice/en-<profile>/manifest.json   {clips: {key: {file, durationMs}}}

See tools/voice/README.md. Usage (from app/): npm run voice:generate
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyloudnorm
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
from scipy.signal import resample_poly

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

SAMPLE_RATE = 24_000
BITRATE = "48k"
TARGET_LUFS = -16.0
PEAK_DBTP = -1.0
LEAD_S = 0.02  # silence kept before the voice (<= 30 ms)
TAIL_S = 0.08  # kept after it: the natural decay of the last sound
SILENCE_DBFS = -45.0

# Profile -> (Kokoro voice, espeak language). Chosen from Kokoro's voice
# grades (VOICES.md of hexgrad/Kokoro-82M): af_heart is the top-rated voice,
# warm and natural; am_michael is the best-rated American male voice.
PROFILES = {
    "female": ("af_heart", "en-us"),
    "male": ("am_michael", "en-us"),
}

MODEL_FILES = {
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_models(model_dir: Path) -> None:
    for name, digest in MODEL_FILES.items():
        path = model_dir / name
        if not path.exists():
            sys.exit(f"missing {path}: download {MODEL_URL}{name} (see README)")
        if sha256(path) != digest:
            sys.exit(f"{path}: sha256 mismatch (expected {digest})")


def synthesis_text(text: str, overrides: dict[str, str]) -> str:
    """What Kokoro reads: the override, else the phrase with a final full stop."""
    if text in overrides:
        return overrides[text]
    return text if text[-1] in ".!?" else f"{text}."


def trim(x: np.ndarray) -> np.ndarray:
    """Cuts leading/trailing silence (5 ms RMS below SILENCE_DBFS)."""
    win = int(0.005 * SAMPLE_RATE)
    rms = np.sqrt(uniform_filter1d(x.astype(np.float64) ** 2, win))
    loud = np.flatnonzero(rms > 10 ** (SILENCE_DBFS / 20))
    if loud.size == 0:
        return x
    start = max(0, loud[0] - int(LEAD_S * SAMPLE_RATE))
    end = min(x.size, loud[-1] + int(TAIL_S * SAMPLE_RATE))
    y = x[start:end].copy()
    fade = min(int(0.005 * SAMPLE_RATE), y.size // 4)
    if fade > 0:
        y[:fade] *= np.linspace(0, 1, fade)
        y[-fade:] *= np.linspace(1, 0, fade)
    return y


def loudness(meter: pyloudnorm.Meter, x: np.ndarray) -> float:
    # The meter needs >= 400 ms; silence padding is gated out.
    padded = np.pad(x, (0, max(0, SAMPLE_RATE - x.size)))
    return float(meter.integrated_loudness(padded))


def true_peak(x: np.ndarray) -> float:
    return float(np.max(np.abs(resample_poly(x, 4, 1)))) if x.size else 0.0


def limit(x: np.ndarray, ceiling: float) -> np.ndarray:
    """Look-ahead peak limiter: smooth gain so the 4x-oversampled peak stays under `ceiling`."""
    env = np.abs(resample_poly(x, 4, 1)).reshape(-1, 4).max(axis=1)[: x.size]
    env = maximum_filter1d(env, int(0.003 * SAMPLE_RATE))
    gain = np.minimum(1.0, ceiling / np.maximum(env, 1e-9))
    gain = minimum_filter1d(gain, int(0.004 * SAMPLE_RATE))
    gain = uniform_filter1d(gain, int(0.004 * SAMPLE_RATE))
    return x * gain


def normalise(meter: pyloudnorm.Meter, x: np.ndarray, margin_db: float) -> np.ndarray:
    """-16 LUFS, peaks limited to PEAK_DBTP - margin_db (margin for the AAC encoder's overshoot)."""
    ceiling = 10 ** ((PEAK_DBTP - margin_db) / 20)
    y = x.astype(np.float64)
    for _ in range(4):
        y *= 10 ** ((TARGET_LUFS - loudness(meter, y)) / 20)
        if true_peak(y) > ceiling:
            y = limit(y, ceiling)
    while true_peak(y) > ceiling:  # loudness gives way to the peak ceiling
        y *= ceiling / true_peak(y)
    return y.astype(np.float32)


def encode(x: np.ndarray, out: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "-",
            "-c:a", "aac", "-b:a", BITRATE, "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
            "-movflags", "+faststart", str(out),
        ],
        input=x.astype("<f4").tobytes(),
        check=True,
    )


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", type=Path, default=Path("/tmp/kokoro"))
    ap.add_argument("--phrases", type=Path, default=HERE / "phrases.json")
    ap.add_argument("--out", type=Path, default=REPO / "app" / "public" / "voice")
    ap.add_argument("--profiles", nargs="*", default=list(PROFILES))
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH")
    check_models(args.model_dir)
    from kokoro_onnx import Kokoro  # after the checks: importing loads onnxruntime

    kokoro = Kokoro(str(args.model_dir / "kokoro-v1.0.onnx"), str(args.model_dir / "voices-v1.0.bin"))
    phrases = json.loads(args.phrases.read_text("utf-8"))["phrases"]["en"]
    overrides = json.loads((HERE / "synthesis-text.json").read_text("utf-8"))["en"]
    meter = pyloudnorm.Meter(SAMPLE_RATE)

    for profile in args.profiles:
        voice, lang = PROFILES[profile]
        out_dir = args.out / f"en-{profile}"
        if out_dir.exists():
            shutil.rmtree(out_dir)
        out_dir.mkdir(parents=True)
        clips: dict[str, dict[str, object]] = {}
        for n, phrase in enumerate(phrases, 1):
            key = phrase["key"]
            said = synthesis_text(phrase["text"], overrides)
            samples, sr = kokoro.create(said, voice=voice, speed=args.speed, lang=lang)
            if sr != SAMPLE_RATE:
                sys.exit(f"unexpected sample rate {sr}")
            trimmed = trim(np.asarray(samples, dtype=np.float32))
            name = f"{sha1(key)}.m4a"
            # AAC at 48 kb/s overshoots peaks by up to ~3 dB: limit harder (same
            # loudness) until the decoded clip stays under the peak ceiling.
            margin = 1.0
            for attempt in range(8):
                audio = normalise(meter, trimmed, margin)
                encode(audio, out_dir / name)
                decoded = decode(out_dir / name)
                over = 20 * np.log10(float(np.max(np.abs(decoded))) + 1e-12) - PEAK_DBTP
                if over <= 0:
                    break
                if attempt == 7:
                    sys.exit(f"{key!r}: decoded peak stays {over:.2f} dB over the ceiling")
                margin += over + 0.3
            clips[key] = {"file": name, "durationMs": round(1000 * decoded.size / SAMPLE_RATE)}
            print(f"[{profile} {n}/{len(phrases)}] {clips[key]['durationMs']:>5} ms  {said}", flush=True)
        manifest = {
            "version": 1,
            "lang": "en",
            "profile": profile,
            "voice": f"kokoro-v1.0/{voice}",
            "sampleRate": SAMPLE_RATE,
            "clips": dict(sorted(clips.items())),
        }
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", "utf-8")


if __name__ == "__main__":
    main()
