# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
# PUPPETEER_SKIP_DOWNLOAD=1 avoids a ~150MB Chrome download
PUPPETEER_SKIP_DOWNLOAD=1 npm ci && npm test
docker build -t jitsi-recorder .
```

Unit tests must pass offline: no network, no real meeting. Use `node:test`,
a local `http.createServer` for HTTP boundaries, and stub the browser.

## Architecture Overview

Records a **Jitsi** room on request: joins headless (Puppeteer + Chromium, `puppeteer-stream`), writes the mixed audio as WebM/Opus plus per-participant tracks, reports via signed events to the caller's `callback_url`.

It is one Node process: an HTTP server and Puppeteer together (no Go wrapper,
no subprocess protocol). **`docs/architecture.md` is the spec** — the HTTP API,
events, artifacts, disk layout and failure handling in §3–§4 are a contract
shared with `zulip-recording-bot` (the orchestrator) and the other recorder.
Do not change it here; the canonical copy lives in `korjavin/zulip-recording-bot`.

This service knows nothing about Zulip, the transcriber or Outline. It gets a
URL, records it, reports to the `callback_url` it was given, and echoes `meta`
untouched.

Docker needs `shm_size: 1g` for Chromium.

## Conventions & Patterns

- **English only** in every public artifact: README, docs, code comments,
  commit messages, PR bodies, `.env.example`.
- **Public repo:** never commit real domains, emails, keys, room names or user
  data. Use placeholders (`example.com`, `SomeRoom`).
- Configuration is env-only, read in one place (`config.js`). Never log
  secrets — log the variable NAME. Never log a full meeting URL (it may carry a
  token); log the room name / meeting code.
- No new npm dependencies beyond `puppeteer` (+ `puppeteer-stream` for Jitsi)
  without a reason in the PR. Node stdlib (`node:http`, `node:crypto`,
  `node:test`) covers the server, HMAC and tests.
- Recordings are never deleted by default; partial audio after a failure is
  kept and reported.
- Docs describe this service as designed from scratch: never reference the
  repositories or code it was derived from. Bead descriptions may name a source
  to copy from; the README and docs must not.
