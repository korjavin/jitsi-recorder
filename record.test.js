'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Requiring must not launch a browser.
const { buildUrl, roomName, shouldStop, checkPaths } = require('./record.js');

test('buildUrl puts the join config in the hash and replaces any existing one', () => {
  const url = buildUrl('https://jitsi.example.com/room-abc#stale=1', 'NoteTaker');
  assert.strictEqual(
    url,
    'https://jitsi.example.com/room-abc' +
      '#config.prejoinConfig.enabled=false' +
      '&config.startWithAudioMuted=true' +
      '&config.startWithVideoMuted=true' +
      '&userInfo.displayName=%22NoteTaker%22'
  );
});

test('roomName logs the room, never the credentials in the URL', () => {
  assert.strictEqual(roomName('https://jitsi.example.com/room-abc?jwt=secret'), 'room-abc');
  assert.strictEqual(roomName('not a url'), '(unparseable-url)');
});

const BASE = { now: 10_000, emptyGrace: 60, startedAt: 0, maxDuration: 14400 };

test('shouldStop keeps recording while others are in the room', () => {
  assert.deepStrictEqual(shouldStop({ ...BASE, membersCount: 3, aloneSince: null }), {
    reason: null,
    aloneSince: null,
  });
});

test('shouldStop starts the alone timer and waits out the grace period', () => {
  const started = shouldStop({ ...BASE, membersCount: 1, aloneSince: null });
  assert.deepStrictEqual(started, { reason: null, aloneSince: 10_000 });

  const almost = shouldStop({ ...BASE, now: 69_000, membersCount: 1, aloneSince: 10_000 });
  assert.strictEqual(almost.reason, null);

  const expired = shouldStop({ ...BASE, now: 70_000, membersCount: 1, aloneSince: 10_000 });
  assert.strictEqual(expired.reason, 'empty_room');
});

test('shouldStop resets the alone timer when somebody rejoins', () => {
  const rejoined = shouldStop({ ...BASE, now: 69_000, membersCount: 2, aloneSince: 10_000 });
  assert.deepStrictEqual(rejoined, { reason: null, aloneSince: null });

  // ...and the grace period restarts from the new alone moment.
  const aloneAgain = shouldStop({ ...BASE, now: 70_000, membersCount: 1, aloneSince: null });
  assert.deepStrictEqual(aloneAgain, { reason: null, aloneSince: 70_000 });
});

test('shouldStop stops at max duration, even with a full room', () => {
  const hit = shouldStop({ ...BASE, now: 14_400_000, membersCount: 5, aloneSince: null });
  assert.strictEqual(hit.reason, 'max_duration');
});

test('shouldStop prefers max_duration over empty_room when both fire', () => {
  const both = shouldStop({ ...BASE, now: 14_400_000, membersCount: 1, aloneSince: 0 });
  assert.strictEqual(both.reason, 'max_duration');
});

// --- per-participant tracks (tracksDir) -------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  trackFile,
  trackPath,
  applyTrackEvents,
  trackEventLines,
  toJsonl,
  manifestRow,
  setupTracks,
} = require('./record.js');

test('checkPaths rejects a tracks dir that holds the recording', () => {
  // setupTracks empties the directory, so these would delete the open audio
  // file (and everything else the job keeps next to it).
  const out = '/data/jobs/7/audio.webm';
  assert.throws(() => checkPaths(out, '/data/jobs/7'), /must not contain/);
  assert.throws(() => checkPaths(out, '/data/jobs/7/'), /must not contain/);
  assert.throws(() => checkPaths(out, '/data'), /must not contain/);
  assert.throws(() => checkPaths(out, '/'), /must not contain/);
  // The real layout — a subdirectory of the job — stays allowed, as does none.
  checkPaths(out, '/data/jobs/7/tracks');
  checkPaths(out, undefined);
});

test('trackFile keeps a participant id to one path segment', () => {
  assert.strictEqual(trackFile('/d', 'a1b2c3'), path.join('/d', 'a1b2c3.webm'));
  assert.strictEqual(trackFile('/d', '../../etc/passwd'), path.join('/d', '______etc_passwd.webm'));
});

