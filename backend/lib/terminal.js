'use strict';

const http      = require('http');
const WebSocket = require('ws');
const pty       = require('node-pty');

// ── Active connection tracking ────────────────────────────────────────────────
// Exported so routes/scenarios.js can inject terminal output without coupling
// to the WebSocket server directly.

/** Set of all open WebSocket clients. Output is written directly — never via shell stdin. */
const activeWsClients = new Set();

/** Set of all live PTY shells. Used only to send '\r' to repaint the bash prompt. */
const activeShells    = new Set();

// ── Public helpers (injected into routes that need them) ──────────────────────

/**
 * Write `text` as terminal output to every connected browser tab.
 * Never touches shell stdin — safe to call at any time.
 *
 * @param {string} text
 */
function injectToTerminal(text) {
  for (const ws of activeWsClients) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(text); } catch (_) {}
  }
}

/**
 * Send a carriage-return to every live PTY shell so bash repaints its PS1 prompt.
 *
 * @param {number} [delayMs=80]
 */
function refreshPrompt(delayMs = 80) {
  setTimeout(() => {
    for (const shell of activeShells) {
      try { shell.write('\r'); } catch (_) {}
    }
  }, delayMs);
}

// ── Terminal server factory ───────────────────────────────────────────────────

/**
 * Attach a WebSocket PTY server to an existing Node.js http.Server.
 * Upgrades on `/shell-ws` are accepted; all others are destroyed.
 *
 * @param {http.Server} httpServer  — the server created around the Express app
 * @returns {http.Server}           — the same server (for chaining / listen)
 */
function createTerminalServer(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on('connection', (ws) => {
    activeWsClients.add(ws);

    const shell = pty.spawn('/bin/bash', [], {
      name: 'xterm-256color',
      cols:  80,
      rows:  24,
      cwd:   '/root',
      env: {
        ...process.env,
        KUBECONFIG: '/root/.kube/config',
        HOME:       '/root',
        TERM:       'xterm-256color',
      },
    });

    activeShells.add(shell);

    // Forward PTY output → browser
    shell.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    shell.onExit(() => {
      activeWsClients.delete(ws);
      activeShells.delete(shell);
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    // Forward browser input → PTY
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'resize') {
          shell.resize(Number(parsed.cols) || 80, Number(parsed.rows) || 24);
          return;
        }
      } catch (_) { /* not JSON → raw keystroke input */ }
      shell.write(typeof msg === 'string' ? msg : msg.toString());
    });

    const cleanup = () => {
      activeWsClients.delete(ws);
      activeShells.delete(shell);
      try { shell.kill(); } catch (_) {}
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // Accept WebSocket upgrades only on /shell-ws
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/shell-ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  return httpServer;
}

module.exports = { createTerminalServer, injectToTerminal, refreshPrompt };
