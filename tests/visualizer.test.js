import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const visualizerPath = path.join(repoRoot, 'src', 'visualizer', 'server.js');
const reloadPositionPath = path.join(repoRoot, 'src', 'visualizer', 'public', 'reload-position.js');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitForHttp(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) {
        return response;
      }
    } catch (error) {
      // Retry until deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test('visualizer server reads port from monitor config', async (t) => {
  const port = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-visualizer-test-'));
  await mkdir(monitorHome, { recursive: true });
  await writeFile(
    path.join(monitorHome, 'config.json'),
    JSON.stringify({
      visualizer: { port }
    })
  );

  const child = spawn(process.execPath, [visualizerPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND: 'true',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: ''
    }
  });
  t.after(() => child.kill('SIGTERM'));

  const response = await waitForHttp(`http://127.0.0.1:${port}/__claude-code-lens/health`);
  assert.equal(response.status, 200);
});

test('visualizer log API sorts files by modified time descending', async (t) => {
  const port = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-visualizer-test-'));
  const logsDir = path.join(monitorHome, 'raw_logs');
  await mkdir(logsDir, { recursive: true });

  const oldLog = path.join(logsDir, 'old.json');
  const newLog = path.join(logsDir, 'new.json');
  await writeFile(oldLog, '{}');
  await writeFile(newLog, '{}');
  await utimes(oldLog, new Date('2026-04-27T00:00:00Z'), new Date('2026-04-27T00:00:00Z'));
  await utimes(newLog, new Date('2026-04-28T00:00:00Z'), new Date('2026-04-28T00:00:00Z'));

  const child = spawn(process.execPath, [visualizerPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND: 'true',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: String(port)
    }
  });
  t.after(() => child.kill('SIGTERM'));

  const response = await waitForHttp(`http://127.0.0.1:${port}/api/logs`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.logs.map(log => log.name), ['new.json', 'old.json']);
});

test('visualizer live reload follows newest request only when already at latest', async () => {
  await import(`${pathToFileURL(reloadPositionPath).href}?cache=${Date.now()}`);
  const { normalizeLoadOptions, resolveTargetIndex } = globalThis.CCLensReloadPosition;
  const options = normalizeLoadOptions({ preservePosition: true });

  assert.equal(resolveTargetIndex({
    total: 15,
    options,
    previousIndex: 13,
    previousTotal: 14,
    storedIndex: 6
  }), 14);

  assert.equal(resolveTargetIndex({
    total: 15,
    options,
    previousIndex: 6,
    previousTotal: 14,
    storedIndex: 6
  }), 6);

  assert.equal(resolveTargetIndex({
    total: 15,
    options: normalizeLoadOptions({ preferLatest: true }),
    storedIndex: 6
  }), 14);
});
