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
    .name('cclens')
    .description('Local monitor for Claude Code API traffic, logs, prompts, and tools.')
    .usage('[claude args...]')
    .helpCommand(false)
    .showHelpAfterError()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .addHelpText('after', `
Recommended modes:
  One-off debug:
    cclens -p "hello"
    cclens --resume

  Long-running proxy:
    cclens proxy
    claude --settings ~/.claude-code-lens/settings.json
    cclens viz

Claude Code passthrough:
  cclens
  cclens -p "hello"
  cclens --resume
  cclens --model claude-opus-4-6 --resume

Command help:
  cclens proxy --help
  cclens help proxy

Config:
  ~/.claude-code-lens/config.json
  Environment overrides use the CLAUDE_CODE_LENS_* prefix.
`);

  program
    .command('proxy')
    .description('Start only the local API proxy.')
    .addHelpText('after', `
What it does:
  Starts only the local Anthropic-compatible proxy. It also writes a reusable
  settings file for manually launching Claude Code through the proxy.

When to use:
  Use this when you want the proxy running in the background and will start
  Claude Code yourself, or when you are debugging forwarding/log capture.

Behavior:
  - Listens on proxy.host/proxy.port from config, default http://localhost:18888
  - Forwards traffic to the discovered or configured target.baseUrl
  - Writes API logs to ~/.claude-code-lens/raw_logs/
  - Writes process logs to ~/.claude-code-lens/logs/proxy-server.log
  - Creates ~/.claude-code-lens/settings.json for Claude Code

Next steps:
  Start Claude Code through the generated settings file:
    claude --settings ~/.claude-code-lens/settings.json

  Or configure only the current shell session:
    ANTHROPIC_BASE_URL=http://localhost:18888 claude

  Open the monitor UI:
    cclens viz

Examples:
  cclens proxy
  CLAUDE_CODE_LENS_PROXY_PORT=18889 cclens proxy

Related:
  cclens status
  cclens stop
  cclens config
`);

  program
    .command('stop')
    .description('Stop monitor-managed background services.')
    .addHelpText('after', `
What it does:
  Stops monitor-managed background services.

Behavior:
  - Stops the proxy process recorded in ~/.claude-code-lens/logs/proxy.pid
  - Verifies that the configured proxy port is no longer occupied by this proxy
  - Does not kill unrelated processes that happen to use the same port

Examples:
  cclens stop

Related:
  cclens status
  cclens proxy
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
  cclens status
  CLAUDE_CODE_LENS_PROXY_PORT=18889 cclens status

Related:
  cclens proxy
  cclens stop
`);

  program
    .command('viz')
    .description('Start/open the browser log visualizer.')
    .addHelpText('after', `
What it does:
  Starts the browser visualizer if needed, then opens it.

Behavior:
  - Serves the visualizer from http://127.0.0.1:5500 by default
  - Reads log files from ~/.claude-code-lens/raw_logs/
  - Watches for log changes and refreshes the UI in real time
  - Does not start the proxy or Claude Code

Configuration:
  Set visualizer.port in ~/.claude-code-lens/config.json, or use
  CLAUDE_CODE_LENS_VISUALIZER_PORT.

Examples:
  cclens viz
  CLAUDE_CODE_LENS_VISUALIZER_PORT=5501 cclens viz

Related:
  cclens
  cclens proxy
`);

  program
    .command('extract')
    .argument('[log-file]', 'Log file to read; defaults to the newest raw log.')
    .description('Extract prompts/tools from a log file.')
    .addHelpText('after', `
What it does:
  Extracts system prompts and tool definitions from Claude Code API logs.

Behavior:
  - With no file argument, reads the newest file in ~/.claude-code-lens/raw_logs/
  - With a file argument, reads that specific JSON log file
  - Writes extracted data to ~/.claude-code-lens/prompts/

Examples:
  cclens extract
  cclens extract ~/.claude-code-lens/raw_logs/messages-xxx.json

Related:
  cclens viz
`);

  program
    .command('config')
    .description('Print the resolved monitor configuration as JSON.')
    .addHelpText('after', `
What it does:
  Prints the final resolved monitor configuration as JSON.

Resolution order:
  1. CLAUDE_CODE_LENS_* environment variables
  2. ~/.claude-code-lens/config.json
  3. Claude Code settings target discovery
  4. Built-in defaults

Common fields:
  proxy.port          Local proxy port, default 18888
  target.baseUrl      Real Anthropic-compatible upstream base URL
  target.timeout      Upstream request timeout in ms
  visualizer.port     Browser visualizer port, default 5500
  logging.enableConsole

Examples:
  cclens config
  CLAUDE_CODE_LENS_PROXY_PORT=18889 cclens config

Related:
  cclens proxy
  cclens viz
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
