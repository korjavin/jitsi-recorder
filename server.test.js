'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { loadConfig } = require('./config');
const { createServer, sign, errorCode } = require('./server');

const SECRET = 'test-secret';

/** A server on a random port over a temp DATA_DIR, with record() stubbed. */
async function start(t, record) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
  const config = loadConfig({ RECORDER_SECRET: SECRET, DATA_DIR: dataDir, JITSI_BASE_URL: 'https://meet.example.com' });
  const calls = [];
  const events = [];
  const server = createServer({
    config,
    record: (opts) => {
      calls.push(opts);
      return record(opts);
    },
    emit: (job, event) => events.push(event),
    log: () => {},
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, body, sig) => {
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = {};
    if (sig !== null) headers['x-recorder-signature'] = sig ?? sign(raw, SECRET);
    return fetch(base + p, { method, headers, body: method === 'GET' ? undefined : raw });
  };
  return { req, calls, events, dataDir };
}

const body = (over = {}) => ({
  id: 'job1',
  url: 'https://meet.example.com/SomeRoom',
  callback_url: 'http://bot.example.com:8080/events',
  meta: { k: 'v' },
  ...over,
});

const never = () => new Promise(() => {});

async function waitState(req, id, state) {
  for (let i = 0; i < 100; i++) {
    const job = await (await req('GET', `/recordings/${id}`)).json();
    if (job.state === state) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} never reached ${state}`);
}

test('config refuses an empty RECORDER_SECRET and applies defaults', () => {
  assert.throws(() => loadConfig({}), /RECORDER_SECRET/);
  assert.throws(() => loadConfig({ RECORDER_SECRET: '' }), /RECORDER_SECRET/);
  const c = loadConfig({ RECORDER_SECRET: 's' });
  assert.equal(c.jitsiBase.origin, 'https://meet.jit.si');
  assert.equal(c.dataDir, '/data/jitsi');
  assert.equal(c.port, 8080);
  assert.throws(() => loadConfig({ RECORDER_SECRET: 's', PORT: 'abc' }), /PORT/);
});

test('health is unsigned', async (t) => {
  const { req } = await start(t, never);
  const r = await req('GET', '/health', undefined, null);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok' });
});

test('signature: missing and wrong are 401, good is 202', async (t) => {
  const { req, calls } = await start(t, never);
  assert.equal((await req('POST', '/recordings', body(), null)).status, 401);
  assert.equal((await req('POST', '/recordings', body(), sign('other', SECRET))).status, 401);
  assert.equal((await req('POST', '/recordings', body(), 'sha256=00')).status, 401);
  assert.equal((await req('GET', '/recordings/job1', undefined, null)).status, 401);
  assert.equal(calls.length, 0);
  const r = await req('POST', '/recordings', body());
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { id: 'job1', state: 'joining' });
});

test('validation: bad id, path traversal, foreign URL, bad body', async (t) => {
  const { req, calls, dataDir } = await start(t, never);
  const status = async (b) => (await req('POST', '/recordings', b)).status;
  assert.equal(await status(body({ id: '../etc' })), 400);
  assert.equal(await status(body({ id: 'a/b' })), 400);
  assert.equal(await status(body({ id: 'x'.repeat(65) })), 400);
  assert.equal(await status(body({ id: undefined })), 400);
  assert.equal(await status(body({ callback_url: 'ftp://x' })), 400);
  assert.equal(await status(body({ meta: [1] })), 400);
  assert.equal(await status(body({ join_timeout_s: -1 })), 400);
  assert.equal(await status('not json'), 400);
  assert.equal(await status(body({ url: 'https://evil.example.com/SomeRoom' })), 422);
  assert.equal(await status(body({ url: 'https://meet.example.com.evil.example/SomeRoom' })), 422);
  assert.equal(await status(body({ url: 'https://meet.example.com/' })), 422);
  assert.equal(await status(body({ url: 'http://meet.example.com/SomeRoom' })), 422);
  assert.equal(await status(body({ url: 'https://user@meet.example.com/SomeRoom' })), 422);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  assert.equal((await req('GET', '/recordings/..%2Fetc')).status, 404);
});

test('repeating an id returns 200 with the existing job and starts nothing', async (t) => {
  const { req, calls } = await start(t, never);
  assert.equal((await req('POST', '/recordings', body())).status, 202);
  const r = await req('POST', '/recordings', body({ url: 'https://meet.example.com/Other' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 'job1', state: 'joining' });
  assert.equal(calls.length, 1);
});

test('an unreadable job.json fails closed and keeps the audio', async (t) => {
  const { req, calls, dataDir } = await start(t, never);
  const dir = path.join(dataDir, 'job1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'job.json'), '{broken');
  fs.writeFileSync(path.join(dir, 'audio.webm'), 'kept');
  assert.equal((await req('POST', '/recordings', body())).status, 500);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'audio.webm'), 'utf8'), 'kept');
});

test('GET: 404 for unknown, 200 with the job record', async (t) => {
  const { req, calls, dataDir } = await start(t, never);
  assert.equal((await req('GET', '/recordings/nope')).status, 404);
  await req('POST', '/recordings', body({ max_duration_s: 60 }));
  const r = await req('GET', '/recordings/job1');
  assert.equal(r.status, 200);
  const job = await r.json();
  assert.equal(job.state, 'joining');
  assert.deepEqual(job.meta, { k: 'v' });
  assert.equal(job.options.max_duration_s, 60);
  assert.equal(job.options.join_timeout_s, 600);
  assert.equal(calls[0].out, path.join(dataDir, 'job1', 'audio.webm'));
  assert.equal(calls[0].maxDurationS, 60);
});

test('a finished job lists its artifacts with absolute paths', async (t) => {
  const { req, events, dataDir } = await start(t, async (o) => {
    o.onState('waiting_in_lobby');
    o.onState('joined');
    fs.writeFileSync(o.out, 'audio');
    fs.mkdirSync(o.tracksDir, { recursive: true });
    const track = path.join(o.tracksDir, 'p1.webm');
    fs.writeFileSync(track, 'x');
    fs.writeFileSync(path.join(o.tracksDir, 'speakers.jsonl'), '{}\n');
    const tracks = [{ id: 'p1', name: 'Alice', path: track, offset_s: 0, ended_s: 1.5 }];
    return { durationS: 1.5, reason: 'empty_room', participants: ['Alice'], tracks };
  });
  await req('POST', '/recordings', body());
  const job = await waitState(req, 'job1', 'finished');
  const dir = path.join(dataDir, 'job1');
  assert.equal(job.reason, 'empty_room');
  assert.ok(job.started_at);
  assert.deepEqual(job.participants, ['Alice']);
  assert.deepEqual(job.artifacts, [
    { kind: 'audio', path: path.join(dir, 'audio.webm'), format: 'webm' },
    {
      kind: 'track',
      path: path.join(dir, 'tracks', 'p1.webm'),
      participant_id: 'p1',
      name: 'Alice',
      offset_s: 0,
      ended_s: 1.5,
    },
    { kind: 'speakers', path: path.join(dir, 'tracks', 'speakers.jsonl') },
  ]);
  assert.deepEqual(events, ['recording.waiting_admission', 'recording.started', 'recording.finished']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audio.webm', 'job.json', 'tracks']);
});

test('a failed job keeps partial audio and its error code', async (t) => {
  const { req, events } = await start(t, async (o) => {
    o.onState('joined');
    fs.writeFileSync(o.out, 'partial');
    throw Object.assign(new Error('capture died'), { code: 'recorder_failed', durationS: 3, tracks: null });
  });
  await req('POST', '/recordings', body());
  const job = await waitState(req, 'job1', 'failed');
  assert.equal(job.error, 'recorder_failed');
  assert.equal(job.artifacts.length, 1);
  assert.equal(job.artifacts[0].kind, 'audio');
  assert.deepEqual(events, ['recording.started', 'recording.failed']);
});

test('not_admitted: join timeout stays, abort before joining is interrupted', () => {
  const err = Object.assign(new Error('x'), { code: 'not_admitted' });
  assert.equal(errorCode(err, new AbortController().signal), 'not_admitted');
  assert.equal(errorCode(err, AbortSignal.abort()), 'interrupted');
  assert.equal(errorCode(new Error('boom'), AbortSignal.abort()), 'recorder_failed');
});
