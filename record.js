'use strict';

// Headless Jitsi audio recorder, as a library: record() joins muted, waits (in
// the lobby if a human moderator has to admit it), records the tab's incoming
// audio to WebM/Opus and resolves or rejects with a coded error. With tracksDir
// it additionally records one WebM per remote participant. See
// docs/recording.md.
//
// Jitsi's `window.APP` is an internal global, not a public API. Every read of it
// lives in readJitsiState() and pollTracks() below — the two page-side
// functions — so a Jitsi UI change stays a one-place fix.
// Last checked against live Jitsi on 2026-09-13: the lobby/moderator-wall state
// on meet.jit.si, the joined/recording path on an open public deployment.

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const DEFAULTS = {
  displayName: 'NoteTaker',
  joinTimeoutS: 600,
  maxDurationS: 14400,
  emptyGraceS: 60,
};

const POLL_MS = 2000;
const FLUSH_MS = 5000;

/** An error record() rejects with: `code` is not_admitted | recorder_failed. */
const failure = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

/**
 * The tracks directory is emptied on startup, so it must not be — or contain —
 * the directory the recording itself is written to. Throws when it does.
 */
function checkPaths(out, tracksDir) {
  if (!tracksDir) return;
  const outDir = path.dirname(path.resolve(out));
  const dir = path.resolve(tracksDir);
  // The root directory already ends in a separator; everything else needs one.
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (outDir === dir || outDir.startsWith(prefix)) {
    throw new Error('tracksDir must not contain the out directory');
  }
}

/** Jitsi config goes in the URL hash, so the bot never has to click the UI. */
function buildUrl(url, displayName) {
  const hash = [
    'config.prejoinConfig.enabled=false',
    'config.startWithAudioMuted=true',
    'config.startWithVideoMuted=true',
    `userInfo.displayName=${encodeURIComponent(JSON.stringify(displayName))}`,
  ].join('&');
  return `${url.split('#')[0]}#${hash}`;
}

/** Room name only — the URL may carry a JWT or a password we must not log. */
function roomName(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() || '(root)';
  } catch {
    return '(unparseable-url)';
  }
}

/**
 * Pure stop decision. Times (`now`, `aloneSince`, `startedAt`) are epoch ms;
 * `emptyGrace` / `maxDuration` are seconds. Returns the stop reason (or null)
 * plus the carried-forward `aloneSince`, which resets as soon as somebody else
 * is in the room again.
 */
function shouldStop({ membersCount, aloneSince, now, emptyGrace, startedAt, maxDuration }) {
  if (now - startedAt >= maxDuration * 1000) return { reason: 'max_duration', aloneSince };
  // APP.conference.membersCount counts the bot itself.
  const alone = membersCount <= 1;
  const since = alone ? (aloneSince ?? now) : null;
  if (alone && now - since >= emptyGrace * 1000) return { reason: 'empty_room', aloneSince: since };
  return { reason: null, aloneSince: since };
}

/**
 * Runs inside the page. No closures: puppeteer serializes this function.
 * Everything it touches is pre-join-undefined or throws until the conference
 * exists, so every read is guarded — a throw out of here means a dead page.
 */
