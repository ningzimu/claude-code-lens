please reply in chinese

# Claude Code Monitor

This repository builds a local observability tool for Claude Code API traffic.

Use **Superpowers** workflows for feature work, debugging, TDD, verification, and code review.

## Project Shape

The public CLI is a single npm-managed command:

```bash
cc-monitor
```

Primary subcommands:

```bash
cc-monitor            # proxy + visualizer + Claude Code
cc-monitor -p "hello" # pass Claude Code args through
cc-monitor proxy      # proxy only
cc-monitor stop       # stop proxy
cc-monitor status     # proxy status
cc-monitor viz        # visualizer
cc-monitor extract    # prompt/tool extraction
cc-monitor config     # print resolved config
```

Avoid introducing new top-level command prefixes. Keep `cc-monitor` as the only documented CLI prefix.

## Runtime Paths

User-level runtime data lives in:

```text
~/.claude-code-monitor/
  config.json
  settings.json
  logs/
  raw_logs/
  prompts/
```

Do not write private endpoint configuration into the repository. Use `~/.claude-code-monitor/config.json` or environment variables.

Configuration priority:

```text
CLAUDE_MONITOR_* environment variables
> ~/.claude-code-monitor/config.json
> Claude Code settings target discovery
> built-in defaults
```

Supported overrides:

```bash
CLAUDE_MONITOR_HOME=~/.claude-code-monitor
CLAUDE_MONITOR_PROXY_HOST=127.0.0.1
CLAUDE_MONITOR_PROXY_PORT=18888
CLAUDE_MONITOR_TARGET_BASE_URL=https://api.anthropic.com
CLAUDE_MONITOR_TARGET_TIMEOUT=120000
CLAUDE_MONITOR_VISUALIZER_PORT=5500
CLAUDE_MONITOR_LOGGING_ENABLE_CONSOLE=true
CLAUDE_MONITOR_OPEN_BROWSER=false
CLAUDE_MONITOR_VERBOSE=true
```

## Development

Use the root package for npm management:

```bash
npm install
npm link
npm test
npm run check
```

## Code Style

- JavaScript ESM.
- 2-space indentation.
- Prefer single quotes and semicolons.
- Keep runtime config out of the repository.
- Keep public docs neutral and GitHub-friendly.
