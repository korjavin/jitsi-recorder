'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createEvents } = require('./events');
const { verify } = require('./server');

const SECRET = 'test-secret';

/** A local receiver; `reply(req)` returns [status, headers?] per request. */
async function receiver(t, reply) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hit = { path: req.url, headers: req.headers, raw: Buffer.concat(chunks) };
    hits.push(hit);
    const [status, headers] = reply(hit, hits.length);
    res.writeHead(status, headers);
    res.end();
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/events`, hits };
}

function setup(t, callback_url, job = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-ev-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const j = {
    id: 'job1',
    url: 'https://meet.example.com/SomeRoom',
    callback_url,
    meta: { k: 'v' },
    state: 'finished',
    error: null,
    started_at: '2026-01-01T10:00:00.000Z',
    ended_at: '2026-01-01T10:30:00.000Z',
    duration_s: 1800,
    reason: 'empty_room',
    participants: ['Alice'],
    artifacts: [{ kind: 'audio', path: path.join(dataDir, 'job1', 'audio.webm'), format: 'webm' }],
    events_delivered: [],
    ...job,
  };
  fs.mkdirSync(path.join(dataDir, j.id));
  fs.writeFileSync(path.join(dataDir, j.id, 'job.json'), JSON.stringify(j));
  const make = (backoffMs) => {
    const ev = createEvents({ config: { dataDir, secret: SECRET }, log: () => {}, backoffMs });
    t.after(() => ev.stop());
    return ev;
  };
  const outbox = () => {
    try {
      return fs.readdirSync(path.join(dataDir, j.id, 'outbox'));
    } catch {
      return [];
    }
  };
  const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, j.id, 'job.json'), 'utf8'));
  return { job: j, make, outbox, stored };
}

async function until(cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never met');
}

test('finished: signed envelope, delivered, recorded in job.json, outbox emptied', async (t) => {
  const rx = await receiver(t, () => [204]);
  const { job, make, outbox, stored } = setup(t, rx.url);
  make([]).emit(job, 'recording.finished');
  await until(() => stored().events_delivered.length === 1);
  assert.equal(rx.hits.length, 1);
  const { headers, raw } = rx.hits[0];
  assert.equal(headers['x-recorder-event'], 'recording.finished');
  assert.ok(verify(headers['x-recorder-signature'], raw, SECRET));
  assert.ok(!verify(headers['x-recorder-signature'], raw, 'other'));
  const p = JSON.parse(raw);
  assert.equal(p.event, 'recording.finished');
  assert.equal(p.id, 'job1');
  assert.equal(p.source, 'jitsi');
  assert.equal(p.url, job.url);
  assert.deepEqual(p.meta, { k: 'v' });
  assert.match(p.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(p.reason, 'empty_room');
  assert.equal(p.duration_s, 1800);
  assert.deepEqual(p.participants, ['Alice']);
  assert.deepEqual(p.artifacts, job.artifacts);
  assert.deepEqual(stored().events_delivered, ['recording.finished']);
  assert.deepEqual(outbox(), []);
});

test('guaranteed event is retried after a 500', async (t) => {
  const rx = await receiver(t, (h, n) => [n < 3 ? 500 : 200]);
  const { job, make, stored } = setup(t, rx.url, { state: 'failed', error: 'not_admitted', artifacts: [] });
  make([10, 10, 10]).emit(job, 'recording.failed');
  await until(() => stored().events_delivered.includes('recording.failed'));
  assert.equal(rx.hits.length, 3);
  const p = JSON.parse(rx.hits[2].raw);
  assert.equal(p.error, 'not_admitted');
  assert.equal('artifacts' in p, false, 'no artifacts when no audio reached the disk');
  assert.equal(rx.hits[0].raw.toString(), rx.hits[2].raw.toString(), 'same body on every attempt');
});

test('outbox survives a restart and is redelivered by the startup sweep', async (t) => {
  let up = false;
  const rx = await receiver(t, () => [up ? 200 : 500]);
  const { job, make, outbox, stored } = setup(t, rx.url);
  const first = make([5]);
  first.emit(job, 'recording.finished');
  await until(() => rx.hits.length === 2);
  first.stop(); // the process dies
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(outbox(), ['recording.finished.json']);
  assert.deepEqual(stored().events_delivered, []);

  up = true;
  await make([]).sweep(); // a new process starts
  assert.equal(rx.hits.length, 3);
  assert.equal(rx.hits[2].raw.toString(), rx.hits[0].raw.toString());
  assert.deepEqual(outbox(), []);
  assert.deepEqual(stored().events_delivered, ['recording.finished']);
});

test('a redirect is not followed and the event stays in the outbox', async (t) => {
  const rx = await receiver(t, (h) => (h.path === '/events' ? [302, { location: '/elsewhere' }] : [200]));
  const { job, make, outbox, stored } = setup(t, rx.url);
  make([]).emit(job, 'recording.finished');
  await until(() => rx.hits.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(rx.hits.map((h) => h.path), ['/events']);
  assert.deepEqual(outbox(), ['recording.finished.json']);
  assert.deepEqual(stored().events_delivered, []);
});

test('best-effort events: one attempt, no outbox', async (t) => {
  const rx = await receiver(t, () => [500]);
  const { job, make, outbox } = setup(t, rx.url);
  const ev = make([5, 5]);
  ev.emit(job, 'recording.waiting_admission');
  ev.emit(job, 'recording.started');
  await until(() => rx.hits.length === 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rx.hits.length, 2);
  assert.deepEqual(rx.hits.map((h) => h.headers['x-recorder-event']).sort(), [
    'recording.started',
    'recording.waiting_admission',
  ]);
  assert.deepEqual(Object.keys(JSON.parse(rx.hits[0].raw)).sort(), ['at', 'event', 'id', 'meta', 'source', 'url']);
  assert.deepEqual(outbox(), []);
});
