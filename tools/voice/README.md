# Natural voice clips

Racket Coach speaks a fixed set of phrases (cue variants, reinforce phrases,
"Try the … drill", learning sentences, feedback and system messages). Instead
of the device's Web Speech voice they are played from pre-recorded neural
voice clips, because on iOS Safari and WKWebView browsers (Bluefy) web pages
only get the pre-installed compact voices: Enhanced / Premium voices
downloaded in iOS Settings are not available to `speechSynthesis`
([WebKit bug 290497](https://bugs.webkit.org/show_bug.cgi?id=290497),
[Apple developer forums thread 723503](https://developer.apple.com/forums/thread/723503)).
How the app plays them: `docs/architecture.md`, section "Speech".

This folder makes the English clips in `app/public/voice/`:

| File | What |
| --- | --- |
| `export-phrases.ts` / `.mjs` | Lists every phrase the app can speak (`app/src/feedback/phraseCatalog.ts`) into `phrases.json`. The `.mjs` runs the TypeScript with Vite's module runner (`runnerImport`; the repo has no tsx / vite-node). |
| `synthesis-text.json` | What the TTS reads when the prosody should differ from the on-screen text (`"Better"` → `"Better!"`). Not listed: the phrase plus a final full stop. Changes the audio only. |
| `generate.py` | Synthesises every English phrase with each profile, trims silence (20 ms lead-in, 80 ms tail), normalises to −16 LUFS with a look-ahead limiter, encodes mono AAC 48 kb/s 24 kHz `.m4a` (re-encoded quieter until the decoded peak is ≤ −1 dBFS), writes `app/public/voice/en-<profile>/<sha1(key)>.m4a` and `manifest.json` (`clips: {key: {file, durationMs}}`, key = `clipKey(text)`). |
| `verify.py` | Checks every clip without listening: present for every phrase, file name = sha1 of the key, 0.4–4 s (long learning sentences ≤ 5 s), not silent (RMS), no clipping (decoded peak ≤ −1 dBFS), short lead-in, loudness −16 ± 2.5 LUFS; prints 10 random phrases with durations. |
| `requirements.txt` | Pinned Python packages. |

## Voices

| Profile | Kokoro voice | Why |
| --- | --- | --- |
| `female` (default) | `af_heart` | The highest-graded Kokoro voice: warm, natural, clear. |
| `male` | `am_michael` | The best-graded American male voice; same accent as the female profile. |

Chosen from the voice grades published with Kokoro-82M (not by listening in
this environment). To try others, edit `PROFILES` in `generate.py`
(e.g. `bm_george` for a British male) and regenerate.

## Regenerate

Requirements: Python 3.13, `ffmpeg` on PATH, Node ≥ 20 with `app/node_modules`.

```sh
pip install -r tools/voice/requirements.txt
mkdir -p /tmp/kokoro && cd /tmp/kokoro
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
cd <repo>/app && npm run voice:generate    # export → generate → verify
```

The model files stay outside the repository (`--model-dir`, default
`/tmp/kokoro`); `generate.py` checks their SHA-256. Each run deletes and
rewrites `app/public/voice/en-*`. Re-run it whenever a spoken phrase changes:
`test/feedback/phraseCatalog.test.ts` fails while a phrase has no clip (the
app would speak that phrase with the device voice, logged as
`synth-fallback`). Kokoro on CPU is deterministic for the same versions, so
a re-run gives the same audio; AAC encoding uses ffmpeg's bit-exact flags.

Size: about 1.7 MB per profile (150 clips), 3.4 MB for both.

## Estonian

No Estonian neural TTS runs here. The app offers an optional one-time
download from the public TartuNLP API (`app/src/feedback/estonianVoice.ts`)
in Settings → Speech; the clips are cached in the browser and played offline.

## Licences

- Kokoro-82M (hexgrad) model and voices: Apache-2.0. The generated clips can
  be shipped with the app.
- kokoro-onnx (thewh1teagle): MIT. Phonemisation by espeak-ng (GPL-3.0, used
  as a tool at generation time only; nothing of it ships with the app).
- TartuNLP Estonian voices (University of Tartu): downloaded by the user's
  browser from the public API under its terms; not redistributed.
