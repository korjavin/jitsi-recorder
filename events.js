'use strict';

// Events to callback_url (docs/architecture.md §3.5). Best-effort events get
// one attempt. Guaranteed events are written to DATA_DIR/<id>/outbox/ before
// the first attempt, retried on BACKOFF, then by the hourly sweep and on
// startup until the receiver answers 2xx.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const GUARANTEED = new Set(['recording.finished', 'recording.failed']);
// ponytail: fixed table, same as jitsi2outline/webhook.go; the sweep covers the rest.
const BACKOFF_MS = [5e3, 15e3, 45e3, 120e3, 300e3];
const SWEEP_MS = 3600e3;
const TIMEOUT_MS = 30e3;

const sign = (body, secret) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

const isoSecond = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Envelope plus the per-event fields of §3.5. */
function payload(job, event, at = isoSecond()) {
  const p = { event, id: job.id, source: 'jitsi', url: job.url, meta: job.meta ?? null, at };
  if (event === 'recording.finished') {
    Object.assign(p, {
      started_at: job.started_at,
      ended_at: job.ended_at,
      duration_s: job.duration_s,
      reason: job.reason,
      participants: job.participants ?? [],
      artifacts: job.artifacts ?? [],
    });
  } else if (event === 'recording.failed') {
    p.error = job.error;
    if (job.artifacts?.length) p.artifacts = job.artifacts;
  }
  return p;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function createEvents({ config, log, backoffMs = BACKOFF_MS, sweepMs = SWEEP_MS }) {
  const dataDir = path.resolve(config.dataDir);
  const outboxFile = (id, event) => path.join(dataDir, id, 'outbox', `${event}.json`);
  // Outbox files with a delivery loop running, so the sweep does not double up.
  const busy = new Set();
  const ac = new AbortController();
  let timer = null;

  /** One POST; true on 2xx. A 3xx is a failure: redirects are not followed. */
  async function post(url, event, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-recorder-event': event,
          'x-recorder-signature': sign(body, config.secret),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => {});
      if (res.ok) return true;
      return `status ${res.status}`;
    } catch (e) {
      return e.cause?.code || e.name || 'error';
    }
  }

  /** Record a delivered guaranteed event in job.json, then drop it from the outbox. */
  function delivered(id, event, file) {
    const jobFile = path.join(dataDir, id, 'job.json');
    try {
      const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
      job.events_delivered = [...new Set([...(job.events_delivered || []), event])];
      writeAtomic(jobFile, `${JSON.stringify(job, null, 2)}\n`);
    } catch (e) {
      log('error', `job ${id}: cannot record delivery of ${event} in job.json: ${e.message}`);
    }
    fs.rmSync(file, { force: true });
  }

  /** Deliver one outbox file; with retry, walk the backoff table first. */
  async function drain(file, retry) {
    if (busy.has(file)) return;
    busy.add(file);
    try {
      const { id, event, callback_url: url, body } = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (let i = 0; ; i++) {
        const r = await post(url, event, body);
        if (r === true) {
          log('info', `job ${id}: ${event} delivered`);
          return delivered(id, event, file);
        }
        if (!retry || i >= backoffMs.length) {
          log('error', `job ${id}: ${event} not delivered (${r}); kept in outbox`);
          return;
        }
        log('info', `job ${id}: ${event} attempt ${i + 1} failed (${r}); retrying`);
        await sleep(backoffMs[i], null, { signal: ac.signal, ref: false });
      }
    } catch (e) {
      if (e.name !== 'AbortError') log('error', `outbox ${path.relative(dataDir, file)}: ${e.message}`);
    } finally {
      busy.delete(file);
    }
  }

  /** Called by the server when a job reaches a state worth an event. */
  function emit(job, event) {
    const body = JSON.stringify(payload(job, event));
    if (!GUARANTEED.has(event)) {
      post(job.callback_url, event, body).then((r) => {
        if (r !== true) log('error', `job ${job.id}: ${event} not delivered (${r}); best effort, dropped`);
      });
      return;
    }
    const file = outboxFile(job.id, event);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify({ id: job.id, event, callback_url: job.callback_url, body }));
    drain(file, true);
  }

  /** One attempt at every outbox file under DATA_DIR. */
  async function sweep() {
    let ids;
    try {
      ids = fs.readdirSync(dataDir);
    } catch {
      return;
    }
    const files = [];
    for (const id of ids) {
      let names;
      try {
        names = fs.readdirSync(path.join(dataDir, id, 'outbox'));
      } catch {
        continue;
      }
      for (const n of names) if (n.endsWith('.json')) files.push(path.join(dataDir, id, 'outbox', n));
    }
    await Promise.all(files.map((f) => drain(f, false)));
  }

  /** Sweep now (startup) and then every sweepMs. */
  function start() {
    sweep();
    timer = setInterval(sweep, sweepMs);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
    ac.abort();
  }

  return { emit, sweep, start, stop };
}

module.exports = { createEvents, payload, sign };
