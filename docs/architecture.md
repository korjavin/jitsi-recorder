# Architecture: a recording bot and independent recorders

> **Canonical copy:** `korjavin/zulip-recording-bot`, `docs/architecture.md`.
> `korjavin/jitsi-recorder` and `korjavin/meet-recorder` carry a verbatim copy;
> change the canonical one first, then copy it over.

## 1. Idea

Calls are recorded on request from chat and turned into transcripts. Each
concern is its own service with its own repository, image and Compose stack:

* **orchestrators** take requests and run the work end to end — a Zulip bot
  (people ask in chat) and a Google Calendar bot (people invite it to a
  meeting);
* a **recorder** per meeting platform joins a call and writes its audio;
* the **transcriber** and **tr2outline** turn audio into a published transcript.

A recorder can be replaced, added (another platform) or redeployed without
touching the others, and any number of orchestrators can drive the same
recorders.

## 2. Services

```text
                     POST /recordings {id, url, callback_url, meta}
 zulip-recording-bot ────────────────────────────┬──> jitsi-recorder
 gcalendar-recording-bot ────────────────────────┴──> meet-recorder
 (orchestrators, independent of each other)
     ^   │                                                  │
     │   │       events (recording.*) -> callback_url       │
     │   └<─────────────────────────────────────────────────┘
     │   │
     │   └── recording.finished (§5) ──> transcriber ──> tr2outline
     │                                                        │
     └──────────── POST /notify ("transcript ready") <────────┘
```

| service | repo | owns |
|---|---|---|
| zulip-recording-bot | `korjavin/zulip-recording-bot` | Zulip events, reactions and DMs; picks a recorder by URL; job bookkeeping; recording-length policy; watchdog; hands finished recordings to the transcriber; `POST /notify` |
| gcalendar-recording-bot | `korjavin/gcalendar-recording-bot` | web page to connect a Google Calendar; records every meeting in a connected calendar that has a Meet/Jitsi link and the bot's invite address among its attendees; e-mails the person who connected the calendar; its own job bookkeeping, watchdog and transcriber hand-off |
| jitsi-recorder | `korjavin/jitsi-recorder` | joining a Jitsi room headless and writing its audio (mixed + per-participant tracks) |
| meet-recorder | `korjavin/meet-recorder` | joining a Google Meet call as a guest and writing its audio (WAV) + caption speaker hints |
| transcriber | `korjavin/transcriber` | CPU transcription of a finished recording |
| tr2outline | `korjavin/tr2outline` | publishing the transcript into Outline |

Rules:

* A recorder knows nothing about Zulip, the transcriber or Outline. It gets a
  URL, records it, and reports to the `callback_url` it was given. Anything it
  does not understand travels in `meta`, untouched.
* Orchestrators are independent of each other: each runs its jobs end to end
  (recorder events, watchdog, transcriber hand-off, `/notify`). Routing (who
  hears about a finished recording) lives in the orchestrator, never in a
  recorder's config. They share no code; duplication is accepted on purpose.
* Job ids are unique across orchestrators, because recorders and the
  transcriber key directories by them: the Zulip bot uses the Zulip message id,
  the calendar bot `cal-<hash>`.
* The recorders share no code and no image. They implement the same contract
  (§3); duplication between them is accepted on purpose.

## 3. Recorder contract

A recorder is a single Node process: an HTTP server plus Puppeteer in the same
process. Chromium is a child of that process, as Puppeteer always runs it.

### 3.1 Authentication

Every request in both directions carries

```text
x-recorder-signature: sha256=<lowercase hex HMAC-SHA256(raw body, RECORDER_SECRET)>
```

A `GET` signs the empty body. A missing or wrong signature is `401`. An empty
`RECORDER_SECRET` refuses to start. Recorders are not published through
Traefik: the bot reaches them over the shared Docker network.

### 3.2 `POST /recordings`

```json
{
  "id": "123456789",
  "url": "https://meet.jit.si/SomeRoom",
  "callback_url": "http://zulip-recording-bot:8080/events",
  "meta": {"anything": "the caller wants back"},
  "display_name": "NoteTaker",
  "join_timeout_s": 600,
  "max_duration_s": 14400,
  "empty_grace_s": 60
}
```

* `id` — chosen by the caller, `^[A-Za-z0-9_-]{1,64}$` (it becomes a directory
  name). Required.
* `url`, `callback_url` — required. `url` must match the recorder's allowlist
  (`JITSI_BASE_URL` for Jitsi; `https://meet.google.com/<code>` for Meet), so a
  recorder never becomes an open headless browser.
