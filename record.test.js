'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Requiring must not launch a browser or run the CLI.
const { USAGE, parseArgs, buildUrl, roomName, shouldStop } = require('./record.js');

const MIN = ['--url', 'https://jitsi.example.com/room-abc', '--out', '/tmp/a.webm'];

test('usage names the required flags', () => {
  assert.match(USAGE, /--url/);
  assert.match(USAGE, /--out/);
});

test('parseArgs applies the contract defaults', () => {
  assert.deepStrictEqual(parseArgs(MIN), {
    url: 'https://jitsi.example.com/room-abc',
    out: '/tmp/a.webm',
    joinTimeout: 600,
    maxDuration: 14400,
    emptyGrace: 60,
    displayName: 'NoteTaker',
  });
});

test('parseArgs overrides every flag', () => {
  const opts = parseArgs([
    ...MIN,
    '--join-timeout', '30',
    '--max-duration', '120',
    '--empty-grace', '5',
    '--display-name', 'Someone Else',
  ]);
  assert.strictEqual(opts.joinTimeout, 30);
  assert.strictEqual(opts.maxDuration, 120);
  assert.strictEqual(opts.emptyGrace, 5);
  assert.strictEqual(opts.displayName, 'Someone Else');
});

test('parseArgs rejects bad input', () => {
  assert.throws(() => parseArgs(['--out', '/tmp/a.webm']), /--url/);
  assert.throws(() => parseArgs(['--url', 'https://jitsi.example.com/r']), /--out/);
  assert.throws(() => parseArgs([...MIN, '--nope', '1']), /unknown argument/);
  assert.throws(() => parseArgs([...MIN, '--join-timeout']), /missing value/);
  assert.throws(() => parseArgs([...MIN, '--empty-grace', 'soon']), /positive number/);
  assert.throws(() => parseArgs([...MIN, '--max-duration', '0']), /positive number/);
});

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

// --- per-participant tracks (--tracks-dir) ----------------------------------

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
  resultLine,
  setupTracks,
} = require('./record.js');

test('parseArgs leaves tracksDir unset without the flag, and takes it with', () => {
  assert.ok(!('tracksDir' in parseArgs(MIN)), 'the key must be absent, not empty');
  assert.strictEqual(parseArgs([...MIN, '--tracks-dir', '/tmp/tr']).tracksDir, '/tmp/tr');
  assert.throws(() => parseArgs([...MIN, '--tracks-dir']), /missing value/);
});

test('parseArgs rejects a tracks dir that holds the recording', () => {
  // setupTracks empties the directory, so these would delete the open audio
  // file (and everything else the job keeps next to it).
  const out = ['--url', 'https://jitsi.example.com/r', '--out', '/data/jobs/7/audio.webm'];
  assert.throws(() => parseArgs([...out, '--tracks-dir', '/data/jobs/7']), /must not contain/);
  assert.throws(() => parseArgs([...out, '--tracks-dir', '/data/jobs/7/']), /must not contain/);
  assert.throws(() => parseArgs([...out, '--tracks-dir', '/data']), /must not contain/);
  assert.throws(() => parseArgs([...out, '--tracks-dir', '/']), /must not contain/);
  // The real layout — a subdirectory of the job — stays allowed.
  assert.strictEqual(
    parseArgs([...out, '--tracks-dir', '/data/jobs/7/tracks']).tracksDir,
    '/data/jobs/7/tracks'
  );
});

test('usage documents --tracks-dir', () => {
  assert.match(USAGE, /--tracks-dir/);
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

test('resultLine omits tracks entirely without --tracks-dir', () => {
  const base = {
    out: '/d/audio.webm',
    durationS: 114.14,
    reason: 'empty_room',
    participants: ['A'],
  };
  assert.strictEqual(
    resultLine({ ...base, tracks: null }),
    '{"out":"/d/audio.webm","duration_s":114.1,"reason":"empty_room","participants":["A"]}\n'
  );
});

test('resultLine appends the tracks array with --tracks-dir', () => {
  const track = { id: 'p1', name: 'First', path: '/d/tracks/p1.webm', offset_s: 1, ended_s: 2 };
  const parsed = JSON.parse(
    resultLine({
      out: '/d/audio.webm',
      durationS: 10,
      reason: 'signal',
      participants: ['First'],
      tracks: [track],
    })
  );
  assert.deepStrictEqual(parsed.tracks, [track]);
  assert.strictEqual(Object.keys(parsed).at(-1), 'tracks');
});

test('resultLine still emits an empty tracks array when nobody was recorded', () => {
  const parsed = JSON.parse(
    resultLine({ out: '/d/a.webm', durationS: 1, reason: 'signal', participants: [], tracks: [] })
  );
  assert.deepStrictEqual(parsed.tracks, []);
});

// setupTracks against a fake page: no browser, no network. `evaluate` stands in
// for pollTracks and replays queued event batches.
const fakePage = (batches) => ({
  exposeFunction: async () => {},
  evaluate: async () => batches.shift() ?? [],
});

test('setupTracks stays out of the way without --tracks-dir', async () => {
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
  assert.ok(!fs.existsSync(path.join(dir, 'p1.webm')), 'stale track file survived');

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
