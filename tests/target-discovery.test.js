import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findSettingsArg, resolveTargetBaseUrl } from '../src/config/target-discovery.js';

test('target discovery prefers explicit monitor configuration sources', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-target-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-target-cwd-'));

  const result = resolveTargetBaseUrl({
    env: {
      CLAUDE_MONITOR_TARGET_BASE_URL: 'https://target.example.com',
      ANTHROPIC_BASE_URL: 'https://anthropic-env.example.com'
    },
    userConfig: {
      target: {
        baseUrl: 'https://config.example.com'
      }
    },
    homeDir,
    cwd,
    proxyPort: 18888
  });

  assert.deepEqual(result, {
    baseUrl: 'https://target.example.com',
    source: 'env:CLAUDE_MONITOR_TARGET_BASE_URL'
  });
});

test('target discovery reads Claude Code settings when monitor config is absent', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-target-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-target-cwd-'));
  const settingsDir = path.join(cwd, '.claude');
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, 'settings.local.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://settings.example.com'
      }
    })
  );

  const result = resolveTargetBaseUrl({
    env: {},
    userConfig: {},
    homeDir,
    cwd,
    proxyPort: 18888
  });

  assert.deepEqual(result, {
    baseUrl: 'https://settings.example.com',
    source: `settings:${path.join(settingsDir, 'settings.local.json')}`
  });
});

test('target discovery ignores the monitor proxy URL to avoid forwarding loops', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-target-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-target-cwd-'));

  const result = resolveTargetBaseUrl({
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:18888'
    },
    userConfig: {},
    homeDir,
    cwd,
    proxyPort: 18888
  });

  assert.deepEqual(result, {
    baseUrl: 'https://api.anthropic.com',
    source: 'default'
  });
});

test('target discovery supports both Claude Code settings argument styles', () => {
  assert.equal(findSettingsArg(['--settings', '/tmp/claude-settings.json']), '/tmp/claude-settings.json');
  assert.equal(findSettingsArg(['--settings=/tmp/claude-settings.json']), '/tmp/claude-settings.json');
  assert.equal(findSettingsArg(['-p', 'hello']), null);
});