* `meta` — optional JSON object, echoed back verbatim in every event.
* the rest — optional, defaulting to the recorder's env.

Responses:

* `202 {"id", "state"}` — accepted and started.
* `200 {"id", "state"}` — a job with this `id` already exists (idempotent
  retry); nothing new is started.
* `400` bad body or `id` · `401` bad signature · `422` URL not allowed.

### 3.3 `GET /recordings/{id}`

`200` with the job record (§3.6) or `404`. The bot's watchdog uses it.

### 3.4 `GET /health`

`200 {"status":"ok"}`, unsigned, no dependency checks.

### 3.5 Events

`POST <callback_url>`, signed as in §3.1, plus `x-recorder-event: <event>`.

Every event:

```json
{
  "event": "recording.finished",
  "id": "123456789",
  "source": "jitsi",
  "url": "https://meet.jit.si/SomeRoom",
  "meta": {"anything": "the caller wants back"},
  "at": "2026-01-01T10:30:34Z"
}
```

| event | when | delivery |
|---|---|---|
| `recording.waiting_admission` | first time the bot sits in a lobby / knocks | best effort, once |
| `recording.started` | admitted; audio is being written | best effort, once |
| `recording.finished` | a recording finished and files are on disk | guaranteed |
| `recording.failed` | anything else that ends a job | guaranteed |

`recording.finished` adds:

```json
{
  "started_at": "2026-01-01T10:00:00Z",
  "ended_at": "2026-01-01T10:30:34Z",
  "duration_s": 1834.2,
  "reason": "empty_room",
  "participants": ["Alice", "Bob"],
  "artifacts": [
    {"kind": "audio", "path": "/data/jitsi/123456789/audio.webm", "format": "webm"},
    {"kind": "track", "path": "/data/jitsi/123456789/tracks/p1.webm", "participant_id": "p1", "name": "Alice", "offset_s": 0, "ended_s": 1834.2},
    {"kind": "speakers", "path": "/data/jitsi/123456789/tracks/speakers.jsonl"},
    {"kind": "captions", "path": "/data/meet/123456789/captions.jsonl"}
  ]
}
```

* `reason` — `empty_room` | `max_duration` | `signal` | `ended` | `removed`.
* `artifacts` — exactly one `audio`; `track` / `speakers` only from Jitsi,
  `captions` only from Meet, each only when it exists. Consumers must ignore
  unknown kinds.
* `duration_s` is the real audio length. The recorder does **not** judge
  whether a recording is too short; that policy is the bot's.

`recording.failed` adds `"error"` and, when any audio reached the disk,
`"artifacts"` (the partial recording is kept, never deleted):

| `error` | meaning |
|---|---|
| `not_admitted` | never got into the call within `join_timeout_s` (denied, nobody there, invalid meeting) |
| `recorder_failed` | browser launch or page failure, or the capture died mid-call |
| `interrupted` | the recorder process died or restarted during the job (§4) |

Guaranteed delivery: the event is written to the job directory before the
first attempt, retried on `5 s, 15 s, 45 s, 2 min, 5 min`, then by an hourly
sweep and after every restart, until the receiver answers `2xx`. Receivers
must be idempotent on `(id, event)`. Redirects are not followed.

### 3.6 Disk layout and job record

```text
DATA_DIR/<id>/job.json        # written atomically (temp file + rename)
DATA_DIR/<id>/audio.webm      # Jitsi; Meet writes audio.wav
DATA_DIR/<id>/tracks/         # Jitsi per-participant files, speakers.jsonl
DATA_DIR/<id>/captions.jsonl  # Meet speaker hints
DATA_DIR/<id>/outbox/         # undelivered guaranteed events
```

`job.json`: the request (`id`, `url`, `callback_url`, `meta`, options),
`state` (`joining` | `recording` | `finished` | `failed`), `error`, timings,
`participants`, `artifacts`, and which events are delivered.

Audio is written to disk **incrementally** while the call runs, never only at
the end, so a crash keeps everything recorded up to that moment.

## 4. Failure handling

A crash must end in a message to the user, never in silence, and must never
lose audio that was already written.

**Recorder side.**

* Chromium dies or the page breaks → the Node process is still alive, finishes
  the job as `recorder_failed` with whatever audio exists, sends the event.
* The Node process dies (OOM, kill, redeploy) → the container restarts
  (`restart: unless-stopped`). On startup every job in `joining`/`recording`
  becomes `failed` / `interrupted`, its partial audio is made readable (Meet:
  rewrite the WAV header sizes from the file length; Jitsi: a chunked WebM is
  already playable) and listed in `artifacts`, and `recording.failed` goes to
  the stored `callback_url`.
