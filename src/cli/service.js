#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import os from 'os';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import readline from 'readline';
import { parseInteger, readEnv } from '../config/env.js';
import { findSettingsArg, resolveTargetBaseUrl } from '../config/target-discovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Color definitions
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  reset: '\x1b[0m'
};

const PROJECT_ROOT = join(__dirname, '..', '..');
const serverPath = join(PROJECT_ROOT, 'src', 'proxy', 'server.js');
const visualizerPath = join(PROJECT_ROOT, 'src', 'visualizer', 'server.js');

const APP_HOME = process.env.CLAUDE_CODE_LENS_HOME ||
  path.join(os.homedir(), '.claude-code-lens');
const LEGACY_APP_HOME = path.join(os.homedir(), '.claude-code-monitor');
const APP_LOG_DIR = path.join(APP_HOME, 'logs');
const PID_FILE = path.join(APP_LOG_DIR, 'proxy.pid');
const VISUALIZER_PID_FILE = path.join(APP_LOG_DIR, 'visualizer.pid');
const LEGACY_VISUALIZER_PID_FILE = path.join(LEGACY_APP_HOME, 'logs', 'visualizer.pid');
const LOG_FILE = path.join(APP_LOG_DIR, 'proxy-server.log');
const VISUALIZER_LOG_FILE = path.join(APP_LOG_DIR, 'visualizer.log');
const USER_CONFIG_FILE = path.join(APP_HOME, 'config.json');
const SETTINGS_FILE = path.join(APP_HOME, 'settings.json');
const MONITOR_VERBOSE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.CLAUDE_CODE_LENS_VERBOSE || '').toLowerCase()
);

// Check if server file exists
if (!fs.existsSync(serverPath)) {
  console.error(`${colors.red}❌ 错误: 找不到服务器文件:${colors.reset}`, serverPath);
  process.exit(1);
}

// ============================================
// Helper Functions
// ============================================

/**
 * Ask user a yes/no question
 */
function askQuestion(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      // Default to yes if empty
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Get port from config or environment variable
 */
function getPort() {
  // 1. 优先使用环境变量 (用于 server 子进程)
  const envPort = readEnv(process.env, 'CLAUDE_CODE_LENS_PROXY_PORT');
  if (envPort) {
    return parseInteger(envPort, 18888);
  }

  // 2. 尝试从用户配置读取
  try {
    if (fs.existsSync(USER_CONFIG_FILE)) {
      const userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf-8'));
      if (userConfig.proxy && userConfig.proxy.port) {
        return parseInt(userConfig.proxy.port, 10);
      }
    }
  } catch (e) {
    // Ignore errors, fallback to legacy/default
  }

  // 3. 默认端口
  return 18888;
}

function readUserConfig() {
  try {
    if (fs.existsSync(USER_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    // Ignore invalid config here; proxy config will report startup failures.
  }
  return {};
}

function getVisualizerPort() {
  const config = readUserConfig();
  return parseInteger(
    readEnv(process.env, 'CLAUDE_CODE_LENS_VISUALIZER_PORT'),
    parseInteger(config?.visualizer?.port, 5500)
  );
}

function discoverTargetBaseUrl(options = {}) {
  return resolveTargetBaseUrl({
    env: process.env,
    cwd: process.cwd(),
    homeDir: os.homedir(),
    userConfig: readUserConfig(),
    proxyPort: options.proxyPort || getPort(),
    explicitSettingsPath: options.explicitSettingsPath,
    claudeArgs: options.claudeArgs || []
  });
}

/**
 * Check if port is occupied
 */
function checkPortAvailability(port) {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
    return pids ? pids.split('\n') : null;
  } catch (e) {
    return null;
  }
}

/**
 * Read PID from file
 */
function readPidFile(file = PID_FILE) {
  try {
    if (fs.existsSync(file)) {
      const pid = parseInt(fs.readFileSync(file, 'utf-8').trim(), 10);
      return pid;
    }
  } catch (e) {
    // Ignore errors
  }
  return null;
}

/**
 * Check if process exists
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function getProcessCommand(pid) {
  try {
    return execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (e) {
    return null;
  }
}

function isProjectProcess(pid, scriptPath, trustedPid = null) {
  const command = getProcessCommand(pid);
  if (command) {
    if (command.includes(scriptPath)) {
      return true;
    }
    const normalized = command.replaceAll('\\', '/');
    if (scriptPath.replaceAll('\\', '/').endsWith('/src/proxy/server.js')) {
      return normalized.includes('/src/proxy/server.js') &&
        (
          normalized.includes('/claude-code-lens/') ||
          normalized.includes('/claude-code-monitor/') ||
          normalized.includes('/claude-code-reverse/')
        );
    }
    return false;
  }
  return trustedPid !== null && parseInt(pid, 10) === parseInt(trustedPid, 10);
}

function isVisualizerProcess(pid, trustedPid = null) {
  const command = getProcessCommand(pid);
  if (command) {
    const normalized = command.replaceAll('\\', '/');
    return normalized.includes('/src/visualizer/server.js') &&
      (
        normalized.includes('/claude-code-lens/') ||
        normalized.includes('/claude-code-monitor/') ||
        normalized.includes('/claude-code-reverse/')
      );
  }
  return trustedPid !== null && parseInt(pid, 10) === parseInt(trustedPid, 10);
}

/**
 * Kill process by PID
 */
function killProcess(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Create log directories
 */
function ensureLogDirectories() {
  if (!fs.existsSync(APP_LOG_DIR)) {
    fs.mkdirSync(APP_LOG_DIR, { recursive: true });
  }

  return {
    serverLog: LOG_FILE
  };
}

function waitForHttp(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      let settled = false;
      const req = http.get(url, (res) => {
        settled = true;
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });

      req.setTimeout(1000, () => {
        if (!settled) {
          settled = true;
          req.destroy();
          retry();
        }
      });

      req.on('error', () => {
        if (!settled) {
          settled = true;
          retry();
        }
      });
    };

    const retry = () => {
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 150);
    };

    check();
  });
}

