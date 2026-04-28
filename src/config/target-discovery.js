import fs from 'fs';
import os from 'os';
import path from 'path';
import { readEnv } from './env.js';

export const DEFAULT_TARGET_BASE_URL = 'https://api.anthropic.com';

function cleanBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function isMonitorProxyUrl(value, proxyPort) {
  if (!value || !proxyPort) return false;

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

    return (
      String(port) === String(proxyPort) &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
    );
  } catch (e) {
    return false;
  }
}

function firstUsableBaseUrl(candidates, proxyPort) {
  for (const candidate of candidates) {
    const baseUrl = cleanBaseUrl(candidate?.baseUrl);
    if (!baseUrl || isMonitorProxyUrl(baseUrl, proxyPort)) {
      continue;
    }
    return {
      baseUrl,
      source: candidate.source
    };
  }

  return {
    baseUrl: DEFAULT_TARGET_BASE_URL,
    source: 'default'
  };
}

function readSettingsBaseUrl(settingsPath) {
  try {
    if (!settingsPath || !fs.existsSync(settingsPath)) {
      return null;
    }

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return cleanBaseUrl(settings?.env?.ANTHROPIC_BASE_URL);
  } catch (e) {
    return null;
  }
}

function settingsPathCandidates({ explicitSettingsPath, cwd, homeDir }) {
  const paths = [];

  if (explicitSettingsPath) {
    paths.push(path.resolve(cwd, explicitSettingsPath));
  }

  paths.push(
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.json')
  );

  return Array.from(new Set(paths));
}

export function findSettingsArg(args = []) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--settings') {
      return args[i + 1] || null;
    }
    if (typeof arg === 'string' && arg.startsWith('--settings=')) {
      return arg.slice('--settings='.length) || null;
    }
  }
  return null;
}

export function resolveTargetBaseUrl(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || os.homedir();
  const userConfig = options.userConfig || {};
  const proxyPort = options.proxyPort;
  const explicitSettingsPath = options.explicitSettingsPath || findSettingsArg(options.claudeArgs || []);

  const settingsCandidates = settingsPathCandidates({
    explicitSettingsPath,
    cwd,
    homeDir
  }).map(settingsPath => ({
    baseUrl: readSettingsBaseUrl(settingsPath),
    source: `settings:${settingsPath}`
  }));

  return firstUsableBaseUrl([
    {
      baseUrl: readEnv(env, 'CLAUDE_MONITOR_TARGET_BASE_URL'),
      source: 'env:CLAUDE_MONITOR_TARGET_BASE_URL'
    },
    {
      baseUrl: userConfig?.target?.baseUrl,
      source: 'config:target.baseUrl'
    },
    {
      baseUrl: env.ANTHROPIC_BASE_URL,
      source: 'env:ANTHROPIC_BASE_URL'
    },
    ...settingsCandidates
  ], proxyPort);
}