test('applyTrackEvents builds the manifest and the speaker timeline', () => {
  const tracks = new Map();
  const speakers = applyTrackEvents(
    tracks,
    [
      { type: 'start', id: 'p1', key: 'p1#a', name: '', t: 1.25 },
      { type: 'name', id: 'p1', key: 'p1#a', name: 'First' },
      { type: 'speaker', id: 'p1', name: 'First', t: 2 },
      { type: 'start', id: 'p2', key: 'p2#a', name: 'Second', t: 3.5 },
      { type: 'speaker', id: 'p2', name: 'Second', t: 4.5 },
      { type: 'end', id: 'p1', key: 'p1#a', t: 30.125 },
    ],
    '/d/tracks',
    new Map()
  );

  // `open` is internal bookkeeping; finish() resolves and drops it.
  assert.deepStrictEqual(
    [...tracks.values()],
    [
      {
        id: 'p1',
        name: 'First',
        path: path.resolve('/d/tracks/p1.webm'),
        offset_s: 1.25,
        ended_s: 30.125,
        open: false,
      },
      {
        id: 'p2',
        name: 'Second',
        path: path.resolve('/d/tracks/p2.webm'),
        offset_s: 3.5,
        ended_s: 3.5,
        open: true,
      },
    ]
  );
  assert.deepStrictEqual(speakers, [
    { t_s: 2, id: 'p1', name: 'First' },
    { t_s: 4.5, id: 'p2', name: 'Second' },
  ]);
});

test('applyTrackEvents ignores events for a track it never saw start', () => {
  const tracks = new Map();
  const speakers = applyTrackEvents(
    tracks,
    [
      { type: 'end', id: 'ghost', key: 'ghost#a', t: 5 },
      { type: 'name', id: 'ghost', key: 'ghost#a', name: 'Nobody' },
    ],
    '/d',
    new Map()
  );
  assert.strictEqual(tracks.size, 0);
  assert.deepStrictEqual(speakers, []);
});

test('a second attach of one participant gets its own record and file', () => {
  // The page reloads on a fatal Jitsi error, which restarts the recorders while
  // the participant ids survive. Appending the new MediaRecorder's header onto
  // the old file would leave two WebM documents in one file.
  const tracks = new Map();
  applyTrackEvents(
    tracks,
    [
      { type: 'start', id: 'p1', key: 'p1#a', name: 'First', t: 1 },
      { type: 'end', id: 'p1', key: 'p1#a', t: 4 },
      { type: 'start', id: 'p1', key: 'p1#b', name: 'First', t: 6 },
      { type: 'end', id: 'p1', key: 'p1#b', t: 9 },
    ],
    '/d',
    new Map()
  );
  assert.deepStrictEqual(
    [...tracks.values()].map((t) => [t.id, t.offset_s, t.ended_s, path.basename(t.path)]),
    [
      ['p1', 1, 4, 'p1.webm'],
      ['p1', 6, 9, 'p1_2.webm'],
    ]
  );
});

test('trackPath allocates one file per attach key and is stable per key', () => {
  const files = new Map();
  // A chunk can arrive before its start event is polled, so both callers must
  // resolve the same key to the same file.
  assert.strictEqual(trackPath('/d', files, 'p1#a'), path.join('/d', 'p1.webm'));
  assert.strictEqual(trackPath('/d', files, 'p1#a'), path.join('/d', 'p1.webm'));
  assert.strictEqual(trackPath('/d', files, 'p2#a'), path.join('/d', 'p2.webm'));
  assert.strictEqual(trackPath('/d', files, 'p1#b'), path.join('/d', 'p1_2.webm'));
  assert.strictEqual(trackPath('/d', files, 'p1#c'), path.join('/d', 'p1_3.webm'));
});

