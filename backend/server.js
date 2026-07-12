'use strict';

const express   = require('express');
const path      = require('path');
const { exec }  = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { loadProgress, saveProgress } = require('./db/progress');

const { readState, writeState, reconcileInterrupted } = require('./lib/addon-state');
const { createJobEngine }        = require('./lib/addon-jobs');
const { reloadCache, loadAddons } = require('./lib/cache');
const { createTerminalServer }   = require('./lib/terminal');

const { createAddonsRouter }   = require('./routes/addons');
const { createTracksRouter }   = require('./routes/tracks');
const { createBundlesRouter }  = require('./routes/bundles');
const { createScenariosRouter } = require('./routes/scenarios');
const { createProgressRouter } = require('./routes/progress');
const { createSessionsRouter } = require('./routes/sessions');
const { createCacheRouter }    = require('./routes/cache');
const { createHealthRouter }   = require('./routes/health');

// Safety net: a single stray async error (e.g. a background addon job or health
// probe) must not silently kill the API and put the container in a restart loop.
// Log it loudly and keep serving — orchestrators read these lines.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (kept alive):', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (kept alive):', err && err.stack || err);
});

const app  = express();
const PORT = 4000;

app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const originalJson = res.json;
    res.json = function(data) {
      if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
      return originalJson.call(this, data);
    };
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// ── Addons system paths (env-overridable for testability) ─────────────────────
// ADDONS_STATE_FILE — runtime install state, persisted on the /data mount
// ADDONS_BIN_DIR    — install target for target:"os" binaries; on /data so it
//                     survives container restarts and is added to the shell PATH
const ADDONS_STATE_FILE = process.env.ADDONS_STATE_FILE || '/data/addons-state.json';
const ADDONS_BIN_DIR    = process.env.ADDONS_BIN_DIR    || '/data/addons/bin';

// ── Shared utilities ──────────────────────────────────────────────────────────

async function runCommand(cmd, timeoutMs = 15000) {
  try {
    const { stdout } = await execAsync(cmd, {
      timeout:  timeoutMs,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH:       `${ADDONS_BIN_DIR}:${process.env.PATH || ''}`,
        KUBECONFIG: process.env.KUBECONFIG || '/root/.kube/config',
      },
    });
    return { success: true, output: stdout.trim() };
  } catch (e) {
    return { success: false, output: (e.stdout || '').trim(), error: (e.stderr || e.message || '').trim() };
  }
}

function checkMatch(actual, expected, matchType) {
  const a = String(actual).trim();
  const e = String(expected).trim();
  if (matchType === 'exact')       return a === e;
  if (matchType === 'contains')    return a.includes(e);
  if (matchType === 'not_contains') return !a.includes(e);
  if (matchType === 'regex')       return new RegExp(e).test(a);
  return a === e;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Initial cache populate
reloadCache();

// Addons: repair any jobs left mid-flight by a previous container run
try {
  const state      = readState(ADDONS_STATE_FILE);
  const reconciled = reconcileInterrupted(state);
  if (JSON.stringify(reconciled) !== JSON.stringify(state)) {
    writeState(ADDONS_STATE_FILE, reconciled);
    console.log('Reconciled interrupted addon jobs from a previous run.');
  }
} catch (e) {
  console.error('Addon state reconciliation failed:', e.message);
}

// ── Mount routes ──────────────────────────────────────────────────────────────

const routeDeps = { loadProgress, saveProgress, runCommand, checkMatch };

app.use('/api/tracks',    createTracksRouter(routeDeps));
app.use('/api/bundles',   createBundlesRouter(routeDeps));
app.use('/api/scenarios', createScenariosRouter(routeDeps));
app.use('/api/progress',  createProgressRouter(routeDeps));
app.use('/api/sessions',  createSessionsRouter(routeDeps));
app.use('/api/cache',     createCacheRouter());
app.use('/api/health',    createHealthRouter(routeDeps));

// Addons API — async install/remove engine + SSE streaming
const addonEngine = createJobEngine({
  loadAddons,
  stateFile: ADDONS_STATE_FILE,
  binDir:    ADDONS_BIN_DIR,
});
app.use('/api/addons', createAddonsRouter({ loadAddons, stateFile: ADDONS_STATE_FILE, engine: addonEngine }));

// Best-effort: re-install addons whose health check fails after a restart
// (e.g. OS binaries lost on an ephemeral filesystem). Non-blocking.
addonEngine.healthReconcile().catch(e => console.error('addon health reconcile failed:', e.message));

// Fallback to frontend SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// ── HTTP + WebSocket PTY terminal ─────────────────────────────────────────────
const http   = require('http');
const server = http.createServer(app);

createTerminalServer(server);

server.listen(PORT, () => console.log(`API server running on :${PORT}`));