* `SIGTERM` (redeploy) stops recordings gracefully as `finished` with
  `reason: "signal"`; `stop_grace_period: 120s` gives it time.

**Bot side (watchdog).** The bot knows each job's deadline:
`join_timeout_s + max_duration_s + 10 min`. A job with no terminal event by
then is checked with `GET /recordings/{id}`: still running → check again
later; finished/failed → take the result from the record (the event was lost);
`404` or unreachable three checks in a row → the bot marks it failed (`lost`)
and tells the user.

**Delivery.** Both directions retry with a persisted outbox, so a peer being
redeployed costs a delay, never an event.

## 5. Orchestrator ↔ transcriber

The transcriber's inbound interface is fixed by the transcriber
(`korjavin/transcriber`, README "Input"); every orchestrator speaks it as is.

On `recording.finished`, after its own policy (shorter than `MIN_RECORDING_S`
→ a "too short" note, nothing sent), the orchestrator sends
`POST <WEBHOOK_URL>`:

```text
x-jitsi-capture-event: recording.finished
x-jitsi-capture-signature: sha256=<hex HMAC-SHA256(raw body, WEBHOOK_SECRET)>
```

```json
{
  "event": "recording.finished",
  "id": "123456789",
  "title": "Weekly sync",
  "message_id": 123456789,
  "stream": "some-stream",
  "topic": "some topic",
  "dm_user_id": 42,
  "jitsi_url": "https://meet.jit.si/SomeRoom",
  "source": "meet",
  "audio_path": "/data/jitsi/123456789/audio.webm",
  "duration_s": 1834.2,
  "started_at": "2026-01-01T10:00:00Z",
  "ended_at": "2026-01-01T10:30:34Z",
  "participants": ["Alice", "Bob"],
  "callback_url": "http://zulip-recording-bot:8080/notify",
  "tracks": [{"id": "p1", "name": "Alice", "path": "/data/jitsi/123456789/tracks/p1.webm", "offset_s": 0, "ended_s": 1834.2}],
  "speaker_hints_path": "/data/meet/123456789/captions.jsonl"
}
```

Mapping from the event: `audio_path` ← the `audio` artifact; `tracks` ←
`track` artifacts (`id` ← `participant_id`); `speaker_hints_path` ← the
`captions` artifact; `jitsi_url` ← `url` (any platform — the field name is the
transcriber's); `source` is `"meet"` for Meet and omitted for Jitsi;
`title` is the Outline document title (the calendar event's summary; the
Zulip bot omits it and the transcriber falls back to `topic`); `message_id` /
`stream` / `topic` / `dm_user_id` are Zulip-only and omitted by other
orchestrators; `dm_user_id` only for a DM-started job (then `stream`/`topic`
are empty);
`tracks` / `speaker_hints_path` only when present. Delivery retries like §3.5;
the transcriber is idempotent on `id`.

When the transcript is published, tr2outline calls back:

```http
POST /notify
x-jitsi-capture-signature: sha256=<hex HMAC-SHA256(raw body, WEBHOOK_SECRET)>

{"id": "123456789", "content": "Transcript ready: <link>"}
```

The Zulip bot posts `content` verbatim into the job's stream/topic or DM; the
calendar bot e-mails it to the person who connected the calendar. Responses:
`200` · `400` missing fields · `401` bad signature · `404` unknown job · `502`
Zulip refused the message.

## 6. Storage

One shared Docker named volume holds every recording. Its name comes from
`RECORDINGS_VOLUME` (default `recordings`); create it once with
`docker volume create <name>`. Every stack that touches audio mounts it
`external: true` at `/data`:

* jitsi-recorder writes under `DATA_DIR=/data/jitsi`;
* meet-recorder writes under `DATA_DIR=/data/meet`;
* the transcriber reads the paths from the webhook as they are.

Orchestrators do not mount it: each keeps only its own job state, in its own
volume.

Recordings are kept: recorders delete nothing. Later: move audio to
S3-compatible storage and pass object URLs instead of paths; the contract then
changes only in `artifacts[].path` → `artifacts[].url`.

## 7. Not now

* A `stop` endpoint (`POST /recordings/{id}/stop`) — add when a user command
  needs it.
* Concurrency limits per recorder — add when RAM becomes the bottleneck
  (~400–800 MB per Chromium).
* Other front-ends (Telegram).
* One meeting requested through two orchestrators gets two NoteTakers: they
  share no state. Later a recorder could refuse a second job for a URL it is
  already recording.