test('toJsonl writes one parseable object per line, nothing for an empty list', () => {
  const tracks = new Map();
  applyTrackEvents(
    tracks,
    [
      { type: 'start', id: 'p1', key: 'p1#a', name: 'First', t: 0.5 },
      { type: 'end', id: 'p1', key: 'p1#a', t: 12 },
    ],
    '/d',
    new Map()
  );
  const body = toJsonl([...tracks.values()].map(manifestRow));
  assert.strictEqual(body.at(-1), '\n');
  const rows = body.trimEnd().split('\n').map(JSON.parse);
  assert.deepStrictEqual(rows, [{ id: 'p1', name: 'First', offset_s: 0.5, ended_s: 12 }]);
  assert.strictEqual(toJsonl([]), '');
});

// setupTracks against a fake page: no browser, no network. `evaluate` stands in
// for pollTracks and replays queued event batches; every 'start' also sends one
// chunk through the exposed writer, as the page's MediaRecorder would.
const fakePage = (batches) => {
  let write = null;
  return {
    exposeFunction: async (name, fn) => {
      write = fn;
    },
    evaluate: async () => {
      const events = batches.shift() ?? [];
      for (const e of events) if (e.type === 'start') write(e.key, 'AAAA');
      return events;
    },
  };
};

test('setupTracks stays out of the way without a tracks dir', async () => {
  assert.strictEqual(await setupTracks(fakePage([]), '', Date.now()), null);
  assert.strictEqual(await setupTracks(fakePage([]), undefined, Date.now()), null);
});