function openBrowser(url) {
  if (process.env.CLAUDE_CODE_LENS_OPEN_BROWSER === 'false') {
    return false;
  }

  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Print header
 */
function printHeader(title) {
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.yellow}${title}${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
}

function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

function monitorLog(message) {
  console.error(message);
}

function verboseLog(message) {
  if (MONITOR_VERBOSE) {
    monitorLog(message);
  }
}

// ============================================
// proxy Subcommand
// ============================================

async function proxySubcommand() {
  printHeader('🚀 启动 Claude Code 反向代理服务器');

  const port = getPort();
  const pids = checkPortAvailability(port);
  const savedPid = readPidFile();

  // Check if server is already running
  if (pids || (savedPid && isProcessRunning(savedPid))) {
    console.log(`${colors.yellow}⚠️  代理服务器已在运行${colors.reset}`);

    if (pids) {
      console.log(`${colors.yellow}   端口 ${port} 占用进程: PID ${pids.join(', ')}${colors.reset}`);
    }

    if (savedPid && isProcessRunning(savedPid)) {
      console.log(`${colors.yellow}   PID 文件记录: ${savedPid}${colors.reset}`);
    }

    console.log('');
    const shouldRestart = await askQuestion(`${colors.yellow}是否重启服务? [Y/n]: ${colors.reset}`);

    if (!shouldRestart) {
      console.log(`${colors.cyan}已取消操作${colors.reset}`);
      process.exit(0);
    }

    console.log(`${colors.yellow}正在重启服务器...${colors.reset}`);
    console.log('');
    await stopSubcommand(true);
    console.log('');
  }

  // Start server
  const remainingPids = checkPortAvailability(port);
  if (remainingPids && remainingPids.length > 0) {
    console.error(`${colors.red}❌ 端口 ${port} 仍被占用,未启动代理服务器${colors.reset}`);
    console.error(`${colors.yellow}   占用进程: PID ${remainingPids.join(', ')}${colors.reset}`);
    console.error(`${colors.yellow}   为避免误杀其他程序,请先释放端口或修改 ~/.claude-code-lens/config.json 中的 proxy.port${colors.reset}`);
    process.exit(1);
  }

  const target = discoverTargetBaseUrl({ proxyPort: port });

  console.log(`${colors.yellow}📡 正在启动代理服务器...${colors.reset}`);
  console.log(`   端口: ${colors.green}${port}${colors.reset}`);
  console.log(`   上游: ${colors.green}${target.baseUrl}${colors.reset}`);
  console.log(`   日志: ${colors.blue}${LOG_FILE}${colors.reset}`);

  ensureLogDirectories();

  // Open log file
  const logFile = fs.openSync(LOG_FILE, 'a');

  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: ['ignore', logFile, logFile],
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_PROXY_PORT: port.toString(),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: target.baseUrl
    }
  });

  child.unref();

  // Save PID
  fs.writeFileSync(PID_FILE, child.pid.toString());

  const healthUrl = `http://127.0.0.1:${port}/__claude-code-lens/health`;
  const isReady = await waitForHttp(healthUrl, 5000);

  // Verify startup
  if (isReady && isProcessRunning(child.pid)) {
    // Update settings.json with current port
    updateSettingsFile(buildLocalProxyBaseUrl(port));

    console.log('');
    console.log(`${colors.green}✅ 代理服务器启动成功!${colors.reset}`);
    console.log('');
    printHeader('📋 服务信息');
    console.log(`   进程 PID: ${colors.green}${child.pid}${colors.reset}`);
    console.log(`   监听端口: ${colors.green}http://localhost:${port}${colors.reset}`);
    console.log(`   日志文件: ${colors.blue}${LOG_FILE}${colors.reset}`);
    console.log(`   PID 文件: ${colors.blue}${PID_FILE}${colors.reset}`);
    console.log('');
    printHeader('💡 配置 Claude Code 使用代理');
    console.log(`${colors.cyan}方式 1: 使用 --settings 参数${colors.reset} ${colors.yellow}(推荐,配置文件已创建)${colors.reset}`);
    console.log(`   ${colors.green}claude --settings ~/.claude-code-lens/settings.json${colors.reset}`);
    console.log('');
    console.log(`${colors.cyan}方式 2: 修改用户级配置${colors.reset} ${colors.yellow}(全局生效,所有项目)${colors.reset}`);
    console.log(`   编辑文件: ${colors.blue}~/.claude/settings.json${colors.reset}`);
    console.log('   添加内容:');
    console.log(`   ${colors.green}{`);
    console.log(`     "env": {`);
    console.log(`       "ANTHROPIC_BASE_URL": "http://localhost:${port}"`);
    console.log(`     }`);
    console.log(`   }${colors.reset}`);
    console.log('');
    console.log(`${colors.cyan}方式 3: 修改项目级配置${colors.reset} ${colors.yellow}(仅当前项目生效)${colors.reset}`);
    console.log(`   创建文件: ${colors.blue}.claude/settings.json${colors.reset} 或 ${colors.blue}.claude/settings.local.json${colors.reset}`);
    console.log('   添加内容: (同方式 2)');
    console.log('');
    printHeader('📋 管理命令');
    console.log(`   查看实时日志: ${colors.green}tail -f ${LOG_FILE}${colors.reset}`);
    console.log(`   停止代理:     ${colors.green}cclens stop${colors.reset}`);
    console.log(`   查看状态:     ${colors.green}cclens status${colors.reset}`);
    console.log('');
  } else {
    console.log(`${colors.red}❌ 代理服务器启动失败${colors.reset}`);
    console.log(`${colors.yellow}   请查看日志: tail -f ${LOG_FILE}${colors.reset}`);
    try {
      fs.unlinkSync(PID_FILE);
    } catch (e) {
      // Ignore errors
    }
    process.exit(1);
  }
}

