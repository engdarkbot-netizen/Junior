/**
 * Self-contained test runner for GroceryCompare SA
 * Usage: node run-tests.mjs
 *
 * Starts the server in DEMO mode (no proxy needed), waits for it to be ready,
 * runs the full test suite, then shuts down the server automatically.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT || 3999; // Use a dedicated test port to avoid conflicts

// ── Start the server ─────────────────────────────────────────────────────────
console.log(`\nStarting server on port ${PORT} (DEMO mode)…`);

const server = spawn('node', ['server.js'], {
  env: { ...process.env, FORCE_DEMO: '1', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';

server.stdout.on('data', d => {
  const line = d.toString();
  serverOutput += line;
  // Show relevant startup lines only
  if (/ready|listening|DEMO|error/i.test(line)) process.stdout.write(`  [server] ${line}`);
});

server.stderr.on('data', d => {
  process.stderr.write(`  [server:err] ${d}`);
});

server.on('exit', (code, sig) => {
  if (code !== null && code !== 0 && !sig) {
    console.error(`\nServer exited with code ${code}`);
  }
});

// ── Wait until /api/health responds ──────────────────────────────────────────
async function waitForServer(maxWaitMs = 30_000) {
  const url = `http://localhost:${PORT}/api/health`;
  const deadline = Date.now() + maxWaitMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.status === 'ok') return true;
      }
    } catch (_) {
      // not ready yet
    }
    attempts++;
    await sleep(600);
  }

  console.error(`\nServer did not become ready after ${maxWaitMs / 1000}s (${attempts} attempts)`);
  return false;
}

// ── Run test-api.mjs as a child process ───────────────────────────────────────
async function runTests() {
  return new Promise((resolve) => {
    const tester = spawn('node', ['test-api.mjs'], {
      env: { ...process.env, BASE_URL: `http://localhost:${PORT}` },
      stdio: 'inherit',
    });

    tester.on('exit', (code) => resolve(code ?? 1));
    tester.on('error', (err) => {
      console.error('Failed to start test process:', err.message);
      resolve(1);
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
let exitCode = 1;

try {
  const ready = await waitForServer(30_000);

  if (!ready) {
    console.error('Aborting — server never became healthy.');
    console.error('Last server output:\n', serverOutput.slice(-500));
  } else {
    console.log(`\nServer ready. Running tests against port ${PORT}…\n`);
    exitCode = await runTests();
  }
} finally {
  server.kill('SIGTERM');
  await sleep(300); // brief grace period
  process.exit(exitCode);
}
