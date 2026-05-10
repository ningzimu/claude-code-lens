#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, watch } from 'fs';
import { createServer, get } from 'http';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, extname } from 'path';
import { homedir } from 'os';
import { parseInteger, readEnv } from '../config/env.js';
import { buildLeadSubagentView } from './lead-subagent-trace.js';

// Check if running as background server
const IS_BACKGROUND_SERVER = (
  readEnv(process.env, 'CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND') === 'true'
);

// Log directory - unified location in user home
const APP_HOME = process.env.CLAUDE_CODE_LENS_HOME ||
  join(homedir(), '.claude-code-lens');

function readVisualizerPort() {
  const envPort = readEnv(process.env, 'CLAUDE_CODE_LENS_VISUALIZER_PORT');
  if (envPort) {
    return parseInteger(envPort, 5500);
  }

  try {
    const configPath = join(APP_HOME, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return parseInteger(config?.visualizer?.port, 5500);
    }
  } catch (e) {
    // Ignore invalid config, keep the default port.
  }

  return 5500;
}

const PORT = readVisualizerPort();

// SSE clients management
const sseClients = new Set();

/**
 * Broadcast event to all connected SSE clients
 * @param {object} eventData - Event data to send
 */
function broadcastSSE(eventData) {
  const data = JSON.stringify(eventData);
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {
      // Client disconnected, remove from set
      sseClients.delete(client);
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Visualizer public assets directory
const VISUALIZER_DIR = join(__dirname, 'public');

const LOGS_DIR = join(APP_HOME, 'raw_logs');
const CLAUDE_PROJECTS_DIR = readEnv(process.env, 'CLAUDE_CODE_LENS_CLAUDE_PROJECTS_DIR') ||
  join(homedir(), '.claude', 'projects');

// MIME types
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain'
};

// Color definitions
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

// Debounce map for file changes (avoid duplicate events)
const lastChangeTime = new Map();
const DEBOUNCE_MS = 100;

/**
 * Start watching the logs directory for changes
 * @param {string} logsDir - Path to logs directory
 */
function startLogWatcher(logsDir) {
  if (!existsSync(logsDir)) {
    console.log(`${colors.yellow}⚠️  Log directory does not exist, skipping file watch: ${logsDir}${colors.reset}`);
    return;
  }

  try {
    const watcher = watch(logsDir, { recursive: false }, (eventType, filename) => {
      // Only watch .json files
      if (!filename || !filename.endsWith('.json')) return;

      // Debounce: ignore events within DEBOUNCE_MS of each other for same file
      const now = Date.now();
      const lastTime = lastChangeTime.get(filename) || 0;
      if (now - lastTime < DEBOUNCE_MS) return;
      lastChangeTime.set(filename, now);

      // Broadcast to SSE clients (silent mode - no console output)
      broadcastSSE({
        type: eventType,
        file: filename,
        timestamp: now
      });

      // Silent mode: no console output for file changes
    });

    watcher.on('error', (err) => {
      if (!IS_BACKGROUND_SERVER) {
        console.error(`${colors.yellow}⚠️  File watch error:${colors.reset}`, err.message);
      }
    });

    if (!IS_BACKGROUND_SERVER) {
      console.log(`${colors.green}👁️  Watching log directory: ${logsDir}${colors.reset}`);
    }
  } catch (err) {
    console.error(`${colors.yellow}⚠️  Cannot start file watch:${colors.reset}`, err.message);
  }
}

// Only show banner if not background server
if (!IS_BACKGROUND_SERVER) {
  console.log('');
  console.log(`${colors.green}📊 Claude Code Visualizer${colors.reset}`);
  console.log('');
}

function waitForHttp(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      let settled = false;
      const req = get(url, (res) => {
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

function portPids(port) {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
    return pids ? pids.split('\n') : [];
  } catch (e) {
    return [];
  }
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Start built-in HTTP server
async function startBuiltinServer() {
  // Only show startup messages if running as background server
  if (IS_BACKGROUND_SERVER) {
    // Silent startup for background mode
  } else {
    console.log(`${colors.blue}→ Starting built-in HTTP server...${colors.reset}`);
    console.log(`Log directory: ${LOGS_DIR}`);
  }

  // Start watching logs directory for changes
  startLogWatcher(LOGS_DIR);

  const server = createServer(async (req, res) => {
    let filePath;

    if (req.url === '/__claude-code-lens/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Handle SSE endpoint for real-time log updates
    if (req.url === '/api/log-events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      // Send initial connection confirmation
      res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

      // Add to clients set
      sseClients.add(res);

      // Remove client on disconnect
      req.on('close', () => {
        sseClients.delete(res);
      });

      return;
    }

    // Handle API for logs - return JSON files from ~/.claude-code-lens/raw_logs/
    if (req.url === '/api/logs') {
      try {
        // Ensure directory exists
        if (!existsSync(LOGS_DIR)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ logs: [], debugPath: LOGS_DIR }));
          return;
        }

        const files = await readdir(LOGS_DIR);

        // Only return .json files
        const logFiles = files.filter(f => f.endsWith('.json'));

        // Get file stats (including mtime) for each log file
        const logsWithMtime = await Promise.all(
          logFiles.map(async (name) => {
            try {
              const filePath = join(LOGS_DIR, name);
              const stats = await stat(filePath);
              return {
                name,
                mtime: stats.mtimeMs // Unix timestamp in milliseconds
              };
            } catch (err) {
              // Return file without mtime if stat fails
              return { name, mtime: 0 };
            }
          })
        );
        logsWithMtime.sort((a, b) => {
          const diff = b.mtime - a.mtime;
          return diff || a.name.localeCompare(b.name);
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs: logsWithMtime, debugPath: LOGS_DIR }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs: [], error: err.message, debugPath: LOGS_DIR }));
      }
      return;
    }

    if (req.url.startsWith('/api/lead-subagent-view')) {
      try {
        const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
        const logName = parsedUrl.searchParams.get('log') || '';

        if (!logName || basename(logName) !== logName || !logName.endsWith('.json')) {
          writeJson(res, 400, { error: 'Invalid log parameter' });
          return;
        }

        const logPath = join(LOGS_DIR, logName);
        const logData = JSON.parse(await readFile(logPath, 'utf8'));
        const view = await buildLeadSubagentView(logData, {
          projectsDir: CLAUDE_PROJECTS_DIR
        });

        writeJson(res, 200, view);
      } catch (err) {
        if (err.code === 'ENOENT') {
          writeJson(res, 404, { error: 'Log not found' });
        } else {
          writeJson(res, 500, { error: err.message });
        }
      }
      return;
    }

    // Handle log file requests - serve from LOGS_DIR
    if (req.url.startsWith('/logs/')) {
      const filename = req.url.replace('/logs/', '');
      filePath = join(LOGS_DIR, filename);
    }
    // Handle root path - serve visualizer/index.html
    else if (req.url === '/') {
      filePath = join(VISUALIZER_DIR, 'index.html');
    }
    // Handle visualizer files
    else {
      filePath = join(VISUALIZER_DIR, req.url);
    }

    try {
      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      const content = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>500 Internal Server Error</h1>');
      }
    }
  });

  server.listen(PORT, () => {
    if (!IS_BACKGROUND_SERVER) {
      console.log(`${colors.green}✅ Server started successfully${colors.reset}`);
      console.log(`${colors.blue}→ URL: http://localhost:${PORT}${colors.reset}`);
      console.log('');

      // Auto-open browser
      openBrowser(`http://localhost:${PORT}`);
    }
    // Background server runs silently
  });

  server.on('error', (err) => {
    console.error(`${colors.yellow}❌ Startup failed:${colors.reset}`, err.message);
    process.exit(1);
  });
}

