#!/usr/bin/env node

import { spawn } from 'child_process';
import { Command } from 'commander';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  startAll,
  startProxy,
  statusProxy,
  stopProxy
} from '../src/cli/service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const commands = new Set(['proxy', 'stop', 'status', 'viz', 'extract', 'config', 'help']);

function createHelpProgram() {
  const program = new Command();

  program
    .name('cc-monitor')
    .description('Local monitor for Claude Code API traffic, logs, prompts, and tools.')
    .usage('[claude args...]')
    .helpCommand(false)
    .showHelpAfterError()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .addHelpText('after', `
Recommended modes:
  One-off debug:
    cc-monitor -p "hello"
    cc-monitor --resume

  Long-running proxy:
    cc-monitor proxy
    claude --settings ~/.claude-code-monitor/settings.json
    cc-monitor viz

Claude Code passthrough:
  cc-monitor
  cc-monitor -p "hello"
  cc-monitor --resume
  cc-monitor --model claude-opus-4-6 --resume

Command help:
  cc-monitor proxy --help
  cc-monitor help proxy

Config:
  ~/.claude-code-monitor/config.json
  Environment overrides use the CLAUDE_MONITOR_* prefix.
`);

  program
    .command('proxy')
    .description('Start only the local API proxy.')
    .addHelpText('after', `
What it does:
  Starts only the local Anthropic-compatible proxy. It does not open the
  visualizer and does not launch Claude Code.

When to use:
  Use this when you want the proxy running in the background and will start
  Claude Code yourself, or when you are debugging forwarding/log capture.

Behavior:
  - Listens on proxy.host/proxy.port from config, default http://localhost:18888
  - Forwards traffic to the discovered or configured target.baseUrl
  - Writes API logs to ~/.claude-code-monitor/raw_logs/
  - Writes process logs to ~/.claude-code-monitor/logs/proxy-server.log
  - Creates ~/.claude-code-monitor/settings.json for Claude Code

Next steps:
  Start Claude Code through the generated settings file:
    claude --settings ~/.claude-code-monitor/settings.json

  Or configure only the current shell session:
    ANTHROPIC_BASE_URL=http://localhost:18888 claude

  Open the monitor UI:
    cc-monitor viz

Examples:
  cc-monitor proxy
  CLAUDE_MONITOR_PROXY_PORT=18889 cc-monitor proxy

Related:
  cc-monitor status
  cc-monitor stop
  cc-monitor config
`);

  program
    .command('stop')
    .description('Stop monitor-managed background services.')
    .addHelpText('after', `
What it does:
  Stops monitor-managed background services.

Behavior:
  - Stops the proxy process recorded in ~/.claude-code-monitor/logs/proxy.pid
  - Verifies that the configured proxy port is no longer occupied by this proxy
  - Does not kill unrelated processes that happen to use the same port

Examples:
  cc-monitor stop

Related:
  cc-monitor status
  cc-monitor proxy
`);

  program
    .command('status')
    .description('Show proxy status and port ownership.')
    .addHelpText('after', `
What it does:
  Shows whether the monitor proxy is running and who owns the configured port.

Output includes:
  - PID file path and recorded PID
  - Whether the recorded PID belongs to this project
  - Configured proxy port
  - Current port owner from lsof when available

Examples:
  cc-monitor status
  CLAUDE_MONITOR_PROXY_PORT=18889 cc-monitor status

Related:
  cc-monitor proxy
  cc-monitor stop
`);

  program
    .command('viz')
    .description('Start/open the browser log visualizer.')
    .addHelpText('after', `
What it does:
  Starts the browser visualizer if needed, then opens it.

Behavior:
  - Serves the visualizer from http://127.0.0.1:5500 by default
  - Reads log files from ~/.claude-code-monitor/raw_logs/
  - Watches for log changes and refreshes the UI in real time
  - Does not start the proxy or Claude Code

Configuration:
  Set visualizer.port in ~/.claude-code-monitor/config.json, or use
  CLAUDE_MONITOR_VISUALIZER_PORT.

Examples:
  cc-monitor viz
  CLAUDE_MONITOR_VISUALIZER_PORT=5501 cc-monitor viz

Related:
  cc-monitor
  cc-monitor proxy
`);

  program
    .command('extract')
    .argument('[log-file]', 'Log file to read; defaults to the newest raw log.')
    .description('Extract prompts/tools from a log file.')
    .addHelpText('after', `
What it does:
  Extracts system prompts and tool definitions from Claude Code API logs.

Behavior:
  - With no file argument, reads the newest file in ~/.claude-code-monitor/raw_logs/
  - With a file argument, reads that specific JSON log file
  - Writes extracted data to ~/.claude-code-monitor/prompts/

Examples:
  cc-monitor extract
  cc-monitor extract ~/.claude-code-monitor/raw_logs/messages-xxx.json

Related:
  cc-monitor viz
`);

  program
    .command('config')
    .description('Print the resolved monitor configuration as JSON.')
    .addHelpText('after', `
What it does:
  Prints the final resolved monitor configuration as JSON.

Resolution order:
  1. CLAUDE_MONITOR_* environment variables
  2. ~/.claude-code-monitor/config.json
  3. Claude Code settings target discovery
  4. Built-in defaults

Common fields:
  proxy.port          Local proxy port, default 18888
  target.baseUrl      Real Anthropic-compatible upstream base URL
  target.timeout      Upstream request timeout in ms
  visualizer.port     Browser visualizer port, default 5500
  logging.enableConsole

Examples:
  cc-monitor config
  CLAUDE_MONITOR_PROXY_PORT=18889 cc-monitor config

Related:
  cc-monitor proxy
  cc-monitor viz
`);

  program
    .command('help [command]')
    .description('Show help for a monitor command.');

  return program;
}

function findHelpCommand(program, commandName) {
  return program.commands.find(command => command.name() === commandName);
}

function showCommandHelp(commandName) {
  const program = createHelpProgram();
  const command = findHelpCommand(program, commandName);
  (command || program).outputHelp();
}

function hasHelpFlag(args) {
  return args.includes('--help') || args.includes('-h');
}

function runNodeScript(relativePath, args = []) {
  const child = spawn(process.execPath, [join(rootDir, relativePath), ...args], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(`Failed to run command: ${error.message}`);
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const first = args[0];

  if (first === '--help' || first === '-h' || first === 'help') {
    showCommandHelp(args[1]);
    return;
  }

  if (commands.has(first) && hasHelpFlag(args.slice(1))) {
    showCommandHelp(first);
    return;
  }

  if (!first) {
    await startAll(args);
    return;
  }

  if (!commands.has(first)) {
    await startAll(args);
    return;
  }

  if (first === 'proxy') {
    await startProxy();
    return;
  }

  if (first === 'stop') {
    await stopProxy();
    return;
  }

  if (first === 'status') {
    await statusProxy();
    return;
  }

  if (first === 'viz') {
    runNodeScript('src/visualizer/server.js', args.slice(1));
    return;
  }

  if (first === 'extract') {
    runNodeScript('src/extractor/cli.js', args.slice(1));
    return;
  }

  if (first === 'config') {
    const { default: config } = await import('../src/proxy/config.js');
    console.log(JSON.stringify(config, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