// ============================================
// --stop Subcommand
// ============================================

async function stopSubcommand(silent = false) {
  if (!silent) {
    printHeader('🛑 停止 Claude Code Lens 后台服务');
  }

  const port = getPort();
  let stopped = false;
  let proxyStopFailed = false;

  // Method 1: Stop via PID file
  const savedPid = readPidFile();
  if (savedPid) {
    if (isProcessRunning(savedPid)) {
      if (isProjectProcess(savedPid, serverPath, savedPid)) {
        console.log(`${colors.yellow}📋 通过 PID 停止进程 ${savedPid}...${colors.reset}`);

        // Try SIGTERM first
        killProcess(savedPid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 1000));

        // If still running, use SIGKILL
        if (isProcessRunning(savedPid)) {
          console.log(`${colors.yellow}   进程未响应,强制停止...${colors.reset}`);
          killProcess(savedPid, 'SIGKILL');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!isProcessRunning(savedPid)) {
          console.log(`${colors.green}   ✓ 已通过 PID 停止进程${colors.reset}`);
          stopped = true;
        }
      } else {
        console.log(`${colors.yellow}⚠️  PID 文件中的进程 ${savedPid} 不属于本项目,已跳过${colors.reset}`);
      }
    } else {
      console.log(`${colors.yellow}⚠️  PID 文件中的进程 ${savedPid} 不存在${colors.reset}`);
    }

    // Remove PID file
    try {
      fs.unlinkSync(PID_FILE);
    } catch (e) {
      // Ignore errors
    }
  }

  // Method 2: Stop via port
  const pids = checkPortAvailability(port);
  if (pids && pids.length > 0) {
    const monitorPids = pids.filter(pid => isProjectProcess(pid, serverPath, savedPid));
    console.log(`${colors.yellow}📋 检测到端口 ${port} 仍被占用${colors.reset}`);

    // Show occupying processes
    console.log(`${colors.yellow}   占用进程:${colors.reset}`);
    try {
      const lsofOutput = execSync(`lsof -i :${port} | grep -v COMMAND`, { encoding: 'utf-8' });
      console.log(lsofOutput);
    } catch (e) {
      // Ignore errors
    }

    if (monitorPids.length === 0) {
      console.log(`${colors.yellow}   未发现属于本项目的代理进程,为避免误杀已跳过端口清理${colors.reset}`);
    } else {
      for (const pid of monitorPids) {
        killProcess(parseInt(pid, 10), 'SIGTERM');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));

      for (const pid of monitorPids) {
        if (isProcessRunning(parseInt(pid, 10))) {
          killProcess(parseInt(pid, 10), 'SIGKILL');
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      const stillRunning = monitorPids.filter(pid => isProcessRunning(parseInt(pid, 10)));
      if (stillRunning.length === 0) {
        console.log(`${colors.green}   ✓ 已停止本项目代理进程: ${monitorPids.join(', ')}${colors.reset}`);
        stopped = true;
      } else {
        console.log(`${colors.yellow}   ⚠ 以下本项目代理进程仍在运行: ${stillRunning.join(', ')}${colors.reset}`);
      }
    }
  }

  // Verify completely stopped
  console.log('');
  const stillOccupied = checkPortAvailability(port);
  if (stillOccupied && stillOccupied.length > 0) {
    console.log(`${colors.red}❌ 停止失败,端口 ${port} 仍被占用${colors.reset}`);
    console.log(`${colors.yellow}   请检查占用进程后再手动处理: lsof -i :${port}${colors.reset}`);
    proxyStopFailed = true;
  } else {
    if (stopped) {
      console.log(`${colors.green}✅ 代理服务器已完全停止${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚠️  代理服务器未在运行${colors.reset}`);
    }
    if (!silent) {
      console.log('');
    }
  }

  await stopVisualizerProcess(silent);

  if (proxyStopFailed && !silent) {
    process.exit(1);
  }
}

