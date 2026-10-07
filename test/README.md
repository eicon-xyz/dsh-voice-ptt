# Tests

End-to-end tests that drive a **real browser against a running DSH web profile**.
They are not unit tests: they exercise the actual mount, the actual keyboard
handling, and the actual speech recognizer.

## Prerequisites

1. A running DSH web profile with this plugin installed (see the top-level README).
2. A token for that profile — it is printed in the URL when DSH starts
   (`dsh web: http://127.0.0.1:3081/?token=...`).
3. Chrome or Chromium. Found automatically via `CHROME_PATH`, Playwright's cache,
   or `PATH`; set `CHROME_PATH` to override.
4. `ws` (`npm install` at the repository root).
5. A speech fixture at `test/fixtures/speech-16k.wav` — 16 kHz mono PCM16 WAV.
   Regenerate it from any audio Chrome can decode:

   ```sh
   node test/make-fixture.cjs some-speech.mp3
   ```

   No ffmpeg needed: Chrome does the decoding, and the resample mirrors the
   plugin's own path.

## Running

```sh
export PTT_TOKEN=<token>
export PTT_BASE=http://127.0.0.1:3081     # optional
export PTT_AUDIO=/path/to/speech-16k.wav  # optional, overrides the fixture

node test/e2e.cjs
```

Each script prints `[step]` lines as it goes and `[check] PASS/FAIL` per assertion,
then writes a JSON report next to itself. Exit code is `0` when every check passed,
`2` when a check failed, `1` on a harness error.

| Script | Covers |
| --- | --- |
| `e2e.cjs` | Plugin is in the boot graph; apply ran; hint shows; hold starts recording; release transcribes into the draft |
| `picker.cjs` | Hint opens the picker; all candidates listed; picking a key updates the hint, persists it, makes the new key work and the old one inert |
| `modifier-key.cjs` | Right Ctrl as the hold key records and transcribes; holding it while pressing A cancels the take instead of swallowing `Ctrl+A` |
| `nonempty-draft.cjs` | Hint hides on a non-empty draft but the key still works; text is appended |
| `modal-yield.cjs` | With a dialog open the key is not captured; after closing, it works again |

## What the plugin exposes for assertions

The status node carries the state the tests read:

| Attribute | Meaning |
| --- | --- |
| `data-voice-ptt="status"` | The status line itself |
| `data-phase` | `idle` / `requesting` / `recording` / `transcribing` / `error` / `hint` |
| `data-voice-ptt-stop` | Why the last take ended (diagnostic; e.g. `released`, `other-key:KeyX`, `window-blur`) |

`data-voice-ptt="hint"` marks the clickable hint, `data-voice-ptt="picker"` the
expanded picker, and `data-voice-ptt-key="<code>"` each candidate button.

## Notes

- The tests are timing-sensitive by nature (they wait on a real recognizer), so
  they use polling with generous timeouts rather than fixed sleeps.
- Reloading the plugin bundle mid-run cancels an in-flight take. If a run fails
  right after you edited `lib/client.js`, just run it again.
- They never send a message: the transcript only lands in the draft.
