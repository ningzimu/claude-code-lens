import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'cc-monitor.js');

test('cc-monitor help exposes the unified command surface', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help'], {
    cwd: repoRoot
  });

  assert.doesNotMatch(stdout, /cc-monitor start/);
  assert.match(stdout, /cc-monitor -p "hello"/);
  assert.match(stdout, /cc-monitor --resume/);
  assert.match(stdout, /Claude Code passthrough/);
  assert.match(stdout, /proxy\s+Start only the local API proxy/);
  assert.match(stdout, /viz\s+Start\/open the browser log visualizer/);
  assert.match(stdout, /extract \[log-file\]\s+Extract prompts\/tools from a log file/);
  assert.match(stdout, /cc-monitor proxy --help/);
});

test('monitor subcommands provide detailed help', async () => {
  const cases = [
    ['proxy', /Starts only the local Anthropic-compatible proxy/],
    ['stop', /Does not kill unrelated processes/],
    ['status', /Current port owner from lsof/],
    ['viz', /Reads log files from ~\/.claude-code-monitor\/raw_logs\//],
    ['extract', /With no file argument, reads the newest file/],
    ['config', /Resolution order:/]
  ];

  for (const [command, expected] of cases) {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, command, '--help'], {
      cwd: repoRoot
    });
    assert.match(stdout, new RegExp(`Usage: cc-monitor ${command}`));
    assert.match(stdout, expected);
  }
});

test('cc-monitor help <command> shows command help', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'help', 'viz'], {
    cwd: repoRoot
  });

  assert.match(stdout, /Usage: cc-monitor viz/);
  assert.match(stdout, /Starts the browser visualizer if needed/);
});

test('cc-monitor config prints resolved monitor config', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_MONITOR_HOME: path.join(repoRoot, '.tmp-empty-monitor-home'),
      CLAUDE_MONITOR_TARGET_BASE_URL: 'https://example.com',
      CLAUDE_MONITOR_PROXY_PORT: '19001'
    }
  });

  const config = JSON.parse(stdout);
  assert.equal(config.proxy.port, 19001);
  assert.equal(config.target.baseUrl, 'https://example.com');
});

test('cc-monitor config prefers prefixed environment overrides', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_MONITOR_HOME: path.join(repoRoot, '.tmp-prefixed-monitor-home'),
      CLAUDE_MONITOR_PROXY_HOST: '127.0.0.1',
      CLAUDE_MONITOR_PROXY_PORT: '19011',
      CLAUDE_MONITOR_TARGET_BASE_URL: 'https://prefixed.example.com',
      CLAUDE_MONITOR_TARGET_TIMEOUT: '30000',
      CLAUDE_MONITOR_VISUALIZER_PORT: '5511',
      CLAUDE_MONITOR_LOGGING_ENABLE_CONSOLE: 'true'
    }
  });

  const config = JSON.parse(stdout);
  assert.equal(config.proxy.host, '127.0.0.1');
  assert.equal(config.proxy.port, 19011);
  assert.equal(config.target.baseUrl, 'https://prefixed.example.com');
  assert.equal(config.target.timeout, 30000);
  assert.equal(config.visualizer.port, 5511);
  assert.equal(config.logging.enableConsole, true);
});

test('cc-monitor config reads visualizer port from user config and env', async () => {
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'cc-monitor-config-test-'));
  await mkdir(monitorHome, { recursive: true });
  await writeFile(
    path.join(monitorHome, 'config.json'),
    JSON.stringify({
      visualizer: {
        port: 5512
      }
    })
  );

  const fromConfig = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_MONITOR_HOME: monitorHome,
      CLAUDE_MONITOR_TARGET_BASE_URL: 'https://example.com',
      CLAUDE_MONITOR_VISUALIZER_PORT: ''
    }
  });
  assert.equal(JSON.parse(fromConfig.stdout).visualizer.port, 5512);

  const fromEnv = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_MONITOR_HOME: monitorHome,
      CLAUDE_MONITOR_TARGET_BASE_URL: 'https://example.com',
      CLAUDE_MONITOR_VISUALIZER_PORT: '5513'
    }
  });
  assert.equal(JSON.parse(fromEnv.stdout).visualizer.port, 5513);
});
