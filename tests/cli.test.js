import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildClaudeArgs, buildLocalProxyBaseUrl } from '../src/cli/service.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'cclens.js');

test('cclens help exposes the unified command surface', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help'], {
    cwd: repoRoot
  });

  assert.doesNotMatch(stdout, /cclens start/);
  assert.match(stdout, /cclens -p "hello"/);
  assert.match(stdout, /cclens --resume/);
  assert.match(stdout, /Claude Code passthrough/);
  assert.match(stdout, /proxy\s+Start only the local API proxy/);
  assert.match(stdout, /viz\s+Start\/open the browser log visualizer/);
  assert.match(stdout, /extract \[log-file\]\s+Extract prompts\/tools from a log file/);
  assert.match(stdout, /trace\s+Find Lead\/Subagent traces and export Markdown/);
  assert.match(stdout, /cclens proxy --help/);
});

test('cclens exposes its package version', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--version'], {
    cwd: repoRoot
  });

  assert.equal(stdout.trim(), packageJson.version);
});

test('cclens passthrough uses the generated monitor settings file by default', () => {
  const args = buildClaudeArgs(['-p', 'hello']);
  assert.deepEqual(args.slice(0, 2), ['-p', 'hello']);
  assert.equal(args[2], '--settings');
  assert.match(args[3], /\.claude-code-lens\/settings\.json$/);
  assert.deepEqual(
    buildClaudeArgs(['--settings', '/tmp/custom-settings.json', '--resume']),
    ['--settings', '/tmp/custom-settings.json', '--resume']
  );
});

test('local proxy base URL stays a unified local origin', () => {
  assert.equal(buildLocalProxyBaseUrl(18888), 'http://localhost:18888');
});

test('monitor subcommands provide detailed help', async () => {
  const cases = [
    ['proxy', /Starts only the local Anthropic-compatible proxy/],
    ['stop', /Does not kill unrelated processes/],
    ['status', /Current port owner from lsof/],
    ['viz', /Reads log files from ~\/.claude-code-lens\/raw_logs\//],
    ['extract', /With no file argument, reads the newest file/],
    ['trace', /Provides agent-first structured trace discovery/],
    ['config', /Resolution order:/]
  ];

  for (const [command, expected] of cases) {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, command, '--help'], {
      cwd: repoRoot
    });
    assert.match(stdout, new RegExp(`Usage: cclens ${command}`));
    assert.match(stdout, expected);
  }
});

test('cclens help <command> shows command help', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'help', 'viz'], {
    cwd: repoRoot
  });

  assert.match(stdout, /Usage: cclens viz/);
  assert.match(stdout, /Starts the browser visualizer if needed/);
});

test('cclens config prints resolved monitor config', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: path.join(repoRoot, '.tmp-empty-monitor-home'),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: 'https://example.com',
      CLAUDE_CODE_LENS_PROXY_PORT: '19001'
    }
  });

  const config = JSON.parse(stdout);
  assert.equal(config.proxy.port, 19001);
  assert.equal(config.target.baseUrl, 'https://example.com');
});

test('cclens config defaults to the Claude Code Lens home directory', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: '',
      CLAUDE_CODE_LENS_TARGET_BASE_URL: 'https://example.com'
    }
  });

  const config = JSON.parse(stdout);
  assert.equal(config.app.home, path.join(os.homedir(), '.claude-code-lens'));
});

test('cclens config prefers prefixed environment overrides', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: path.join(repoRoot, '.tmp-prefixed-monitor-home'),
      CLAUDE_CODE_LENS_PROXY_HOST: '127.0.0.1',
      CLAUDE_CODE_LENS_PROXY_PORT: '19011',
      CLAUDE_CODE_LENS_TARGET_BASE_URL: 'https://prefixed.example.com',
      CLAUDE_CODE_LENS_TARGET_TIMEOUT: '30000',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: '5511',
      CLAUDE_CODE_LENS_LOGGING_ENABLE_CONSOLE: 'true'
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

test('cclens config reads visualizer port from user config and env', async () => {
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'cclens-config-test-'));
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
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_TARGET_BASE_URL: 'https://example.com',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: ''
    }
  });
  assert.equal(JSON.parse(fromConfig.stdout).visualizer.port, 5512);

  const fromEnv = await execFileAsync(process.execPath, [cliPath, 'config'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_TARGET_BASE_URL: 'https://example.com',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: '5513'
    }
  });
  assert.equal(JSON.parse(fromEnv.stdout).visualizer.port, 5513);
});