async function stopVisualizerProcess(silent = false) {
  const visualizerPort = getVisualizerPort();
  let stopped = false;
  const pidFiles = [VISUALIZER_PID_FILE, LEGACY_VISUALIZER_PID_FILE];
  const trustedPids = [];

  for (const pidFile of pidFiles) {
    const savedPid = readPidFile(pidFile);
    if (!savedPid) continue;
    trustedPids.push(savedPid);

    if (isProcessRunning(savedPid) && isVisualizerProcess(savedPid, savedPid)) {
      if (!silent) {
        console.log(`${colors.yellow}📋 停止可视化服务进程 ${savedPid}...${colors.reset}`);
      }
      killProcess(savedPid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 800));
      if (isProcessRunning(savedPid)) {
        killProcess(savedPid, 'SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!isProcessRunning(savedPid)) {
        stopped = true;
      }
    }

    try {
      fs.unlinkSync(pidFile);
    } catch (e) {
      // Ignore errors
    }
  }

  const pids = checkPortAvailability(visualizerPort) || [];
  const visualizerPids = pids.filter(pid => (
    isVisualizerProcess(pid) ||
    trustedPids.some(savedPid => parseInt(pid, 10) === parseInt(savedPid, 10))
  ));

  if (visualizerPids.length > 0) {
    if (!silent) {
      console.log(`${colors.yellow}📋 检测到可视化端口 ${visualizerPort} 上仍有本项目服务: ${visualizerPids.join(', ')}${colors.reset}`);
    }
    for (const pid of visualizerPids) {
      killProcess(parseInt(pid, 10), 'SIGTERM');
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    for (const pid of visualizerPids) {
      if (isProcessRunning(parseInt(pid, 10))) {
        killProcess(parseInt(pid, 10), 'SIGKILL');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    stopped = true;
  } else if (pids.length > 0 && !silent) {
    console.log(`${colors.yellow}⚠️  可视化端口 ${visualizerPort} 被其他进程占用,已跳过${colors.reset}`);
  }

  if (!silent && stopped) {
    console.log(`${colors.green}✅ 可视化服务已停止${colors.reset}`);
  }
}

// ============================================
// --status Subcommand
// ============================================

async function statusSubcommand() {
  printHeader('📊 Claude Code 反向代理服务器状态');

  const port = getPort();
  let running = false;

  // Check PID file
  const savedPid = readPidFile();
  if (savedPid) {
    console.log(`${colors.cyan}PID 文件:${colors.reset} ${PID_FILE}`);
    console.log(`${colors.cyan}记录的 PID:${colors.reset} ${savedPid}`);

    if (isProcessRunning(savedPid)) {
      if (isProjectProcess(savedPid, serverPath, savedPid)) {
        console.log(`${colors.green}进程状态: ✓ 本项目代理运行中${colors.reset}`);
        running = true;
      } else {
        console.log(`${colors.yellow}进程状态: ⚠ PID 存在但不属于本项目${colors.reset}`);
      }
    } else {
      console.log(`${colors.red}进程状态: ✗ 不存在${colors.reset}`);
      console.log(`${colors.yellow}建议: 手动删除 PID 文件 (rm ${PID_FILE})${colors.reset}`);
    }
    console.log('');
  } else {
    console.log(`${colors.yellow}⚠️  未找到 PID 文件${colors.reset}`);
    console.log('');
  }

  // Check port occupation
  console.log(`${colors.cyan}监听端口:${colors.reset} ${port}`);
  const pids = checkPortAvailability(port);
  if (pids && pids.length > 0) {
    const monitorPids = pids.filter(pid => isProjectProcess(pid, serverPath, savedPid));
    if (monitorPids.length > 0) {
      console.log(`${colors.green}端口状态: ✓ 本项目代理占用中${colors.reset}`);
      running = true;
    } else {
      console.log(`${colors.yellow}端口状态: ⚠ 被其他进程占用${colors.reset}`);
    }
    console.log('');
    console.log(`${colors.cyan}占用进程详情:${colors.reset}`);
    try {
      const lsofOutput = execSync(`lsof -i :${port}`, { encoding: 'utf-8' });
      console.log(lsofOutput);
    } catch (e) {
      // Ignore errors
    }
  } else {
    console.log(`${colors.red}端口状态: ✗ 未占用${colors.reset}`);
  }

  console.log('');
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  if (running) {
    console.log(`${colors.green}✅ 代理服务器正在运行${colors.reset}`);
  } else {
    console.log(`${colors.yellow}⚠️  代理服务器未运行${colors.reset}`);
  }
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  if (running) {
    console.log(`${colors.cyan}💡 管理命令:${colors.reset}`);
    console.log(`   停止: ${colors.green}cclens stop${colors.reset}`);
    console.log(`   重启: ${colors.green}cclens proxy${colors.reset} (会提示是否重启)`);
    console.log(`   日志: ${colors.green}tail -f ${LOG_FILE}${colors.reset}`);
  } else {
    console.log(`${colors.cyan}💡 启动命令:${colors.reset}`);
    console.log(`   ${colors.green}cclens proxy${colors.reset}`);
  }
  console.log('');
}

// ============================================
// Default Behavior (One-Click Startup)
// ============================================

/**
 * Release port only when it is occupied by this project.
 */
async function killPort(port, pids) {
  console.log(`${colors.yellow}⚠️  端口 ${port} 被占用 (PID: ${pids.join(', ')})${colors.reset}`);
  const monitorPids = pids.filter(pid => isProjectProcess(pid, serverPath));

  if (monitorPids.length === 0) {
    console.log(`${colors.yellow}→ 占用进程不属于本项目,不会自动终止${colors.reset}`);
    return false;
  }

  console.log(`${colors.blue}→ 正在停止本项目代理进程: ${monitorPids.join(', ')}${colors.reset}`);

  try {
    // Try SIGTERM first
    for (const pid of monitorPids) {
      killProcess(parseInt(pid, 10), 'SIGTERM');
    }
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if still running
    const stillRunning = monitorPids.filter(pid => isProcessRunning(parseInt(pid, 10)));

    if (stillRunning.length > 0) {
      console.log(`${colors.yellow}→ 进程未响应,强制终止...${colors.reset}`);
      for (const pid of stillRunning) {
        killProcess(parseInt(pid, 10), 'SIGKILL');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`${colors.green}✅ 端口已释放${colors.reset}`);
    return true;
  } catch (e) {
    console.error(`${colors.red}❌ 停止进程失败:${colors.reset}`, e.message);
    return false;
  }
}

/**
 * Find available port (auto-release occupied)
 */
async function findAvailablePort(startPort) {
  const pids = checkPortAvailability(startPort);

  if (!pids) {
    return startPort;
  }

  // Port occupied, auto-release
  const killed = await killPort(startPort, pids);

  if (killed) {
    return startPort;
  }

  for (let port = startPort + 1; port <= startPort + 20; port++) {
    if (!checkPortAvailability(port)) {
      console.log(`${colors.yellow}→ 改用可用端口: ${port}${colors.reset}`);
      return port;
    }
  }

  throw new Error(`端口 ${startPort} 被其他进程占用,且未找到可用备用端口`);
}

/**
 * Start proxy server (background)
 */
function startProxyServer(port, targetBaseUrl) {
  const logPaths = ensureLogDirectories();

  const logFile = fs.openSync(logPaths.serverLog, 'a');

  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: ['ignore', logFile, logFile],
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_PROXY_PORT: port.toString(),
      ...(targetBaseUrl ? { CLAUDE_CODE_LENS_TARGET_BASE_URL: targetBaseUrl } : {})
    }
  });

  child.unref();

  // Save PID
  fs.writeFileSync(PID_FILE, child.pid.toString());

  return {
    pid: child.pid,
    logPath: logPaths.serverLog
  };
}

/**
 * Start visualizer (background)
 */
async function startVisualizer() {
  if (!fs.existsSync(visualizerPath)) {
    console.log(`${colors.yellow}⚠️  找不到可视化工具,跳过此步骤${colors.reset}`);
    return null;
  }

  const visualizerPort = getVisualizerPort();
  const url = `http://127.0.0.1:${visualizerPort}`;
  if (await waitForHttp(`${url}/__claude-code-lens/health`, 1000)) {
    return {
      pid: fs.existsSync(VISUALIZER_PID_FILE) ? fs.readFileSync(VISUALIZER_PID_FILE, 'utf-8').trim() : 'unknown',
      url,
      logPath: VISUALIZER_LOG_FILE,
      alreadyRunning: true
    };
  }

  const pids = checkPortAvailability(visualizerPort);
  if (pids && pids.length > 0) {
    const visualizerPids = pids.filter(pid => isVisualizerProcess(pid));
    if (visualizerPids.length === 0) {
      console.log(`${colors.yellow}⚠️  可视化端口 ${visualizerPort} 已被其他进程占用,跳过启动${colors.reset}`);
      console.log(`${colors.yellow}   占用进程: PID ${pids.join(', ')}${colors.reset}`);
      return null;
    }

    console.log(`${colors.yellow}⚠️  检测到旧的可视化服务占用端口 ${visualizerPort},正在重启...${colors.reset}`);
    for (const pid of visualizerPids) {
      killProcess(parseInt(pid, 10), 'SIGTERM');
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    for (const pid of visualizerPids) {
      if (isProcessRunning(parseInt(pid, 10))) {
        killProcess(parseInt(pid, 10), 'SIGKILL');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  try {
    ensureLogDirectories();
    const logFile = fs.openSync(VISUALIZER_LOG_FILE, 'a');
    const child = spawn('node', [visualizerPath], {
      detached: true,
      stdio: ['ignore', logFile, logFile],
      env: {
        ...process.env,
        CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND: 'true',
        CLAUDE_CODE_LENS_VISUALIZER_PORT: visualizerPort.toString()
      }
    });

    child.unref();
    fs.writeFileSync(VISUALIZER_PID_FILE, child.pid.toString());

    const isReady = await waitForHttp(`${url}/__claude-code-lens/health`, 5000);
    if (!isReady || !isProcessRunning(child.pid)) {
      console.log(`${colors.yellow}⚠️  可视化工具启动后未通过健康检查,请查看日志: ${VISUALIZER_LOG_FILE}${colors.reset}`);
      return null;
    }

    return {
      pid: child.pid,
      url,
      logPath: VISUALIZER_LOG_FILE,
      alreadyRunning: false
    };
  } catch (e) {
    console.log(`${colors.yellow}⚠️  启动可视化工具失败: ${e.message}${colors.reset}`);
    return null;
  }
}

/**
 * Update settings.json with current proxy port
 */
function buildLocalProxyBaseUrl(port) {
  return `http://localhost:${port}`;
}

function updateSettingsFile(proxyUrl) {
  try {
    // Ensure directory exists
    if (!fs.existsSync(APP_HOME)) {
      fs.mkdirSync(APP_HOME, { recursive: true });
    }

    // Create/update settings.json
    const settings = {
      env: {
        ANTHROPIC_BASE_URL: proxyUrl
      }
    };

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
  } catch (e) {
    console.log(`${colors.yellow}⚠️  无法更新 settings.json: ${e.message}${colors.reset}`);
  }
}

function buildNoProxyValue(existing) {
  const required = ['127.0.0.1', 'localhost'];
  const values = new Set(
    String(existing || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );

  for (const value of required) {
    values.add(value);
  }

  return Array.from(values).join(',');
}

function buildClaudeEnvironment(proxyUrl) {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: proxyUrl,
    NO_PROXY: buildNoProxyValue(process.env.NO_PROXY || process.env.no_proxy),
    no_proxy: buildNoProxyValue(process.env.no_proxy || process.env.NO_PROXY)
  };

  if (!env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  }

  return env;
}

/**
 * Check if Claude is installed
 */
function checkClaudeInstalled() {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Build Claude args with the monitor settings file unless the user provided one.
 */
function buildClaudeArgs(args) {
  const result = [];
  let hasSettings = false;
  let i = 0;

  // 检查用户是否提供了 --settings 参数
  while (i < args.length) {
    if (args[i] === '--settings') {
      hasSettings = true;
      result.push(args[i]);
      if (i + 1 < args.length) {
        result.push(args[i + 1]);
        i += 2;
      } else {
        i++;
      }
    } else if (typeof args[i] === 'string' && args[i].startsWith('--settings=')) {
      hasSettings = true;
      result.push(args[i]);
      i++;
    } else {
      result.push(args[i]);
      i++;
    }
  }

  if (!hasSettings) {
    result.push('--settings', SETTINGS_FILE);
  } else {
    console.log(`${colors.yellow}⚠️  用户提供了自定义 --settings 参数${colors.reset}`);
    console.log(`${colors.yellow}   cclens 会继续通过环境变量注入代理地址,但自定义 settings 可能覆盖它。${colors.reset}`);
  }

  return result;
}

/**
 * Start Claude session (foreground)
 */
function startClaudeSession(proxyUrl, extraArgs = [], options = {}) {
  const quiet = options.quiet === true;

  if (!checkClaudeInstalled()) {
    monitorLog('');
    monitorLog(`${colors.yellow}Claude Code 未安装${colors.reset}`);
    monitorLog(`${colors.blue}请访问 https://claude.com/code 安装 Claude Code${colors.reset}`);
    monitorLog('');
    monitorLog(`${colors.cyan}配置代理后手动启动 Claude:${colors.reset}`);
    const argsStr = extraArgs.length > 0 ? extraArgs.join(' ') + ' ' : '';
    monitorLog(`claude ${argsStr}--settings ${SETTINGS_FILE}`);
    monitorLog('');
    return false;
  }

  const claudeArgs = buildClaudeArgs(extraArgs);

  const displayArgs = extraArgs.filter((arg, idx) => {
    if (arg === '--settings') return false;
    if (idx > 0 && extraArgs[idx - 1] === '--settings') return false;
    return true;
  });

  if (!quiet) {
    if (displayArgs.length > 0 && MONITOR_VERBOSE) {
      monitorLog(`${colors.green}Launching Claude Code: ${displayArgs.join(' ')}${colors.reset}`);
    } else {
      monitorLog(`${colors.green}Launching Claude Code...${colors.reset}`);
    }
    monitorLog('');
  }

  return new Promise((resolve) => {
    const child = spawn('claude', claudeArgs, {
      stdio: 'inherit',
      env: buildClaudeEnvironment(proxyUrl)
    });

    child.on('error', (err) => {
      console.error(`${colors.red}启动 Claude 失败:${colors.reset}`, err.message);
      resolve(false);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`${colors.yellow}Claude 已退出: signal=${signal}${colors.reset}`);
        resolve(false);
        return;
      }
      resolve(code === 0);
    });
  });
}

/**
 * Default one-click startup
 */
async function defaultStartup(claudeExtraArgs) {
  const quiet = isPrintMode(claudeExtraArgs) && !MONITOR_VERBOSE;

  if (!quiet) {
    monitorLog(`${colors.bold}Claude Code Lens${colors.reset}`);
  }

  try {
    // Step 1: Port management
    verboseLog(`${colors.cyan}[1/4]${colors.reset} Checking port...`);
    const startPort = getPort();
    const existingHealthUrl = `http://127.0.0.1:${startPort}/__claude-code-lens/health`;
    const existingProxyReady = await waitForHttp(existingHealthUrl, 1000);
    const port = existingProxyReady ? startPort : await findAvailablePort(startPort);
    const target = discoverTargetBaseUrl({
      proxyPort: port,
      explicitSettingsPath: findSettingsArg(claudeExtraArgs),
      claudeArgs: claudeExtraArgs
    });
    verboseLog(`${colors.green}Using port: ${port}${colors.reset}`);
    verboseLog(`${colors.green}Target: ${target.baseUrl} (${target.source})${colors.reset}`);

    // Step 2: Start proxy server
    verboseLog(`${colors.cyan}[2/4]${colors.reset} Starting proxy...`);
    const proxyUrl = buildLocalProxyBaseUrl(port);
    let proxyInfo;

    if (existingProxyReady) {
      proxyInfo = {
        pid: readPidFile() || 'unknown',
        logPath: LOG_FILE,
        alreadyRunning: true
      };
    } else {
      proxyInfo = startProxyServer(port, target.baseUrl);
      const proxyHealthUrl = `http://127.0.0.1:${port}/__claude-code-lens/health`;
      const proxyReady = await waitForHttp(proxyHealthUrl, 5000);

      if (!proxyReady || !isProcessRunning(proxyInfo.pid)) {
        throw new Error(`代理服务器启动失败,请查看日志: ${proxyInfo.logPath}`);
      }
    }

    const proxyStatusText = proxyInfo.alreadyRunning ? '已在运行' : '已启动 (后台运行)';
    verboseLog(`${colors.green}Proxy ${proxyStatusText}${colors.reset}`);
    verboseLog(`${colors.blue}Proxy PID: ${proxyInfo.pid}${colors.reset}`);
    verboseLog(`${colors.blue}Proxy log: ${proxyInfo.logPath}${colors.reset}`);

    updateSettingsFile(proxyUrl);

    // Step 3: Start visualizer
    verboseLog(`${colors.cyan}[3/4]${colors.reset} Starting visualizer...`);
    const vizInfo = await startVisualizer();

    if (vizInfo) {
      const statusText = vizInfo.alreadyRunning ? '已在运行' : '已启动 (后台运行)';
      verboseLog(`${colors.green}Visualizer ${statusText}${colors.reset}`);
      verboseLog(`${colors.blue}Visualizer PID: ${vizInfo.pid}${colors.reset}`);
      verboseLog(`${colors.blue}Visualizer log: ${vizInfo.logPath}${colors.reset}`);
      if (openBrowser(vizInfo.url)) {
        verboseLog(`${colors.blue}Opened browser${colors.reset}`);
      } else {
        verboseLog(`${colors.yellow}Please open manually: ${vizInfo.url}${colors.reset}`);
      }
    }

    if (!quiet) {
      monitorLog(`${colors.green}Proxy:${colors.reset} ${proxyUrl}`);
      if (vizInfo) {
        monitorLog(`${colors.green}Visualizer:${colors.reset} ${vizInfo.url}`);
      }
      monitorLog(`${colors.blue}Details:${colors.reset} cclens status`);
      monitorLog('');
    }

    // Step 4: Start Claude session
    verboseLog(`${colors.cyan}[4/4]${colors.reset} Starting Claude Code...`);
    const claudeStarted = await startClaudeSession(proxyUrl, claudeExtraArgs, { quiet });

    if (!claudeStarted && !quiet) {
      monitorLog('');
      monitorLog(`${colors.cyan}Quick links:${colors.reset}`);
      monitorLog(`Proxy: ${proxyUrl}`);
      if (vizInfo) {
        monitorLog(`Visualizer: ${vizInfo.url}`);
      }
      monitorLog('');
    }

  } catch (error) {
    console.error(`${colors.red}❌ 启动失败:${colors.reset}`, error.message);
    process.exit(1);
  }
}

export {
  defaultStartup as startAll,
  buildClaudeArgs,
  buildLocalProxyBaseUrl,
  proxySubcommand as startProxy,
  statusSubcommand as statusProxy,
  stopSubcommand as stopProxy
};
