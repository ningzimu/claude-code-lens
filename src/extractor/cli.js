#!/usr/bin/env node

/**
 * Prompt extraction implementation used by cc-monitor extract.
 * Extract prompts and tools from Claude Code API logs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  findLatestLogFile,
  extractFromLog,
  saveOutput,
  DEFAULT_LOG_DIR,
  DEFAULT_OUTPUT_DIR
} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

/**
 * Print styled message
 */
function print(message, color = '') {
  if (color) {
    console.log(`${colors[color]}${message}${colors.reset}`);
  } else {
    console.log(message);
  }
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
${colors.bold}cc-monitor extract${colors.reset} - 从 Claude Code 日志中提取 Prompts 和 Tools

${colors.cyan}用法:${colors.reset}
  cc-monitor extract              从最新日志提取
  cc-monitor extract <file>       从指定文件提取
  cc-monitor extract --help       显示帮助信息

${colors.cyan}输出:${colors.reset}
  文件保存到 ~/.claude-code-monitor/prompts/cc-prompts-{timestamp}.json

${colors.cyan}示例:${colors.reset}
  cc-monitor extract
  cc-monitor extract ~/path/to/messages-20251209_220351-xxx.json
`);
}

/**
 * Show error with recovery guidance
 */
function showNoLogError() {
  print('\n❌ 未找到日志文件', 'red');
  console.log(`
${colors.yellow}💡 如何生成日志:${colors.reset}
   1. 运行 ${colors.green}cc-monitor${colors.reset} 启动代理服务器
   2. 使用 Claude Code 进行对话
   3. 日志将自动保存到 ${colors.cyan}~/.claude-code-monitor/raw_logs/${colors.reset}
`);
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Handle help flag
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  let logFilePath;

  // Determine log file path
  if (args.length > 0) {
    // User specified a file
    logFilePath = path.resolve(args[0]);
    
    if (!fs.existsSync(logFilePath)) {
      print(`\n❌ 文件不存在: ${logFilePath}`, 'red');
      process.exit(1);
    }
  } else {
    // Find latest log file
    logFilePath = findLatestLogFile();
    
    if (!logFilePath) {
      showNoLogError();
      process.exit(1);
    }
  }

  // Show which file we're reading
  const displayPath = logFilePath.replace(process.env.HOME, '~');
  print(`\n📖 正在读取: ${path.basename(logFilePath)}`, 'cyan');
  print(`   路径: ${displayPath}`, 'cyan');

  try {
    // Extract data
    const data = extractFromLog(logFilePath);

    // Save output
    const outputPath = saveOutput(data, logFilePath);
    const displayOutputPath = outputPath.replace(process.env.HOME, '~');

    // Show success message
    console.log(`
${colors.green}✅ 提取完成!${colors.reset}

   ${colors.cyan}📁 输出文件:${colors.reset} ${displayOutputPath}
   ${colors.cyan}🔧 工具数量:${colors.reset} ${data.tools.length}
   ${colors.cyan}📝 Prompt 数量:${colors.reset} ${data.prompts.length}
`);

  } catch (error) {
    print(`\n❌ 提取失败: ${error.message}`, 'red');
    process.exit(1);
  }
}

// Run main
main().catch(error => {
  console.error('发生错误:', error);
  process.exit(1);
});
