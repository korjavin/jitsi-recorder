# Recording — how record.js works

`record.js` drives a headless Chromium into a Jitsi room as a muted, camera-off
participant, records the tab's incoming (mixed) audio and writes a single
WebM/Opus file. Today it is a CLI (below); it becomes the library the HTTP service calls in a later
change — see `docs/architecture.md` for the service contract.

## Usage

```bash
node record.js --url <https://jitsi.example.com/ROOM> --out <path/audio.webm> \
  [--tracks-dir <dir>] \
  [--join-timeout <sec, default 600>] \
  [--max-duration <sec, default 14400>] \
  [--empty-grace <sec, default 60>] \
  [--display-name <str, default NoteTaker>]
```

The parent directory of `--out` is created if missing, as is `--tracks-dir`.

### stdout

Exactly one JSON line, on success only:

```json
{"out":"/data/audio.webm","duration_s":114.1,"reason":"empty_room","participants":["Alice","Bob"]}
```

* `out` — absolute, whatever shape `--out` was given in, so it matches the
  absolute `tracks[].path` below.
* `reason` — `empty_room` | `signal` | `max_duration`
* `participants` — display names of non-bot participants seen at any point
  during the recording, deduped, first-seen order. Hidden participants
  (transcriber/SIP ghosts) and nameless ones are omitted.
* `tracks` — present **only** with `--tracks-dir` (see below). Without the flag
  the line is byte-identical to the one above.

All logs go to **stderr**, each line prefixed with an ISO timestamp. The room
name is logged, never the full URL — it may carry a JWT or a password.

The lines below are the **state transitions**: they are meant
to be logged at INFO (everything else at DEBUG), so an operator running at INFO
sees the whole call without turning debug logging on. They are matched by
substring, so keep the wording stable.

| line | when |
|------|------|
| `joining room <room> as <name>` | the page is about to load |
| `state: waiting_in_lobby` / `state: joined` | the join phase changes |
| `conference mode: p2p\|jvb\|unknown` | once, right after joining |
| `remote audio tracks: <n>` | the number of remote audio tracks Jitsi reports changes |
| `track attached <id> name=<name> muted=<bool>` | a `MediaRecorder` started on a remote track |
| `track detached <id> reason=<left\|stopping>` | that recorder was stopped |
| `stopping: <reason>` | the mixed recording is being finalized |
| `wrote <bytes> bytes in <s>s, <n> participant(s)` | the file is on disk |

`remote audio tracks` versus `track attached` is what separates "Jitsi never
offered the track" from "attaching it failed" when a call ends with no tracks.

### Exit codes

| code | meaning |
|------|---------|
| 0 | recorded OK; file exists and is non-empty |
| 2 | bad arguments (usage on stderr) |
| 3 | never got into the conference within `--join-timeout` (incl. never admitted from the lobby), or stopped by a signal before joining |
| 4 | browser launch / page failure |
| 5 | the recording did not complete: output file missing/empty, a write error, or the audio capture died mid-call (truncated file) |

### Signals

`SIGTERM` / `SIGINT` stop gracefully: the recording is finalized, the JSON line
is printed with `"reason":"signal"` and the process exits 0. A second signal
exits immediately.

## Output format

WebM/Opus (48 kHz stereo) exactly as Chrome's `MediaRecorder` produces it — no
ffmpeg, no WAV conversion — the downstream transcriber decodes WebM/Opus itself.
`ffprobe` reports `Duration: N/A` on these files (a live MediaRecorder stream
has no seek cues); that is normal and decoders still read every frame. Use the
`duration_s` field from the JSON line.

`--out` is the **mixed** conference stream, one track for everybody.

## Per-participant tracks (`--tracks-dir`)

Purely additive: without the flag nothing below happens and the mixed-only
behaviour — including the stdout line, byte for byte — is unchanged.

With `--tracks-dir <dir>` the recorder also writes, next to the mixed file:

| file | contents |
|------|----------|
| `<dir>/<participantId>.webm` | one WebM/Opus file per remote participant, that participant's audio only (`_2`, `_3`… if the recorder had to re-attach mid-call) |
| `<dir>/tracks.jsonl` | one line per track: `{"id","name","offset_s","ended_s"}` |
| `<dir>/speakers.jsonl` | dominant-speaker timeline, one line per change: `{"t_s","id","name"}` |

and the stdout JSON gains a `tracks` array with absolute paths:

```json
{"out":"/data/audio.webm","duration_s":114.1,"reason":"empty_room","participants":["Alice","Bob"],
 "tracks":[{"id":"a1b2c3d4","name":"Alice","path":"/data/tracks/a1b2c3d4.webm","offset_s":2.104,"ended_s":113.8}]}
```

* `offset_s` — seconds between the start of the mixed recording and the moment
  this track's recorder started, so a transcript of the track can be merged into
  the meeting timeline by adding the offset.
* `ended_s` — when it stopped (the participant left, or the call ended).
* `speakers.jsonl` is the fallback for the consumer when a track is missing. It
  is not named in the stdout JSON: it lives in `--tracks-dir`, next to every
  `tracks[].path`.
* The directory is emptied at startup, the same truncate semantics `--out` has,
  so re-recording a job cannot append this call onto the previous one. For the
  same reason `--tracks-dir` is rejected when it is, or contains, the directory
  `--out` writes to.
* One participant can appear on more than one line: if Jitsi reloads the page
  mid-call the recorders restart, and each attach gets its own file and its own
  `offset_s` rather than a second WebM document appended to the first.

