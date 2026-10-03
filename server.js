'use strict';

// HTTP API and job store (docs/architecture.md §3.1–§3.4, §3.6): one process,
// node:http + node:crypto, record() running in the background per job.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, LEVELS } = require('./config');
const recorder = require('./record');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 64 * 1024;
const OPTIONS = {
  join_timeout_s: 'joinTimeoutS',
  max_duration_s: 'maxDurationS',
  empty_grace_s: 'emptyGraceS',
};

const sign = (body, secret) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

/** Constant-time check of x-recorder-signature over the raw body. */
function verify(header, body, secret) {
  if (typeof header !== 'string') return false;
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(header);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** True when `raw` is a room URL under the JITSI_BASE_URL allowlist. */
function allowedUrl(raw, base) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.origin !== base.origin || u.username || u.password) return false;
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return u.pathname.startsWith(prefix) && u.pathname.length > prefix.length;
}

function isHttpUrl(raw) {
  try {
    return /^https?:$/.test(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/** Returns an error message for a bad request body, or null. */
function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object';
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return 'bad id';
  if (typeof b.url !== 'string') return 'url is required';
  if (typeof b.callback_url !== 'string' || !isHttpUrl(b.callback_url)) return 'bad callback_url';
  if (b.meta != null && (typeof b.meta !== 'object' || Array.isArray(b.meta))) return 'meta must be an object';
  if (b.display_name != null && (typeof b.display_name !== 'string' || !b.display_name.trim())) {
    return 'bad display_name';
  }
  for (const k of Object.keys(OPTIONS)) {
    if (b[k] != null && !(typeof b[k] === 'number' && Number.isFinite(b[k]) && b[k] > 0)) return `bad ${k}`;
  }
  return null;
}

const fileSize = (p) => {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    return 0;
  }
};

/** §3.5 artifacts: one audio, then tracks and speakers — none without audio. */
function artifacts(dir, tracks) {
  const audio = path.join(dir, 'audio.webm');
  if (fileSize(audio) === 0) return [];
  const list = [{ kind: 'audio', path: audio, format: 'webm' }];
  for (const t of tracks || []) {
    list.push({
      kind: 'track',
      path: t.path,
      participant_id: t.id,
      name: t.name,
      offset_s: t.offset_s,
      ended_s: t.ended_s,
    });
  }
  const speakers = path.join(dir, 'tracks', 'speakers.jsonl');
  if (fileSize(speakers) > 0) list.push({ kind: 'speakers', path: speakers });
  return list;
}

/**
 * record() rejects with not_admitted both on a join timeout and when aborted
 * before joining. The only abort is process shutdown (redeploy), and a job the
 * process stops before it ever joined is `interrupted` (§3.5, §4), not a
 * meeting that refused us.
 */
function errorCode(err, signal) {
  if (err?.code === 'not_admitted') return signal.aborted ? 'interrupted' : 'not_admitted';
  return 'recorder_failed';
}

function createServer({
  config,
  record = recorder.record,
  emit = (job, event) => log('info', `${event} for job ${job.id} (delivery not wired yet)`),
  log = makeLog(config.logLevel),
}) {
  const dataDir = path.resolve(config.dataDir);
  const jobDir = (id) => path.join(dataDir, id);
  const jobFile = (id) => path.join(jobDir(id), 'job.json');
  // Abort handles of running jobs, for graceful shutdown.
  const running = new Map();

  const load = (id) => {
    try {
      return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') log('error', `job ${id}: cannot read job.json: ${e.message}`);
      return null;
    }
  };
  // Synchronous temp file + rename: a reader never sees half a job.json, and
  // no await sits between "does it exist" and "write it" in POST.
  const save = (job) => {
    const file = jobFile(job.id);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`);
    fs.renameSync(tmp, file);
  };
  const trySave = (job) => {
    try {
      save(job);
    } catch (e) {
      log('error', `job ${job.id}: cannot write job.json: ${e.message}`);
    }
  };
  const fire = (job, event) => {
    try {
      emit(job, event);
    } catch (e) {
      log('error', `job ${job.id}: emit ${event} threw: ${e.message}`);
    }
  };

  async function run(job) {
    const dir = jobDir(job.id);
    const ac = new AbortController();
    running.set(job.id, ac);
    const room = recorder.roomName(job.url);
    let lobbySent = false;
    try {
      const res = await record({
        url: job.url,
        out: path.join(dir, 'audio.webm'),
        tracksDir: path.join(dir, 'tracks'),
        displayName: job.options.display_name,
        joinTimeoutS: job.options.join_timeout_s,
        maxDurationS: job.options.max_duration_s,
        emptyGraceS: job.options.empty_grace_s,
        signal: ac.signal,
        log: (msg) => log('info', `job ${job.id}: ${msg}`),
        onState: (state) => {
          if (state === 'waiting_in_lobby' && !lobbySent) {
            lobbySent = true;
            fire(job, 'recording.waiting_admission');
          } else if (state === 'joined') {
            job.state = 'recording';
            job.started_at = new Date().toISOString();
            trySave(job);
            fire(job, 'recording.started');
          }
        },
      });
      Object.assign(job, {
        state: 'finished',
        ended_at: new Date().toISOString(),
        duration_s: res.durationS,
        reason: res.reason,
        participants: res.participants,
        artifacts: artifacts(dir, res.tracks),
      });
      trySave(job);
      log('info', `job ${job.id}: finished in room ${room} (${res.reason})`);
      fire(job, 'recording.finished');
    } catch (e) {
      Object.assign(job, {
        state: 'failed',
        error: errorCode(e, ac.signal),
        error_message: e.message,
        ended_at: new Date().toISOString(),
        duration_s: e.durationS ?? null,
        participants: e.participants ?? job.participants,
        // Partial audio is kept and reported, never deleted.
        artifacts: artifacts(dir, e.tracks),
      });
      trySave(job);
      log('error', `job ${job.id}: failed in room ${room}: ${job.error}`);
      fire(job, 'recording.failed');
    } finally {
      running.delete(job.id);
    }
  }

  function create(b) {
    const existing = load(b.id);
    if (existing) return [200, existing];
    const options = { display_name: b.display_name ?? config.displayName };
    for (const [k, c] of Object.entries(OPTIONS)) options[k] = b[k] ?? config[c];
    const job = {
      id: b.id,
      url: b.url,
      callback_url: b.callback_url,
      meta: b.meta ?? null,
      options,
      state: 'joining',
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      duration_s: null,
      reason: null,
      participants: [],
      artifacts: [],
      events_delivered: [],
    };
    fs.mkdirSync(jobDir(b.id), { recursive: true });
    save(job);
    log('info', `job ${job.id}: accepted for room ${recorder.roomName(job.url)}`);
    run(job).catch((e) => log('error', `job ${job.id}: ${e.message}`));
    return [202, job];
  }

  async function handle(req, res) {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && pathname === '/health') return send(200, { status: 'ok' });

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return send(413, { error: 'body too large' });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks);
    if (!verify(req.headers['x-recorder-signature'], raw, config.secret)) {
      return send(401, { error: 'bad signature' });
    }

    if (req.method === 'POST' && pathname === '/recordings') {
      let b;
      try {
        b = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(400, { error: 'body must be JSON' });
      }
      const bad = validate(b);
      if (bad) return send(400, { error: bad });
      if (!allowedUrl(b.url, config.jitsiBase)) return send(422, { error: 'url not allowed' });
      const [code, job] = create(b);
      return send(code, { id: job.id, state: job.state });
    }

    const m = pathname.match(/^\/recordings\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const job = ID_RE.test(m[1]) ? load(m[1]) : null;
      return job ? send(200, job) : send(404, { error: 'not found' });
    }
    return send(404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('error', `request failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    });
  });
  server.running = running;
  return server;
}

function makeLog(level = 'info') {
  const min = LEVELS.indexOf(level);
  return (lvl, msg) => {
    if (LEVELS.indexOf(lvl) >= min) process.stderr.write(`${new Date().toISOString()} ${lvl} ${msg}\n`);
  };
}

module.exports = { createServer, sign, verify, allowedUrl, validate, artifacts, errorCode };

if (require.main === module) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`config: ${e.message}\n`);
    process.exit(1);
  }
  const log = makeLog(config.logLevel);
  createServer({ config, log }).listen(config.port, () => log('info', `listening on :${config.port}`));
}
