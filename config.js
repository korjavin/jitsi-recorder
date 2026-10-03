'use strict';

// The one place that reads process.env. Never log a value from here — a
// problem is reported by the variable NAME.

const LEVELS = ['debug', 'info', 'error'];

function positive(env, name, def) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!(Number.isFinite(n) && n > 0)) throw new Error(`${name} must be a positive number`);
  return n;
}

function loadConfig(env = process.env) {
  if (!env.RECORDER_SECRET) throw new Error('RECORDER_SECRET is required');
  const base = env.JITSI_BASE_URL || 'https://meet.jit.si';
  let jitsiBase;
  try {
    jitsiBase = new URL(base);
  } catch {
    throw new Error('JITSI_BASE_URL must be an absolute URL');
  }
  if (!/^https?:$/.test(jitsiBase.protocol)) throw new Error('JITSI_BASE_URL must be http(s)');
  const logLevel = (env.LOG_LEVEL || 'info').toLowerCase();
  if (!LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}`);
  return {
    secret: env.RECORDER_SECRET,
    jitsiBase,
    dataDir: env.DATA_DIR || '/data/jitsi',
    port: positive(env, 'PORT', 8080),
    displayName: env.BOT_DISPLAY_NAME || 'NoteTaker',
    joinTimeoutS: positive(env, 'JOIN_TIMEOUT_S', 600),
    maxDurationS: positive(env, 'MAX_DURATION_S', 14400),
    emptyGraceS: positive(env, 'EMPTY_GRACE_S', 60),
    logLevel,
  };
}

module.exports = { loadConfig, LEVELS };