function readJitsiState() {
  const app = window.APP;
  const conference = app && app.conference;
  const state = app && app.store && app.store.getState ? app.store.getState() : null;
  const lobby = state ? state['features/lobby'] : null;
  const read = (fn, fallback) => {
    try {
      const v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  };
  return {
    joined: read(() => !!conference.isJoined(), false),
    knocking: !!(lobby && lobby.knocking),
    // membersCount counts the bot itself; listMembers() is remote-only.
    membersCount: read(() => conference.membersCount, 0),
    // Which transport the call is on. A P2P call swaps the remote track set out
    // from under per-participant capture, so "zero tracks" reads very
    // differently depending on this. null when neither source is readable.
    p2p: read(() => {
      const c = state && state['features/base/conference'];
      const v = c && c.p2p;
      return typeof v === 'boolean' ? v : conference._room.p2p;
    }, null),
    participants: read(
      () =>
        conference
          .listMembers()
          .filter((m) => !m.isHidden())
          .map((m) => m.getDisplayName())
          .filter(Boolean),
      []
    ),
  };
}

/**
 * Runs inside the page; the second and last place that touches window.APP.
 * No closures: puppeteer serializes this function, so it is called afresh on
 * every poll and keeps its state on `window.__jc`.
 *
 * It attaches a MediaRecorder to each remote participant's audio track, drops
 * the ones whose owner left, and returns the events queued since the previous
 * call: {type:'start'|'end'|'name'|'speaker'|'count', id?, key?, name?, muted?,
 * reason?, n?, t?} with `t` in seconds since the mixed recording started.
 * 'count' carries no key and only ever reaches the log, not the manifest —
 * applyTrackEvents skips it. `key` identifies one attach — it
 * is what chunks are labelled with, so a second attach for the same
 * participant cannot append onto the first one's file. `stop` finalizes every
 * recorder and resolves once the last chunk has reached Node.
 *
 * Every read is guarded the same way readJitsiState() is: a throw out of here
 * would mean a dead page, and per-participant audio must never cost us the
 * mixed recording.
 */
function pollTracks(startedAtMs, stop) {
  const st = (window.__jc = window.__jc || {
    active: new Map(),
    names: new Map(),
    failed: new Set(),
    pending: new Set(),
    events: [],
    dominant: null,
    ctx: null,
    count: -1, // remote audio tracks last reported; -1 so the first poll reports
  });
  const SETTLE_MS = 4000; // ceiling on each stage of the stop handshake
  const at = () => (Date.now() - startedAtMs) / 1000;
  const read = (fn, fallback) => {
    try {
      const v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const state = () => window.APP.store.getState();
  const nameOf = (id) =>
    read(() => {
      const p = state()['features/base/participants'].remote.get(id);
      return p && (p.name || p.displayName);
    }, '') || '';

  const end = (id, reason) => {
    const a = st.active.get(id);
    if (!a) return;
    st.active.delete(id);
    read(() => a.rec.stop());
    read(() => a.src.disconnect());
    st.events.push({ type: 'end', id, key: a.key, reason, t: at() });
  };

  if (stop) {
    // onstop fires after the recorder's final ondataavailable, and every
    // __trackChunk promise resolves once Node has appended that chunk, so this
    // hands back only once the files on disk are complete. Both stages are
    // bounded: a recorder that never fires must not hang finalization.
    const stopped = [...st.active.keys()].map((id) => {
      const a = st.active.get(id);
      const done = new Promise((res) => {
        a.rec.onstop = res;
        setTimeout(res, SETTLE_MS);
      });
      end(id, 'stopping');
      return done;
    });
    const settle = (p) => Promise.race([p, new Promise((res) => setTimeout(res, SETTLE_MS))]);
    return settle(Promise.all(stopped))
      .then(() => settle(Promise.allSettled([...st.pending])))
      .then(() => st.events.splice(0));
  }

  // The roster is also the hidden-participant filter: transcriber/SIP ghosts
  // are left out of participants[] too, and must not get a track file.
  const roster = read(() => state()['features/base/participants'].remote, null);
  const visible = (id) =>
    !roster ||
    read(() => {
      const p = roster.get(id);
      return !!p && !p.isHidden;
    }, false);

  // Remote audio streams by participant id. Somebody who joined muted has no
  // audio track yet — skip them and pick them up on a later poll.
  const streams = new Map();
  const mutedById = new Map();
  let remoteAudio = 0;
  for (const t of read(() => state()['features/base/tracks'], []) || []) {
    if (!t || t.mediaType !== 'audio' || t.local || !t.participantId) continue;
    if (!visible(t.participantId)) continue;
    remoteAudio++;
    mutedById.set(t.participantId, !!t.muted);
    const s =
      read(() => t.jitsiTrack.getOriginalStream(), null) || read(() => t.jitsiTrack.stream, null);
    if (s && read(() => s.getAudioTracks().length, 0) > 0) streams.set(t.participantId, s);
  }
  // What Jitsi reports, not what we managed to attach: a call that ends with no
  // track files is a different bug depending on which of the two was zero.
  if (remoteAudio !== st.count) {
    st.count = remoteAudio;
    st.events.push({ type: 'count', n: remoteAudio, t: at() });
  }

  for (const [id, s] of streams) {
    if (st.active.has(id) || st.failed.has(id)) continue;
    let src = null;
    // Unique per attach, and not derived from any counter: Jitsi reloads the
    // page on a fatal connection error, which wipes this state while the
    // participant ids survive.
    const key = `${id}#${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const started = read(() => {
      if (!st.ctx) st.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Needs --autoplay-policy=no-user-gesture-required, or it stays suspended.
      if (st.ctx.state === 'suspended') st.ctx.resume();
      src = st.ctx.createMediaStreamSource(s);
      // Recording the remote track directly would stall the MediaRecorder clock
      // while the participant is muted; the AudioContext hop keeps it running.
      // Never connect to ctx.destination — that would echo into the tab capture.
      const dest = st.ctx.createMediaStreamDestination();
      src.connect(dest);
      const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        // Tracked so the stop handshake can wait for the last chunk to land.
        const sent = e.data
          .arrayBuffer()
          .then((b) => {
            // exposeFunction only carries strings, so base64 it is.
            const u8 = new Uint8Array(b);
            let bin = '';
            for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
            return window.__trackChunk(key, btoa(bin));
          })
          .catch(() => {});
        st.pending.add(sent);
        sent.then(() => st.pending.delete(sent));
      };
      rec.start(1000);
      st.active.set(id, { rec, src, dest, stream: s, key });
      return true;
    }, false);
    if (started) {
      st.events.push({
        type: 'start',
        id,
        key,
        name: nameOf(id),
        muted: !!mutedById.get(id),
        t: at(),
      });
    } else {
      // One attempt per participant: retrying every 2 s would leak a connected
      // node pair each time, and an out-of-memory renderer would take the mixed
      // recording down with it.
      st.failed.add(id);
      read(() => src.disconnect());
    }
  }

  // A track that disappears while its owner is still in the room (a mute, a
  // P2P/bridge switch, a renegotiation) must not end the recording: the
  // MediaRecorder keeps running on the AudioContext, so the gap stays in the
  // file as silence and offset_s remains valid for the whole track. An
  // unreadable roster counts as "still here" for the same reason; the stop
  // pass ends everything regardless.
  for (const [id, a] of [...st.active]) {
    const s = streams.get(id);
    if (s && s !== a.stream) {
      read(() => {
        a.src.disconnect();
        a.src = st.ctx.createMediaStreamSource(s);
        a.src.connect(a.dest);
        a.stream = s;
      });
    } else if (!s && !visible(id)) {
      end(id, 'left');
    }
  }

  // A display name often lands after the track does; report it when it changes.
  for (const [id, a] of st.active) {
    const name = nameOf(id);
    if (name && name !== st.names.get(id)) {
      st.names.set(id, name);
      st.events.push({ type: 'name', id, key: a.key, name });
    }
  }

  const dom = read(() => state()['features/base/participants'].dominantSpeaker, null);
  if (dom && dom !== st.dominant) {
    st.dominant = dom;
    st.events.push({ type: 'speaker', id: dom, name: nameOf(dom), t: at() });
  }
  return st.events.splice(0);
}

/** Resolves after `ms`, or as soon as `signal` aborts — never rejects. */
const sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});
const stderrLog = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

/**
 * Error messages from puppeteer quote the URL they failed on ("net::ERR_… at
 * https://…#…"), which may carry a JWT or a room password. Never log one raw.
 */
const scrub = (msg) => String(msg).replace(/https?:\/\/\S+/g, '<url>');

/** Milliseconds are enough for merge-by-offset alignment downstream. */
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Per-track file. The participant id comes from Jitsi, so it never becomes more
 * than one path segment here.
 * ponytail: two ids that sanitize alike would share a file — Jitsi ids are hex,
 * so they do not. Prefix with a counter if that ever stops being true.
 */
const trackFile = (dir, id) =>
  path.join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.webm`);

/**
 * The file one attach key writes to, allocated once and remembered in `files`.
 * A participant's first attach gets `<id>.webm`; a later one — the page
 * reloaded mid-call — gets `<id>_2.webm` rather than appending a second WebM
 * document onto the first, which no decoder would read past.
 */
function trackPath(dir, files, key) {
  let file = files.get(key);
  if (!file) {
    const id = String(key).split('#')[0];
    const seen = [...files.keys()].filter((k) => String(k).split('#')[0] === id).length;
    file = trackFile(dir, seen ? `${id}_${seen + 1}` : id);
    files.set(key, file);
  }
  return file;
}

/**
 * Fold page events into `tracks` (attach key -> manifest record, first-seen
 * order), allocating files through `files`, and return the dominant-speaker
 * lines to append. Pure apart from those two maps: no fs, no browser.
 */
function applyTrackEvents(tracks, events, dir, files) {
  const speakers = [];
  for (const e of events) {
    if (e.type === 'speaker') {
      speakers.push({ t_s: round3(e.t), id: e.id, name: e.name || '' });
      continue;
    }
    const rec = tracks.get(e.key);
    if (e.type === 'start') {
      // Keyed by attach, not by participant: a rejoin (new id) and a re-attach
      // of the same id both get their own record, file and offset.
      if (!rec) {
        // A page reload takes the old recorder down without an end event, so
        // close any record of this participant still open — the new attach is
        // the best estimate we have of when the old one died. Left at its
        // offset it would look empty, and a consumer would skip the audio.
        for (const t of tracks.values()) {
          if (t.id === e.id && t.open) {
            t.ended_s = round3(e.t);
            t.open = false;
          }
        }
        tracks.set(e.key, {
          id: e.id,
          name: e.name || '',
          path: path.resolve(trackPath(dir, files, e.key)),
          offset_s: round3(e.t),
          ended_s: round3(e.t),
          open: true,
        });
      }
    } else if (!rec) {
      continue;
    } else if (e.type === 'name') {
      rec.name = e.name || rec.name;
    } else if (e.type === 'end') {
      rec.ended_s = round3(e.t);
      rec.open = false;
    }
  }
  return speakers;
}

/**
 * The stderr timeline for per-participant capture: how many remote audio tracks
 * Jitsi reported, which of them we attached a recorder to (and whether the mic
 * was muted at the time), and which went away and why. Without these a call that
 * produced no track files gives an operator nothing to tell "the track was never
 * in features/base/tracks" from "attaching it failed". Pure so it stays testable;
 * the lines it returns belong at INFO.
 */
function trackEventLines(events) {
  const lines = [];
  for (const e of events) {
    if (e.type === 'start') {
      lines.push(`track attached ${e.id} name=${e.name || ''} muted=${!!e.muted}`);
    } else if (e.type === 'end') {
      lines.push(`track detached ${e.id} reason=${e.reason || 'unknown'}`);
    } else if (e.type === 'count') {
      lines.push(`remote audio tracks: ${e.n}`);
    }
  }
  return lines;
}

/** JSONL body for a list of objects; '' for an empty list, never a bare "\n". */
const toJsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

/** tracks.jsonl carries the manifest without the path — the caller has the dir. */
const manifestRow = (t) => ({ id: t.id, name: t.name, offset_s: t.offset_s, ended_s: t.ended_s });

/**
 * Wires per-participant capture onto an already-recording page, or returns null
 * when no tracksDir was given. Failures here are logged and downgrade to
 * null: losing per-speaker tracks must never cost us the mixed recording.
 */
async function setupTracks(page, tracksDir, startedAt, log = stderrLog) {
  if (!tracksDir) return null;
  const dir = path.resolve(tracksDir);
  const tracks = new Map();
  const files = new Map(); // attach key -> file, so chunks and manifest agree
  try {
    // Truncate semantics, like `out`: a re-recorded job reuses its directory,
    // and appending onto the previous run's files would glue two calls together.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // The page awaits this, so the returned promise is the chunk's ack.
    await page.exposeFunction('__trackChunk', (key, b64) => {
      try {
        // A chunked MediaRecorder WebM stays playable appended chunk by chunk —
        // the first one carries the header. Do not re-mux.
        // ponytail: synchronous, so concurrent chunks cannot interleave inside
        // one file; if N participants ever make this block the mixed write, the
        // upgrade is a per-file async queue, not plain fs.appendFile.
        fs.appendFileSync(trackPath(dir, files, key), Buffer.from(b64, 'base64'));
      } catch (e) {
        log(`track write failed: ${scrub(e.message)}`);
      }
    });
  } catch (e) {
    log(`per-participant capture disabled: ${scrub(e.message)}`);
    return null;
  }
  const speakersPath = path.join(dir, 'speakers.jsonl');
  const pump = async (stop) => {
    try {
      // Never race this: pollTracks hands the events over destructively, so a
      // timeout here would drop them for good. The page bounds its own stop
      // handshake, and the poll is no more blocking than readJitsiState.
      const events = await page.evaluate(pollTracks, startedAt, !!stop);
      for (const l of trackEventLines(events)) log(l);
      const lines = toJsonl(applyTrackEvents(tracks, events, dir, files));
      if (lines) fs.appendFileSync(speakersPath, lines);
    } catch (e) {
      log(`track poll failed: ${scrub(e.message)}`);
    }
  };
  await pump(false); // attach to whoever is already in the room
  return {
    pump,
    /** `endS` is the duration reported for the mixed file; see the clamp below. */
    async finish(endS) {
      await pump(true);
      // A track whose file never got a byte (the page reloaded before the first
      // chunk, the write failed) is not a track: reporting it would hand the
      // consumer a path to nothing.
      const list = [...tracks.values()].filter(
        (t) => (fs.statSync(t.path, { throwIfNoEntry: false })?.size ?? 0) > 0
      );
      // The mixed file stops first and its duration is frozen before the flush,
      // while these timestamps are wall-clock: without the clamp a track would
      // claim to run past the recording it belongs to.
      const cap = round3(endS);
      for (const t of list) {
        // Still open here means its end event was lost with the page; the
        // recording ran to the end as far as anyone can tell.
        if (t.open || t.ended_s > cap) t.ended_s = cap;
        delete t.open; // internal, never reported
      }
      try {
        fs.writeFileSync(path.join(dir, 'tracks.jsonl'), toJsonl(list.map(manifestRow)));
      } catch (e) {
        log(`track manifest failed: ${scrub(e.message)}`);
      }
      log(`per-participant tracks: ${list.length} in ${dir}`);
      return list;
    },
  };
}

/**
 * Record one Jitsi room into `out` (and per-participant files into `tracksDir`
 * when given). Everything — browser, page, files — belongs to this call, so
 * several recordings can run in one process.
 *
 * Resolves with {durationS, reason, participants, tracks} (`tracks` is null
 * without `tracksDir`); `reason` is empty_room | max_duration | signal.
 * Rejects with an Error whose `code` is:
 *   not_admitted    — never joined within joinTimeoutS, or aborted before joining
 *   recorder_failed — bad options, browser/page failure, write error, capture
 *                     died mid-call, or an empty file. When this happens after
 *                     joining, the error also carries {durationS, participants,
 *                     tracks} for whatever partial audio reached the disk.
 *
 * onState('waiting_in_lobby') fires on entering the lobby, onState('joined')
 * once audio is being written. Aborting `signal` stops gracefully with reason
 * "signal". `deps` replaces puppeteer-stream in tests.
 */
async function record(opts, deps = {}) {
  const o = { ...DEFAULTS, ...opts };
  const log = o.log || stderrLog;
  const emit = (state) => {
    try {
      o.onState?.(state);
    } catch (e) {
      log(`onState(${state}) threw: ${scrub(e.message)}`);
    }
  };
  try {
    if (!o.url) throw new Error('missing url');
    if (!o.out) throw new Error('missing out');
    checkPaths(o.out, o.tracksDir);
    // Absolute from here on, so `out` and `tracks[].path` have the same shape
    // whatever the caller passed.
    o.out = path.resolve(o.out);
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
  } catch (e) {
    throw failure('recorder_failed', scrub(e.message));
  }

  // The first stop reason wins, but an abort always stops even when an empty
  // room or max duration already started the stop.
  let reason = null;
  const onAbort = () => {
    reason ||= 'signal';
    log('abort received — stopping');
  };
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });

  const { launch, getStream } = deps.launch ? deps : require('puppeteer-stream');
  let browser;
  let page;
  // Set when Chromium or the tab dies: from then on nothing will ever join or
  // record, so waiting out a timeout would only delay the failure.
  let dead = null;
  try {
    try {
      // puppeteer-stream only honours headless when the value is literally
      // 'new' (it needs the capture extension, which legacy headless cannot
      // load). Passing the puppeteer module lets it find the bundled browser
      // when PUPPETEER_EXECUTABLE_PATH is unset.
      browser = await launch(deps.launch ? null : require('puppeteer'), {
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
        // Puppeteer's own handlers would kill Chromium on a process signal
        // before we finalize the file. Shutdown is the caller's, via `signal`.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      browser.once('disconnected', () => (dead ||= 'browser disconnected'));
      page = await browser.newPage();
      page.once('error', () => (dead ||= 'page crashed'));
      log(`joining room ${roomName(o.url)} as ${o.displayName}`);
      await page.goto(buildUrl(o.url, o.displayName), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    } catch (e) {
      throw failure('recorder_failed', `browser launch/page failure: ${scrub(e.message)}`);
    }

    // --- join phase -------------------------------------------------------
    // Anything that is not "joined" counts as waiting, including a moderator
    // wall we cannot tell apart from a lobby; joinTimeoutS is the backstop.
    // ponytail: no explicit rejected/kicked detection — Jitsi signals it only
    // through a transient notification. Add one if not_admitted proves too slow.
    const joinDeadline = Date.now() + o.joinTimeoutS * 1000;
    let joined = false;
    let lastPhase = '';
    while (!reason && Date.now() < joinDeadline) {
      let state;
      try {
        state = await page.evaluate(readJitsiState);
      } catch (e) {
        if (dead) throw failure('recorder_failed', `${dead} while joining`);
        log(`state probe failed: ${scrub(e.message)}`);
        state = { joined: false, knocking: false, membersCount: 0 };
      }
      const phase = state.joined ? 'joined' : state.knocking ? 'waiting_in_lobby' : 'waiting';
      if (phase !== lastPhase) {
        log(`state: ${phase}`);
        lastPhase = phase;
        if (phase === 'waiting_in_lobby') emit(phase);
      }
      if (state.joined) {
        joined = true;
        log(`conference mode: ${state.p2p == null ? 'unknown' : state.p2p ? 'p2p' : 'jvb'}`);
        break;
      }
      if (dead) throw failure('recorder_failed', `${dead} while joining`);
      await sleep(POLL_MS, o.signal);
    }
    if (!joined) {
      throw failure('not_admitted', reason === 'signal' ? 'stopped before joining' : 'join timeout');
    }

    // --- record phase -----------------------------------------------------
    let stream;
    try {
      stream = await getStream(page, { audio: true, video: false });
    } catch (e) {
      throw failure('recorder_failed', `audio capture failed to start: ${scrub(e.message)}`);
    }
    const file = fs.createWriteStream(o.out);
    // An unhandled 'error' here (cannot open, disk full) would crash the whole
    // process, every other recording included.
    let fileError = null;
    file.on('error', (e) => {
      fileError = e;
    });
    // The capture stream only ends on its own if the extension's MediaRecorder
    // died — we end it deliberately after the loop, so an end during the loop
    // means the rest of the call was never recorded.
    let captureDied = false;
    const onCaptureEnd = () => {
      captureDied = true;
    };
    stream.once('end', onCaptureEnd);
    stream.once('close', onCaptureEnd);
    // Each chunk is appended as it arrives (architecture §3.6): a crash keeps
    // everything recorded up to that moment.
    stream.pipe(file);
    const startedAt = Date.now();
    log(`recording -> ${o.out}`);
    emit('joined');
    const trackCap = await setupTracks(page, o.tracksDir, startedAt, log);

    let aloneSince = null;
    const participants = new Set(); // insertion order == first-seen order
    while (!reason && !fileError && !captureDied && !dead) {
      await sleep(POLL_MS, o.signal);
      if (reason) break;
      let membersCount = 0; // page gone == nobody left to record
      try {
        const state = await page.evaluate(readJitsiState);
        membersCount = state.membersCount;
        for (const name of state.participants) participants.add(name);
      } catch (e) {
        log(`state probe failed: ${scrub(e.message)}`);
      }
      if (trackCap) await trackCap.pump(false);
      const next = shouldStop({
        membersCount,
        aloneSince,
        now: Date.now(),
        emptyGrace: o.emptyGraceS,
        startedAt,
        maxDuration: o.maxDurationS,
      });
      aloneSince = next.aloneSince;
      if (next.reason) reason ||= next.reason;
    }

    const durationS = (Date.now() - startedAt) / 1000;
    const failureNow = () =>
      fileError
        ? `output write failed: ${scrub(fileError.message)}`
        : captureDied
          ? 'audio capture ended before the call did — the recording is truncated'
          : dead
            ? `${dead} mid-call — the recording is truncated`
            : null;
    log(`stopping: ${failureNow() ? 'failed' : reason}`);
    // From here the stream ends because we stop it, not because capture died.
    stream.off('end', onCaptureEnd);
    stream.off('close', onCaptureEnd);
    await stream.stop().catch(() => {});
    const flushed = () => Promise.race([once(file, 'finish').catch(() => {}), sleep(FLUSH_MS)]);
    if (!fileError) {
      await flushed();
      if (!file.writableFinished) {
        // The extension's websocket never closed; end the file ourselves.
        stream.unpipe(file);
        file.end();
        await flushed();
      }
    }
    // After the mixed stream is finalized, so per-participant capture cannot
    // stretch audio.webm past the durationS we are about to report. Also on
    // failure, so partial tracks keep their tracks.jsonl.
    const tracks = trackCap ? await trackCap.finish(durationS) : null;
    const result = { durationS, reason, participants: [...participants], tracks };

    // Re-read: the final flush can itself hit a write error.
    const failed = failureNow();
    if (failed) throw failure('recorder_failed', failed, result);

    const size = fs.statSync(o.out, { throwIfNoEntry: false })?.size ?? 0;
    if (size === 0) throw failure('recorder_failed', 'output missing or empty', result);
    log(`wrote ${size} bytes in ${durationS.toFixed(1)}s, ${participants.size} participant(s)`);
    return result;
  } catch (e) {
    const ours = e.code === 'not_admitted' || e.code === 'recorder_failed';
    const err = ours ? e : failure('recorder_failed', scrub(e.message));
    log(`${err.code}: ${err.message}`);
    throw err;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  record,
  checkPaths,
  buildUrl,
  roomName,
  shouldStop,
  trackPath,
  // pollTracks and setupTracks are exported so the per-participant capture can
  // be driven against a stubbed window.APP in a browser, which is how the audio
  // path is verified without a live conference.
  pollTracks,
  setupTracks,
  trackFile,
  applyTrackEvents,
  trackEventLines,
  toJsonl,
  manifestRow,
};
