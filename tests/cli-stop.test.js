import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'cc-monitor.js');

function hasLsof() {
  try {
    execFileSync('lsof', ['-v'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function assertServerAlive(port) {
  const response = await fetch(`http://127.0.0.1:${port}/ping`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'pong');
}

test('cc-monitor stop does not kill an unrelated process on the configured port', async (t) => {
  if (!hasLsof()) {
    t.skip('lsof is required for this CLI behavior');
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  t.after(() => closeServer(server));

  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'cc-monitor-stop-test-'));
  t.after(() => rm(monitorHome, { recursive: true, force: true }));

  let result;
  try {
    result = await execFileAsync(process.execPath, [cliPath, 'stop'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAUDE_MONITOR_HOME: monitorHome,
        CLAUDE_MONITOR_PROXY_PORT: String(port)
      }
    });
  } catch (error) {
    result = {
      stdout: error.stdout,
      stderr: error.stderr,
      code: error.code
    };
  }

  assert.equal(result.code, 1);
  assert.match(result.stdout, /为避免误杀已跳过端口清理/);
  await assertServerAlive(port);
});