How it works: the same 2 s poll walks Jitsi's redux
`features/base/tracks` for remote audio tracks, and pipes each one through a
shared `AudioContext` (`MediaStreamSource` → `MediaStreamDestination`) into its
own `MediaRecorder(…, 'audio/webm;codecs=opus').start(1000)`. The AudioContext
hop matters: recording a remote track directly stalls the MediaRecorder clock
while that participant is muted, which would desynchronise the offsets. Nothing
is ever connected to `ctx.destination`, so the mixed tab capture is untouched.
Chunks cross into Node base64-encoded over `page.exposeFunction` (the bridge
carries strings only) and are appended to the file as they arrive — a chunked
MediaRecorder WebM stays playable that way, the first chunk carries the header,
so **do not re-mux**. Each chunk is labelled with the attach it came from, not
with the participant id, which is what keeps a restarted recorder out of the
previous file.

Stopping is a handshake rather than a wait: the final poll stops every recorder,
waits for each `onstop` (which fires after that recorder's last chunk) and then
for every outstanding chunk to be acknowledged by Node, so `tracks.jsonl` and
the stdout line are written over complete files. Both stages are bounded inside
the page, so a stuck recorder cannot hold up the exit.

A track only ends when its owner leaves the room. If the track itself
disappears — a mute, a P2P/bridge switch, a renegotiation — the MediaRecorder
keeps running and the new stream is swapped in underneath it, so the gap stays
in the file as silence and `offset_s` remains valid for the whole track. That
matters: a file whose gaps were cut out would put every later word early by the
length of the gap, which is exactly what merge-by-offset cannot survive.

Known limits:

* Somebody who rejoins gets a new Jitsi participant id, and therefore a second
  file; deduplicating by display name is the consumer's job.
* A participant who joined muted has no audio track yet — the poll picks them up
  when one appears, and their `offset_s` reflects that later start.
* Hidden participants (transcriber/SIP ghosts) get no track file, matching the
  way `participants[]` leaves them out.
* A track whose end event was lost with the page — only a mid-call reload does
  that — is reported as running either until the participant's next attach or to
  the end of the recording, whichever comes first. `offset_s` is exact either
  way; `ended_s` is the estimate.
* Per-participant capture is best-effort: if it cannot be set up, the failure is
  logged and the mixed recording continues alone. A participant whose recorder
  cannot be attached is skipped for the rest of the call rather than retried
  every poll, which would leak audio nodes until the renderer died.

## Environment

* `PUPPETEER_EXECUTABLE_PATH` — Chromium binary. Set in the Docker image
  (`/usr/bin/chromium`); if unset, puppeteer's own downloaded browser is used.
* Chromium is launched with `--no-sandbox` and
  `--autoplay-policy=no-user-gesture-required`. In Docker give the container
  `shm_size: 1g`, or Chromium will crash on longer calls.

`puppeteer-stream` captures through a Chrome extension, so it only works in the
**new** headless mode — the code passes `headless: 'new'` literally, which is
the only value the library honours (anything else, `true` included, silently
launches headed). If a future Chromium drops extension support in headless
mode, the fallback is `xvfb-run -a node record.js …` with `headless: false`;
that needs `xvfb` in the image, so prefer keeping new-headless working.

## Joining, lobbies and the meet.jit.si moderator wall

Join config is passed in the URL hash (`config.prejoinConfig.enabled=false`,
`startWithAudioMuted`, `startWithVideoMuted`, `userInfo.displayName`), so the
bot never clicks the UI. The join phase then polls Jitsi's internal `window.APP`
every 2 s — all of it in `readJitsiState()` and, for per-participant tracks,
`pollTracks()`; those two page-side functions are the only ones that touch
`window.APP`, so a Jitsi change stays a one-place fix. Verified against live
Jitsi on **2026-09-13**:

* `APP.conference.isJoined()` → joined
* `APP.store.getState()['features/lobby'].knocking` → parked in the lobby,
  logged as `waiting_in_lobby`
* `APP.conference.membersCount` → participant count **including** the bot
* `APP.conference.listMembers()` → remote participants only, `getDisplayName()`

Anything that is not "joined" counts as waiting until `--join-timeout` expires,
then exit 3. That deliberately covers the public **meet.jit.si** case: an
unauthenticated client creating a fresh room is put in the lobby with
`knocking: true`, `membersOnly: true` and the message *"The conference has not
yet started because no moderators have yet arrived"* — indistinguishable from a
normal lobby, and it clears the moment a human moderator arrives and admits the
bot. There is no rejected/kicked detection: Jitsi signals that only through a
transient notification, so a rejection falls through to the same timeout.

## Stopping

The record phase polls every 2 s and stops on the first of:

* `membersCount <= 1` (only the bot left) continuously for `--empty-grace`
  seconds — note that Jitsi's count can lag ~30–60 s when a participant's
  browser dies instead of leaving cleanly, so the real stop can come later than
  the grace period alone suggests;
* `--max-duration` reached;
* `SIGTERM` / `SIGINT`.

The decision itself is the pure, unit-tested `shouldStop()`.

## Tests

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
npm test        # node --check record.js && node --test
```

`parseArgs`, `buildUrl`, `roomName`, `shouldStop` and the per-track pure
helpers (`trackFile`, `applyTrackEvents`, `toJsonl`, `manifestRow`,
`resultLine`) are exported and covered. No browser is launched and no network is
touched; the browser paths are verified manually against a throwaway room.