// Open browser
function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = 'open';
  } else if (platform === 'win32') {
    command = 'start';
  } else {
    command = 'xdg-open';
  }

  try {
    spawn(command, [url], {
      stdio: 'ignore',
      detached: true
    }).unref();

    console.log(`${colors.blue}→ Opening browser...${colors.reset}`);
  } catch (err) {
    console.log(`${colors.yellow}Please open manually: ${url}${colors.reset}`);
  }
}

// Main function
async function main() {
  // If not running as background server, spawn a detached background process
  if (!IS_BACKGROUND_SERVER) {
    const url = `http://localhost:${PORT}`;

    if (await waitForHttp(`http://127.0.0.1:${PORT}/__claude-code-lens/health`, 1000)) {
      console.log(`${colors.green}✅ Visualizer is already running${colors.reset}`);
      console.log(`${colors.blue}→ URL: ${url}${colors.reset}`);
      openBrowser(url);
      return;
    }

    const pids = portPids(PORT);
    if (pids.length > 0) {
      console.error(`${colors.yellow}❌ Port ${PORT} is already in use by PID ${pids.join(', ')}${colors.reset}`);
      console.error(`${colors.yellow}   Not stopping unrelated processes automatically.${colors.reset}`);
      process.exit(1);
    }

    console.log(`${colors.blue}→ Starting visualizer in background...${colors.reset}`);

    // Spawn detached background process
    const child = spawn(process.execPath, [process.argv[1]], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND: 'true',
        CLAUDE_CODE_LENS_VISUALIZER_PORT: PORT.toString()
      }
    });

    child.unref();

    console.log(`${colors.green}✅ Visualizer started in background (PID: ${child.pid})${colors.reset}`);
    const isReady = await waitForHttp(`http://127.0.0.1:${PORT}/__claude-code-lens/health`, 5000);
    if (!isReady) {
      console.error(`${colors.yellow}❌ Visualizer did not pass health check${colors.reset}`);
      process.exit(1);
    }

    console.log(`${colors.blue}→ URL: ${url}${colors.reset}`);
    console.log('');

    // Open browser
    openBrowser(url);

    // Wait a bit for browser to open, then exit
    setTimeout(() => {
      console.log(`${colors.blue}→ Stop with: kill ${child.pid}${colors.reset}`);
      console.log('');
      process.exit(0);
    }, 1000);

    return;
  }

  // Running as background server
  if (!existsSync(join(VISUALIZER_DIR, 'index.html'))) {
    console.error(`${colors.yellow}❌ Error: Cannot find visualizer files${colors.reset}`);
    console.error(`Expected location: ${VISUALIZER_DIR}`);
    process.exit(1);
  }

  // Start server (silent mode)
  await startBuiltinServer();
}

main().catch(err => {
  console.error(`${colors.yellow}❌ Startup failed:${colors.reset}`, err);
  process.exit(1);
});
