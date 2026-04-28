# Claude Code Lens

[![npm](https://img.shields.io/npm/v/claude-code-lens.svg)](https://www.npmjs.com/package/claude-code-lens) [![English](https://img.shields.io/badge/README-English-blue.svg)](./README.md)

Claude Code Lens 是一个本地 Claude Code 可观测工具：它在 Claude Code 和真实 Anthropic-compatible 服务之间放一个本地代理，记录每次请求里的 system prompt、messages、tool definitions、tool calls、streaming response 和 token usage，并提供浏览器页面查看。

它适合两类场景：

- **临时调试**：想快速看某一次 Claude Code 到底收到了什么 prompt、有哪些 tools、模型返回了什么。直接用 `cclens -p "..."` 或 `cclens --resume`，不需要改 Claude Code 的用户配置或项目配置。
- **长期监控**：希望之后所有 Claude Code 会话都走同一个本地代理，持续沉淀日志。手动启动 `cclens proxy`，再显式配置 Claude Code 使用这个代理。

核心优势：

- **零配置上手**：默认会自动发现你当前 Claude Code 使用的真实 base URL。
- **不侵入 Claude Code**：不改 Claude Code 本体；一键模式不会写入 `~/.claude/settings.json` 或项目 `.claude/settings.json`。
- **看见真实上下文**：系统提示词、消息历史、工具定义、工具调用和 token usage 都能在本地页面里查看。
- **适合排查工具问题**：当 tool schema、MCP、prompt 注入或上下文膨胀不符合预期时，可以直接从日志定位。
- **本地优先**：运行时配置和日志统一放在 `~/.claude-code-lens/`。

## 界面预览

![Claude Code Lens visualizer](./assets/visualizer-overview.png)

可视化页面会把一次 Claude Code 请求拆成输入上下文、模型输出和资源面板。你可以快速查看 system prompts、messages、tool definitions、token usage，并在长会话里折叠历史消息。

## 安装

```bash
npm install -g claude-code-lens
```

本地开发版本：

```bash
npm install
npm install -g .
```

npm 包名是 `claude-code-lens`，安装后的命令是 `cclens`。

## 使用方式

只需要记一个命令前缀：`cclens`。这个项目有两种推荐用法。

### 方式一：一次性调试 Claude Code

这是最简单的模式，适合临时 debug prompt、tools、MCP 或 token usage。

```bash
cclens
cclens -p "hello"
cclens --resume
```

一键模式会做四件事：

1. 启动本地代理，默认 `http://localhost:18888`。
2. 启动日志可视化页面，默认 `http://127.0.0.1:5500`。
3. 打开浏览器页面。
4. 启动 Claude Code，并把你传入的参数原样透传给 Claude Code。

除 `proxy`、`stop`、`status`、`viz`、`extract`、`config`、`help` 这些 monitor 子命令外，其他参数都会自动透传给 Claude Code。所以 Claude Code 支持的参数都可以直接写在 `cclens` 后面。

这个模式不会修改你的 Claude Code 用户配置或项目配置。它只在本次启动的 Claude Code 进程里注入代理环境，并使用 `~/.claude-code-lens/settings.json` 作为临时 settings 文件。需要停止后台代理时运行：

```bash
cclens stop
```

### 方式二：长期运行代理并持续监控

如果你希望长期使用一个固定代理来观察 Claude Code，可以手动启动 proxy。

```bash
cclens proxy
```

启动后，工具会生成：

```text
~/.claude-code-lens/settings.json
```

然后用这个 settings 启动 Claude Code：

```bash
claude --settings ~/.claude-code-lens/settings.json
```

也可以只给当前 shell 会话设置环境变量：

```bash
ANTHROPIC_BASE_URL=http://localhost:18888 claude
```

打开监控页面：

```bash
cclens viz
```

默认访问地址：

```text
http://127.0.0.1:5500
```

长期模式适合日常持续观察 Claude Code 行为；一键模式更适合临时、一次性的 debug。

停止代理：

```bash
cclens stop
```

查看状态：

```bash
cclens status
```

## CLI 帮助

每个子命令都有独立帮助：

```bash
cclens --help
cclens proxy --help
cclens help proxy
```

子命令速查：

| 命令 | 作用 | 常见用法 |
| --- | --- | --- |
| `cclens` | 一键启动代理、可视化页面，并启动 Claude Code | 临时 debug 某一次 Claude Code 请求；后面可以直接接 `-p`、`--resume` 等 Claude Code 参数 |
| `cclens proxy` | 只启动本地 API 代理 | 长期运行代理，自己配置 Claude Code 使用它 |
| `cclens stop` | 停止 monitor 管理的后台服务 | 停止代理；不会误杀占用同一端口的其他进程 |
| `cclens status` | 查看代理是否运行、PID 和端口占用 | 排查代理是否已启动、端口是否被其他进程占用 |
| `cclens viz` | 启动或打开日志可视化页面 | 只想查看已有日志，不想重新启动 Claude Code |
| `cclens extract [log-file]` | 从日志提取 prompts 和 tools | 不传文件时读取最新日志；传文件时读取指定日志 |
| `cclens config` | 输出最终生效配置 | 检查端口、上游 base URL、可视化端口等配置是否符合预期 |

一键启动时会自动打开可视化页面。设置 `CLAUDE_CODE_LENS_OPEN_BROWSER=false` 可以禁用自动打开浏览器。
启动输出默认保持简洁。设置 `CLAUDE_CODE_LENS_VERBOSE=true` 可以打印 PID、日志路径和启动步骤等详细信息。

## 用户目录

所有运行时数据都在仓库外：

```text
~/.claude-code-lens/
  config.json       # 用户配置
  settings.json     # 工具生成的 Claude Code settings 文件
  logs/             # 代理和可视化服务日志
  raw_logs/         # 捕获到的 API 交互日志
  prompts/          # 提取出的 prompts 和 tools
```

`config.json` 是可选的。默认情况下，`cclens` 会从用户现有的 Claude Code 环境和 settings 中自动发现真实的 Anthropic-compatible base URL。

target 发现优先级：

```text
CLAUDE_CODE_LENS_TARGET_BASE_URL
> ~/.claude-code-lens/config.json target.baseUrl
> 当前 shell 中的 ANTHROPIC_BASE_URL
> Claude Code settings 里的 env.ANTHROPIC_BASE_URL
  - 用户传入的 --settings 文件
  - .claude/settings.local.json
  - .claude/settings.json
  - ~/.claude/settings.json
> https://api.anthropic.com
```

手动覆盖时可使用 `~/.claude-code-lens/config.json`：

```json
{
  "proxy": {
    "host": "0.0.0.0",
    "port": 18888
  },
  "target": {
    "baseUrl": "https://api.anthropic.com",
    "timeout": 120000
  },
  "visualizer": {
    "host": "127.0.0.1",
    "port": 5500
  }
}
```

通用配置优先级：

```text
环境变量
> ~/.claude-code-lens/config.json
> Claude Code settings 自动发现
> 代码内置默认值
```

支持的环境变量覆盖：

```bash
CLAUDE_CODE_LENS_HOME=~/.claude-code-lens
CLAUDE_CODE_LENS_PROXY_HOST=127.0.0.1
CLAUDE_CODE_LENS_PROXY_PORT=18888
CLAUDE_CODE_LENS_TARGET_BASE_URL=https://api.anthropic.com
CLAUDE_CODE_LENS_TARGET_TIMEOUT=120000
CLAUDE_CODE_LENS_VISUALIZER_PORT=5500
CLAUDE_CODE_LENS_LOGGING_ENABLE_CONSOLE=true
CLAUDE_CODE_LENS_OPEN_BROWSER=false
CLAUDE_CODE_LENS_VERBOSE=true
```

## 日志

API 交互日志：

```bash
ls ~/.claude-code-lens/raw_logs/
```

代理服务日志：

```bash
tail -f ~/.claude-code-lens/logs/proxy-server.log
```

日志中会脱敏 `authorization`、`x-api-key` 等敏感请求头。但请求体和响应体仍可能包含项目上下文或私有信息，分享日志前需要自行检查。

## 项目结构

```text
bin/                  # 统一 CLI: cclens
src/cli/              # 命令编排
src/proxy/            # 本地代理和会话日志
src/visualizer/       # 读取 raw_logs 的浏览器 UI
src/extractor/        # prompt/tool 提取逻辑
tests/                # CLI 和代理行为测试
```

## 开发

```bash
npm install
npm test
npm run check
```

检查 npm 包内容：

```bash
npm pack --dry-run
```
