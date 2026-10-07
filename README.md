# dsh-voice-ptt

English | [中文](README.zh-CN.md)

Push-to-talk dictation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **hold a single key in the composer, speak, release** — the transcript is inserted into your draft.

No chord to memorise. Hold **F2**, release, done.

---

## What it does

1. Put the cursor in the composer. While it is focused and the draft is empty, a faint hint appears in the toolbar: `Hold F2 to dictate`.
2. **Hold F2** — recording starts and the hint becomes `Recording — release F2 to finish`.
3. **Release** — the audio is transcribed and the text lands at the caret in your draft.

While dictating:

- Press `Esc`, or press any other key (say, the letter you meant to type), to cancel and discard the recording.
- Losing window focus, or switching the tab away, cancels the recording rather than capturing unrelated audio.
- Exceeding the recognizer's limit stops the recording automatically and transcribes what it got.

## Changing the key

The hint **is a button**. Click it to expand the candidate keys, click one, and it applies immediately and is remembered (in `localStorage`).

| Key | Notes |
| --- | --- |
| **F2** (default) | Function key: types no character, minimal conflicts |
| F4 | Function key, further right |
| Insert | Right hand on full-size keyboards; absent on many laptops |
| Right Ctrl | Comfortable for the right pinky |
| Right Shift | Right pinky; on Windows, five taps can trigger Sticky Keys |

Modifier keys work properly: the plugin knows the hold key *is* a modifier, so it does not mistake it for a chord and pass the event through.

The hint, the status line, and these key names follow your DSH language (`en` / `zh`).

To offer a different key, edit `KEY_OPTIONS` at the top of `lib/client.js` (a `{code, labelKey}` array, `code` spelled as `KeyboardEvent.code`, `labelKey` naming an entry in the zh / en dictionaries at the top of the same file).

## Install

```sh
dsh plugin --profile web add dsh-voice-ptt
```

The package declares `dsh.bundle.patch`, so the command appends it to the profile's bundle stack and mounts it — no hand-editing of `cordis.patch.yml`. From a Git checkout, pin the revision:

```sh
dsh plugin --profile web add 'github:eicon-xyz/dsh-voice-ptt#<commit>'
```

Requires the speech recognizer. Install and enable `@deepseek-ai/dsh-experimental-voice-input-bundle` and prepare a model once (roughly 230 MB). If the recognizer is not ready, holding the key reports a visible reason in the status line instead of failing silently.

### Development

```sh
# mount the checkout directly instead of installing
ln -sfn "$PWD" "$DSH_HOME/profiles/web/node_modules/dsh-voice-ptt"
# then add to the profile's own cordis.patch.yml:
#   - insert:
#       - id: dsh-voice-ptt
#         name: 'dsh-voice-ptt'
```

Remove that manual mount line before switching to the bundle channel, or the row is mounted twice.

## Why a single key needs its own keyboard handling

The official shortcut service (`@deepseek-ai/dsh-client-shortcuts`) dispatches **`keydown` only** — there is no `keyup` event to end a hold. It also rejects modifier-free bindings (`bindingIssue` returns `modifier-required`) and, on the web, restricts chords to a platform allow-list.

So "hold one key and talk" cannot be expressed as a shortcut command. This plugin owns the keyboard instead: document-level `keydown` starts, `keyup` finishes. The trade-off is that it cannot appear in **Settings → Shortcuts**, which is why the key picker lives in the composer.

### Keeping a single key from becoming a second modifier

| Situation | Behaviour |
| --- | --- |
| Focus is not in a composer | Does not start recording |
| Any other key pressed while recording | Cancels the take; that key works normally (hold Right Ctrl, press A → `Ctrl+A` still applies) |
| A dialog or menu is open | Yields the key |
| Modified press (`Ctrl+F2`, `Alt+F2`, …) | Not intercepted at all |
| Focus is in a terminal | Not intercepted (xterm needs function keys) |

## How it works

- **Draft insertion** uses the session-scoped `inputActions` (`captureInsertion` + `insertText`). The plugin registers a resident entry in `conversation.input.left` to record each session's actions; that same entry renders the status line, the focus hint, and the key picker.
- **Recording** uses `MediaRecorder` and resamples through `OfflineAudioContext` to 16 kHz mono PCM16 WAV — the same format the official voice-input plugin sends — then calls the host's `speech.transcribe`.
- **The host half is deliberately empty.** Every behaviour lives in the browser half, reached through `dsh.client`.

## Files

| Path | Purpose |
| --- | --- |
| `lib/client.js` | Browser half: keys, recording, transcription, status line, key picker |
| `lib/index.js` | Host half (intentionally empty, so the bundle row is mountable) |
| `cordis.patch.yml` | `dsh.bundle.patch` layer the installer merges |
| `test/` | Headless-Chrome end-to-end tests |

## Tests

They drive a real browser against a running DSH web profile, with Chrome's fake microphone fed the bundled fixture:

```sh
npm install                       # provides ws
export PTT_TOKEN=<token from the dsh web URL>
node test/e2e.cjs                 # hold → release → transcript inserted
node test/picker.cjs              # picker opens, a new key applies and persists
node test/modifier-key.cjs        # Right Ctrl records; Ctrl+A is not hijacked
node test/nonempty-draft.cjs      # works with a non-empty draft, text is appended
node test/modal-yield.cjs         # yields while a dialog is open, works again after
```

`test/make-fixture.cjs` regenerates `test/fixtures/speech-16k.wav` from any audio Chrome can decode:

```sh
node test/make-fixture.cjs input.mp3        # needs Chrome; no ffmpeg required
```

## Limitations

- Web surface only (the desktop native keyboard bridge is not wired to this plugin).
- No streaming captions: the text appears after you release.
- Never sends automatically — the transcript goes to the draft for you to review.
- One hold key at a time, and only from the built-in candidate list unless you edit `KEY_OPTIONS`.

## License

MIT