test('setupTracks writes the manifests and clears a previous run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  // Leftovers from an earlier recording of the same job must not survive: the
  // chunk writer appends, so a stale file would glue two calls together.
  fs.writeFileSync(path.join(dir, 'p1.webm'), 'from the previous run');
  fs.writeFileSync(path.join(dir, 'speakers.jsonl'), '{"t_s":0,"id":"old","name":"Old"}\n');

  const cap = await setupTracks(
    fakePage([
      [
        { type: 'start', id: 'p1', key: 'p1#a', name: 'First', t: 1 },
        { type: 'speaker', id: 'p1', name: 'First', t: 1.5 },
      ],
      [{ type: 'start', id: 'p2', key: 'p2#a', name: 'Second', t: 4 }],
      [{ type: 'end', id: 'p1', key: 'p1#a', t: 9 }],
    ]),
    dir,
    Date.now()
  );
  assert.ok(cap, 'setupTracks returned null');
  // The fake page already wrote this run's first chunk (base64 'AAAA').
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'p1.webm')), Buffer.alloc(3));

  await cap.pump(false);
  // p1 ended on its own; p2 never did, so it ran to the end of the recording.
  const list = await cap.finish(12);

  assert.deepStrictEqual(
    list.map((t) => [t.id, t.name, t.offset_s, t.ended_s]),
    [
      ['p1', 'First', 1, 9],
      ['p2', 'Second', 4, 12],
    ]
  );
  assert.deepStrictEqual(
    fs
      .readFileSync(path.join(dir, 'tracks.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map(JSON.parse),
    [
      { id: 'p1', name: 'First', offset_s: 1, ended_s: 9 },
      { id: 'p2', name: 'Second', offset_s: 4, ended_s: 12 },
    ]
  );
  assert.deepStrictEqual(
    fs.readFileSync(path.join(dir, 'speakers.jsonl'), 'utf8'),
    '{"t_s":1.5,"id":"p1","name":"First"}\n'
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('finish closes tracks whose end event was lost with the page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  const cap = await setupTracks(
    // A reload mid-call: no end event for either earlier attach, and the ids
    // come back unchanged.
    fakePage([
      [
        { type: 'start', id: 'p1', key: 'p1#a', name: 'First', t: 1 },
        { type: 'start', id: 'p2', key: 'p2#a', name: 'Second', t: 2 },
      ],
      [{ type: 'start', id: 'p1', key: 'p1#b', name: 'First', t: 18 }],
    ]),
    dir,
    Date.now()
  );
  const list = await cap.finish(30);
  assert.deepStrictEqual(
    list.map((t) => [t.id, t.offset_s, t.ended_s, path.basename(t.path)]),
    [
      // Closed at the moment the participant's next attach began...
      ['p1', 1, 18, 'p1.webm'],
      // ...and the ones with no successor run to the end of the recording.
      ['p2', 2, 30, 'p2.webm'],
      ['p1', 18, 30, 'p1_2.webm'],
    ]
  );
  assert.ok(!('open' in list[0]), 'the internal open flag must not be reported');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('finish clamps a track that outlives the mixed recording', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  const cap = await setupTracks(
    fakePage([
      [{ type: 'start', id: 'p1', key: 'p1#a', name: 'First', t: 1 }],
      [{ type: 'end', id: 'p1', key: 'p1#a', t: 31.9 }],
    ]),
    dir,
    Date.now()
  );
  const list = await cap.finish(30);
  assert.deepStrictEqual(
    list.map((t) => [t.offset_s, t.ended_s]),
    [[1, 30]]
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trackEventLines is the capture timeline an operator reads at INFO', () => {
  assert.deepStrictEqual(
    trackEventLines([
      { type: 'count', n: 1, t: 0.5 },
      { type: 'start', id: 'p1', key: 'p1#a', name: 'Alice', muted: true, t: 0.6 },
      { type: 'name', id: 'p1', key: 'p1#a', name: 'Alice B' },
      { type: 'speaker', id: 'p1', name: 'Alice B', t: 2 },
      { type: 'end', id: 'p1', key: 'p1#a', reason: 'left', t: 9 },
      { type: 'count', n: 0, t: 9 },
    ]),
    [
      'remote audio tracks: 1',
      'track attached p1 name=Alice muted=true',
      'track detached p1 reason=left',
      'remote audio tracks: 0',
    ]
  );
});

test('trackEventLines fills in what an event did not carry', () => {
  assert.deepStrictEqual(
    trackEventLines([
      { type: 'start', id: 'p2', key: 'p2#a', t: 1 },
      { type: 'end', id: 'p2', key: 'p2#a', t: 2 },
    ]),
    ['track attached p2 name= muted=false', 'track detached p2 reason=unknown']
  );
});

test('applyTrackEvents ignores the count events that only reach the log', () => {
  const tracks = new Map();
  const speakers = applyTrackEvents(
    tracks,
    [{ type: 'count', n: 2, t: 0 }],
    '/tmp/tr',
    new Map()
  );
  assert.deepStrictEqual(speakers, []);
  assert.strictEqual(tracks.size, 0);
});

test('finish drops a track whose file never got a byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  // p2 starts with no chunk behind it (the page reloaded before the first one).
  const page = fakePage([
    [{ type: 'start', id: 'p1', key: 'p1#a', name: 'First', t: 1 }],
  ]);
  const cap = await setupTracks(page, dir, Date.now());
  const evaluate = page.evaluate;
  page.evaluate = async () => [{ type: 'start', id: 'p2', key: 'p2#a', t: 5 }];
  await cap.pump(false);
  page.evaluate = evaluate;
  assert.deepStrictEqual((await cap.finish(10)).map((t) => t.id), ['p1']);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'tracks.jsonl'), 'utf8'),
    '{"id":"p1","name":"First","offset_s":1,"ended_s":10}\n'
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- record() against a stubbed browser -------------------------------------

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { record } = require('./record.js');

/** `states` is replayed by readJitsiState probes; the last one repeats. */
function fakeBrowser(states, { onProbe } = {}) {
  const browser = new EventEmitter();
  const page = new EventEmitter();
  const capture = new PassThrough();
  capture.stop = async () => capture.end();
  page.goto = async () => {};
  page.exposeFunction = async () => {};
  page.evaluate = async () => {
    onProbe?.(browser);
    if (!browser.connected) throw new Error('Target closed');
    return states.length > 1 ? states.shift() : states[0];
  };
  browser.connected = true;
  browser.newPage = async () => page;
  browser.close = async () => {
    browser.closed = true;
  };
  const deps = { launch: async () => browser, getStream: async () => capture };
  return { browser, capture, deps };
}

const JOINED = { joined: true, knocking: false, membersCount: 2, p2p: false, participants: ['Alice'] };
const LOBBY = { joined: false, knocking: true, membersCount: 0, participants: [] };
const quiet = () => {};

test('record writes audio as it arrives and stops gracefully on abort', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const out = path.join(dir, 'audio.webm');
  const { browser, capture, deps } = fakeBrowser([LOBBY, JOINED]);
  const ac = new AbortController();
  const states = [];
  let midCall = null;
  const onState = (s) => {
    states.push(s);
    if (s !== 'joined') return;
    capture.write('chunk-1');
    // §3.6: the chunk is on disk while the call is still running (the write
    // stream opens the file asynchronously, so give it a moment).
    const check = (tries) => {
      midCall = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
      if (midCall || !tries) ac.abort();
      else setTimeout(check, 20, tries - 1);
    };
    setTimeout(check, 20, 50);
  };
  const res = await record(
    { url: 'https://jitsi.example.com/SomeRoom', out, signal: ac.signal, log: quiet, onState },
    deps
  );
  assert.strictEqual(midCall, 'chunk-1');
  assert.deepStrictEqual(states, ['waiting_in_lobby', 'joined']);
  assert.strictEqual(res.reason, 'signal');
  assert.strictEqual(res.tracks, null);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'chunk-1');
  assert.ok(browser.closed, 'the browser belongs to the call and is closed by it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('record rejects not_admitted when aborted before joining', async () => {
  const { browser, deps } = fakeBrowser([LOBBY]);
  const out = path.join(os.tmpdir(), 'never.webm');
  const signal = AbortSignal.abort();
  await assert.rejects(record({ url: 'https://jitsi.example.com/r', out, signal, log: quiet }, deps), {
    code: 'not_admitted',
  });
  assert.ok(browser.closed);
});

test('record rejects not_admitted after the join timeout', async () => {
  const { deps } = fakeBrowser([LOBBY]);
  const out = path.join(os.tmpdir(), 'never.webm');
  await assert.rejects(
    record({ url: 'https://jitsi.example.com/r', out, joinTimeoutS: 0.01, log: quiet }, deps),
    { code: 'not_admitted' }
  );
});

test('record fails fast when Chromium dies in the lobby', async () => {
  let probes = 0;
  const onProbe = (browser) => {
    if (++probes === 2) {
      browser.connected = false;
      browser.emit('disconnected');
    }
  };
  const { deps } = fakeBrowser([LOBBY], { onProbe });
  const out = path.join(os.tmpdir(), 'never.webm');
  const t0 = Date.now();
  await assert.rejects(
    record({ url: 'https://jitsi.example.com/r', out, joinTimeoutS: 600, log: quiet }, deps),
    { code: 'recorder_failed' }
  );
  assert.ok(Date.now() - t0 < 10_000, 'must not wait out the join timeout');
});

test('record rejects a tracks dir that holds the recording before launching', async () => {
  const deps = { launch: async () => assert.fail('must not launch'), getStream: null };
  const opts = { url: 'https://jitsi.example.com/r', out: '/data/7/a.webm', tracksDir: '/data/7' };
  await assert.rejects(record({ ...opts, log: quiet }, deps), { code: 'recorder_failed' });
  // A NaN limit would silently disable its stop rule.
  const nan = { url: 'https://jitsi.example.com/r', out: '/tmp/a.webm', maxDurationS: NaN };
  await assert.rejects(record({ ...nan, log: quiet }, deps), /maxDurationS/);
});

test('record does not announce joined when the output cannot be opened', async () => {
  const { deps } = fakeBrowser([JOINED]);
  const states = [];
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); // a directory
  await assert.rejects(
    record({ url: 'https://jitsi.example.com/r', out, log: quiet, onState: (s) => states.push(s) }, deps),
    { code: 'recorder_failed' }
  );
  assert.deepStrictEqual(states, []);
  fs.rmSync(out, { recursive: true, force: true });
});
