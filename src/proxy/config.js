import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseBoolean, parseInteger, readEnv } from '../config/env.js';
import { DEFAULT_TARGET_BASE_URL, resolveTargetBaseUrl } from '../config/target-discovery.js';

export const APP_HOME = process.env.CLAUDE_MONITOR_HOME ||
  path.join(os.homedir(), '.claude-code-monitor');
export const USER_CONFIG_PATH = path.join(APP_HOME, 'config.json');

const defaultConfig = {
  proxy: {
    host: '0.0.0.0',
    port: 18888
  },
  target: {
    baseUrl: DEFAULT_TARGET_BASE_URL,
    timeout: 120000
  },
  visualizer: {
    host: '127.0.0.1',
    port: 5500
  },
  logging: {
    enableConsole: false
  },
  headers: {
    blacklist: [
      'host',
      'content-length',
      'connection'
    ]
  }
};

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function mergeDeep(base, override) {
  const result = { ...base };

  for (const [key, value] of Object.entries(override || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergeDeep(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function applyEnvironmentOverrides(config, userConfig) {
  const next = mergeDeep({}, config);

  next.proxy = {
    ...next.proxy,
    host: readEnv(process.env, 'CLAUDE_MONITOR_PROXY_HOST') || next.proxy.host,
    port: parseInteger(readEnv(process.env, 'CLAUDE_MONITOR_PROXY_PORT'), next.proxy.port)
  };

  next.target = {
    ...next.target,
    baseUrl: resolveTargetBaseUrl({
      env: process.env,
      cwd: process.cwd(),
      homeDir: os.homedir(),
      userConfig,
      proxyPort: next.proxy.port
    }).baseUrl,
    timeout: parseInteger(readEnv(process.env, 'CLAUDE_MONITOR_TARGET_TIMEOUT'), next.target.timeout)
  };

  next.visualizer = {
    ...next.visualizer,
    host: readEnv(process.env, 'CLAUDE_MONITOR_VISUALIZER_HOST') || next.visualizer.host,
    port: parseInteger(readEnv(process.env, 'CLAUDE_MONITOR_VISUALIZER_PORT'), next.visualizer.port)
  };

  next.logging = {
    ...next.logging,
    enableConsole: parseBoolean(readEnv(process.env, 'CLAUDE_MONITOR_LOGGING_ENABLE_CONSOLE'), next.logging.enableConsole)
  };

  return next;
}

const userConfig = readJsonFile(USER_CONFIG_PATH);

export const appConfig = applyEnvironmentOverrides(mergeDeep(defaultConfig, userConfig), userConfig);

export default appConfig;
