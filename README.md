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
