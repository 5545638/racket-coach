#!/usr/bin/env python3
"""Checks the generated clips without listening: every manifest entry exists,
duration is plausible, the clip is not silent, nothing clips, the lead-in is
short and the loudness is near the target. Prints 10 random phrases.

Usage (from app/): npm run voice:verify   (exit code 1 on any failure)
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import numpy as np
import pyloudnorm

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import REPO, SAMPLE_RATE, decode, loudness, sha1  # noqa: E402

MIN_S, MAX_S = 0.4, 4.0
# Learning-mode explanations are one sentence of up to 12 words.
MAX_LONG_S = 5.0


def main() -> None:
    root = REPO / "app" / "public" / "voice"
    phrases = json.loads((Path(__file__).parent / "phrases.json").read_text("utf-8"))["phrases"]["en"]
    meter = pyloudnorm.Meter(SAMPLE_RATE)
    failures: list[str] = []
    rows: list[tuple[str, str, int]] = []
    total = 0
    for manifest_path in sorted(root.glob("en-*/manifest.json")):
        profile_dir = manifest_path.parent
        clips = json.loads(manifest_path.read_text("utf-8"))["clips"]
        missing = {p["key"] for p in phrases} - set(clips)
        failures += [f"{profile_dir.name}: no clip for {k!r}" for k in sorted(missing)]
        stats = []
        for key, entry in clips.items():
            path = profile_dir / entry["file"]
            total += path.stat().st_size
            if entry["file"] != f"{sha1(key)}.m4a":
                failures.append(f"{path}: file name is not sha1 of {key!r}")
            x = decode(path)
            dur = x.size / SAMPLE_RATE
            rms_db = 20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12)
            peak = float(np.max(np.abs(x)))
            clipped = int(np.sum(np.abs(x) >= 0.999))
            if peak > 10 ** (-0.9 / 20):
                failures.append(f"{path} {key!r}: decoded peak {20 * np.log10(peak):.2f} dBFS > -1")
            lead = int(np.argmax(np.abs(x) > 10 ** (-40 / 20))) / SAMPLE_RATE
            lufs = loudness(meter, x)
            long_ok = len(key.split()) >= 8 and dur <= MAX_LONG_S
            if not (MIN_S <= dur <= MAX_S or long_ok):
                failures.append(f"{path} {key!r}: duration {dur:.2f} s")
            if rms_db < -40:
                failures.append(f"{path} {key!r}: silent (RMS {rms_db:.1f} dBFS)")
            if clipped:
                failures.append(f"{path} {key!r}: {clipped} clipped samples")
            if lead > 0.03 + 0.06:  # + AAC decoder look-ahead not removed by every decoder
                failures.append(f"{path} {key!r}: lead-in {lead * 1000:.0f} ms")
            if abs(lufs - (-16)) > 2.5:
                failures.append(f"{path} {key!r}: loudness {lufs:.1f} LUFS")
            stats.append((dur, rms_db, peak, lufs, lead))
            rows.append((profile_dir.name, key, entry["durationMs"]))
        d, r, p, l, ld = (np.array(c) for c in zip(*stats))
        print(
            f"{profile_dir.name}: {len(clips)} clips, {d.min():.2f}–{d.max():.2f} s "
            f"(mean {d.mean():.2f}), RMS {r.min():.1f}…{r.max():.1f} dBFS, "
            f"peak max {20 * np.log10(p.max()):.2f} dBFS, loudness {l.min():.1f}…{l.max():.1f} LUFS, "
            f"lead-in max {ld.max() * 1000:.0f} ms"
        )
    print(f"total audio: {total / 1e6:.2f} MB")
    print("\n10 random phrases (seed 7):")
    print(f"{'profile':<10} {'ms':>5}  phrase")
    for profile, key, ms in random.Random(7).sample(rows, min(10, len(rows))):
        print(f"{profile:<10} {ms:>5}  {key}")
    if failures:
        print("\nFAILURES:\n" + "\n".join(failures))
        sys.exit(1)
    print("\nall clips OK")


if __name__ == "__main__":
    main()
