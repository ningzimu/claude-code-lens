/**
 * Claude Code Log Extractor
 * Extract prompts and tools from Claude Code API logs
 * Convert tools to OpenAI tool schema format
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Default paths
const APP_HOME = process.env.CLAUDE_MONITOR_HOME ||
  path.join(os.homedir(), '.claude-code-monitor');
const DEFAULT_LOG_DIR = path.join(APP_HOME, 'raw_logs');
const DEFAULT_OUTPUT_DIR = path.join(APP_HOME, 'prompts');

/**
 * Find the latest log file in the default log directory
 * @returns {string|null} Path to the latest log file, or null if none found
 */
export function findLatestLogFile() {
  if (!fs.existsSync(DEFAULT_LOG_DIR)) {
    return null;
  }

  const files = fs.readdirSync(DEFAULT_LOG_DIR)
    .filter(f => f.startsWith('messages-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    return null;
  }

  return path.join(DEFAULT_LOG_DIR, files[0]);
}

/**
 * Extract timestamp from log filename
 * @param {string} filename - Log filename like messages-20251209_220351-34a0f6bf.json
 * @returns {string} Timestamp like 20251209_220351
 */
export function extractTimestamp(filename) {
  const basename = path.basename(filename);
  const match = basename.match(/messages-(\d{8}_\d{6})-/);
  if (match) {
    return match[1];
  }
  // Fallback: use current timestamp
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Convert Anthropic tool format to OpenAI tool schema format
 * @param {Object} anthropicTool - Tool in Anthropic format
 * @returns {Object} Tool in OpenAI format
 */
export function convertToOpenAIFormat(anthropicTool) {
  return {
    type: 'function',
    function: {
      name: anthropicTool.name || '',
      description: anthropicTool.description || '',
      parameters: anthropicTool.input_schema || {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };
}

/**
 * Extract tools from log data, deduplicate by name
 * @param {Object} logData - Parsed JSON log data
 * @returns {Array} Array of tools in OpenAI format
 */
export function extractTools(logData) {
  const toolsMap = new Map();

  for (const interaction of logData.interactions || []) {
    if (interaction.type === 'input' && interaction.data?.tools) {
      for (const tool of interaction.data.tools) {
        if (tool.name && !toolsMap.has(tool.name)) {
          toolsMap.set(tool.name, convertToOpenAIFormat(tool));
        }
      }
    }
  }

  // Sort by tool name for consistent output
  return Array.from(toolsMap.values()).sort((a, b) => 
    a.function.name.localeCompare(b.function.name)
  );
}

/**
 * Extract text content from system field
 * @param {string|Array} system - System field from request
 * @returns {string[]} Array of prompt texts
 */
function extractSystemText(system) {
  if (typeof system === 'string') {
    return [system];
  }
  
  if (Array.isArray(system)) {
    return system
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text);
  }
  
  return [];
}

/**
 * Extract prompts from log data, deduplicate by content
 * @param {Object} logData - Parsed JSON log data
 * @returns {Array} Array of unique prompt strings
 */
export function extractPrompts(logData) {
  const promptsSet = new Set();

  for (const interaction of logData.interactions || []) {
    if (interaction.type === 'input' && interaction.data?.system) {
      const texts = extractSystemText(interaction.data.system);
      for (const text of texts) {
        if (text && text.trim()) {
          promptsSet.add(text);
        }
      }
    }
  }

  return Array.from(promptsSet);
}

/**
 * Main extraction function
 * @param {string} logFilePath - Path to the log file
 * @returns {Object} Extracted data with tools and prompts
 */
export function extractFromLog(logFilePath) {
  // Read and parse the log file
  const content = fs.readFileSync(logFilePath, 'utf-8');
  const logData = JSON.parse(content);

  // Extract tools and prompts
  const tools = extractTools(logData);
  const prompts = extractPrompts(logData);

  return {
    tools,
    prompts
  };
}

/**
 * Generate output filename from input log filename
 * @param {string} inputFilePath - Path to input log file
 * @returns {string} Output filename
 */
export function generateOutputFilename(inputFilePath) {
  const timestamp = extractTimestamp(inputFilePath);
  return `cc-prompts-${timestamp}.json`;
}

/**
 * Save extracted data to output file
 * @param {Object} data - Extracted data (tools and prompts)
 * @param {string} inputFilePath - Original input file path (for naming)
 * @returns {string} Path to the saved output file
 */
export function saveOutput(data, inputFilePath) {
  // Ensure output directory exists
  if (!fs.existsSync(DEFAULT_OUTPUT_DIR)) {
    fs.mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });
  }

  const outputFilename = generateOutputFilename(inputFilePath);
  const outputPath = path.join(DEFAULT_OUTPUT_DIR, outputFilename);

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');

  return outputPath;
}

// Export constants for CLI usage
export { DEFAULT_LOG_DIR, DEFAULT_OUTPUT_DIR };
