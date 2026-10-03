# jitsi-recorder

Records a Jitsi room on request: joins headless (Puppeteer + Chromium), writes
the mixed audio as WebM/Opus plus per-participant tracks, and reports progress
as signed events to the `callback_url` it was given.

* [docs/architecture.md](docs/architecture.md) — the service contract (HTTP
  API, events, artifacts, disk layout).
* [docs/recording.md](docs/recording.md) — how recording works: joining,
  lobbies, stop rules, per-participant tracks.

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci && npm test
docker build -t jitsi-recorder .
```

## API

Every request except `GET /health` carries
`x-recorder-signature: sha256=<hex HMAC-SHA256(raw body, RECORDER_SECRET)>`
(a `GET` signs the empty body). Events to the `callback_url` are signed the
same way. The full contract is in [docs/architecture.md](docs/architecture.md)
§3–§4.

| request | result |
|---|---|
| `POST /recordings` `{id, url, callback_url, meta?, display_name?, join_timeout_s?, max_duration_s?, empty_grace_s?}` | `202` started · `200` already exists · `400` · `401` · `422` URL not under `JITSI_BASE_URL` |
| `GET /recordings/{id}` | `200` job record · `404` |
| `GET /health` | `200 {"status":"ok"}` |

Events: `recording.waiting_admission`, `recording.started` (best effort),
`recording.finished`, `recording.failed` (guaranteed, retried until `2xx`).

## Configuration

Environment only (see [.env.example](.env.example)):

| variable | default | meaning |
|---|---|---|
| `RECORDER_SECRET` | — (required) | HMAC secret shared with the caller |
| `JITSI_BASE_URL` | `https://meet.jit.si` | only meeting URLs under this base are recorded |
| `DATA_DIR` | `/data/jitsi` | where recordings go; fixed in `docker-compose.yml` |
| `PORT` | `8080` | HTTP port |
| `BOT_DISPLAY_NAME` | `NoteTaker` | name shown in the call |
| `JOIN_TIMEOUT_S` | `600` | fail as `not_admitted` after this |
| `MAX_DURATION_S` | `14400` | hard cap on one recording |
| `EMPTY_GRACE_S` | `60` | stop this long after the bot is alone |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `error` |
| `RECORDINGS_VOLUME` | `recordings` | Compose only: the shared recordings volume |
| `TRAEFIK_NETWORK_NAME` | `traefik` | Compose only: the external network shared with the caller |

## Deploy

The service is internal: no published ports, no Traefik labels. The caller
reaches it as `http://jitsi-recorder:8080` over the shared Docker network.

1. Once per host: `docker volume create recordings` (or the name you set in
   `RECORDINGS_VOLUME`) and make sure the external network exists.
2. A push to `master` runs `.github/workflows/deploy.yml`: it builds and pushes
   `ghcr.io/<owner>/jitsi-recorder:<sha>`, rewrites the image tag in
   `docker-compose.yml` on the `deploy` branch, and calls the
   `PORTAINER_REDEPLOY_HOOK` secret when it is set.
3. In Portainer, create a git stack from this repo, branch `deploy`, compose
   file `docker-compose.yml`, with the variables from `.env.example` set in the
   stack environment, and enable its redeploy webhook. Store that webhook URL
   as the `PORTAINER_REDEPLOY_HOOK` repository secret.

Locally: `cp .env.example .env && docker compose config -q && docker compose up -d`.

## Smoke test

Record a throwaway room (replace `SomeRoom`; the URL must be under
`JITSI_BASE_URL`). Start a sink that prints the events, on the same network:

```bash
docker run --rm -d --name event-sink --network traefik node:22-alpine node -e \
  "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(q.headers['x-recorder-event'],b);s.end()})}).listen(9000)"
```

Sign and send the request (`SECRET` is your `RECORDER_SECRET`):

```bash
SECRET=change-me
BODY='{"id":"smoke-1","url":"https://meet.example.com/SomeRoom","callback_url":"http://event-sink:9000/events","empty_grace_s":30}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
docker run --rm --network traefik curlimages/curl -s -X POST http://jitsi-recorder:8080/recordings \
  -H 'content-type: application/json' -H "x-recorder-signature: sha256=$SIG" -d "$BODY"
```

Expect `202`. Join the room, talk, leave; `docker logs -f event-sink` shows
`recording.started` and then `recording.finished` with the artifact paths. To
poll the job, sign the empty body:

```bash
SIG=$(printf '' | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
docker run --rm --network traefik curlimages/curl -s http://jitsi-recorder:8080/recordings/smoke-1 \
  -H "x-recorder-signature: sha256=$SIG"
```

Finally `docker rm -f event-sink`. The recording stays in the volume under
`/data/jitsi/smoke-1/`; nothing is deleted automatically.
