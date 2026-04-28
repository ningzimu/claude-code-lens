#!/usr/bin/env node

import express from 'express';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import zlib from 'zlib';
import config from './config.js';
import logger from './logger.js';
import { StreamParser } from './stream-parser.js';

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length'
]);

/**
 * 创建解压缩流 (根据 content-encoding)
 * @param {string} encoding - Content-Encoding 头的值
 * @returns {object|null} 解压缩流或 null (无压缩)
 */
function createDecompressionStream(encoding) {
  if (!encoding) return null;

  const enc = encoding.toLowerCase();
  if (enc.includes('br')) {
    return zlib.createBrotliDecompress();
  } else if (enc.includes('gzip')) {
    return zlib.createGunzip();
  } else if (enc.includes('deflate')) {
    return zlib.createInflate();
  }
  return null;
}

function forwardResponseHeaders(proxyRes, res) {
  Object.keys(proxyRes.headers).forEach(key => {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, proxyRes.headers[key]);
    }
  });
}

const app = express();

// 解析 JSON body (限制 100MB,支持大型请求)
app.use(express.json({ limit: '100mb' }));

function parseSSEEvent(rawEvent) {
  const dataLines = [];
  const lines = rawEvent.toString().split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return null;

  const dataStr = dataLines.join('\n').trim();
  if (!dataStr || dataStr === '[DONE]') {
    return null;
  }

  try {
    return JSON.parse(dataStr);
  } catch (e) {
    return null;
  }
}

/**
 * 解析 SSE 流数据,只消费完整事件并保留未完成片段
 * @param {string} buffer - 累积的 SSE 数据
 * @returns {{events: Array, remaining: string}} 解析后的事件和未完成片段
 */
function parseSSEBuffer(buffer) {
  const events = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const lfIndex = buffer.indexOf('\n\n', cursor);
    const crlfIndex = buffer.indexOf('\r\n\r\n', cursor);

    let boundaryIndex = -1;
    let boundaryLength = 0;

    if (lfIndex !== -1 && (crlfIndex === -1 || lfIndex < crlfIndex)) {
      boundaryIndex = lfIndex;
      boundaryLength = 2;
    } else if (crlfIndex !== -1) {
      boundaryIndex = crlfIndex;
      boundaryLength = 4;
    }

    if (boundaryIndex === -1) {
      break;
    }

    const event = parseSSEEvent(buffer.slice(cursor, boundaryIndex));
    if (event) {
      events.push(event);
    }
    cursor = boundaryIndex + boundaryLength;
  }

  return {
    events,
    remaining: buffer.slice(cursor)
  };
}

/**
 * 转发请求到目标服务器
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
async function proxyRequest(req, res) {
  // Create logger context for this request
  const loggerCtx = logger.createContext(req.body);
  const uid = logger.uid();
  const isStream = req.body?.stream === true;

  // 保存请求信息用于日志记录 (全量透传,不做过滤)
  const reqInfo = {
    method: req.method,
    path: req.originalUrl,
    headers: { ...req.headers }
  };

  try {
    // 记录请求 (包含完整的请求头)
    loggerCtx.logInput(uid, req.body, reqInfo);

    // 构建目标 URL
    const targetUrl = new URL(req.originalUrl, config.target.baseUrl);
    const targetUrlString = targetUrl.toString();

    logger.info(`[${uid}] ${req.method} ${req.originalUrl} -> ${targetUrlString} (stream=${isStream})`);

    // 准备请求头 - 转发所有请求头(仅排除黑名单中的)
    const headers = {};
    Object.keys(req.headers).forEach(key => {
      if (!config.headers.blacklist.includes(key.toLowerCase())) {
        headers[key] = req.headers[key];
      }
    });

    // 请求体
    const requestBody = JSON.stringify(req.body);

    // 选择 http 或 https 模块
    const protocol = targetUrl.protocol === 'https:' ? https : http;

    const options = {
      method: req.method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: config.target.timeout
    };

    // 发起请求
    const proxyReq = protocol.request(targetUrlString, options, (proxyRes) => {
      // 转发响应头
      res.status(proxyRes.statusCode);

      forwardResponseHeaders(proxyRes, res);

      // 保存响应信息用于日志记录 (全量透传,不做过滤)
      const resInfo = {
        statusCode: proxyRes.statusCode,
        headers: { ...proxyRes.headers }
      };

      if (isStream) {
        // 流式响应处理
        handleStreamResponse(proxyRes, res, uid, resInfo, loggerCtx);
      } else {
        // 非流式响应处理
        handleNonStreamResponse(proxyRes, res, uid, resInfo, loggerCtx);
      }
    });

    proxyReq.on('error', (error) => {
      loggerCtx.logError(uid, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Proxy request failed', message: error.message });
      }
    });

    proxyReq.on('timeout', () => {
      loggerCtx.logError(uid, new Error('Request timeout'));
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Gateway timeout' });
      }
    });

    // 发送请求体
    proxyReq.write(requestBody);
    proxyReq.end();

  } catch (error) {
    loggerCtx.logError(uid, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal proxy error', message: error.message });
    }
  }
}

/**
 * 处理非流式响应
 * @param {object} proxyRes - 代理响应对象
 * @param {object} res - Express 响应对象
 * @param {string} uid - 请求唯一标识
 * @param {object} resInfo - 响应信息 {statusCode, headers}
 * @param {object} loggerCtx - Logger context for this request
 */
function handleNonStreamResponse(proxyRes, res, uid, resInfo, loggerCtx) {
  let responseData = '';

  // 检测是否需要解压缩
  const contentEncoding = proxyRes.headers['content-encoding'];
  const decompressor = createDecompressionStream(contentEncoding);
  const dataSource = decompressor || proxyRes;

  if (decompressor) {
    logger.info(`[${uid}] Decompressing response (${contentEncoding})`);
    proxyRes.pipe(decompressor);
  }

  // 转发原始数据给客户端
  proxyRes.on('data', (chunk) => {
    res.write(chunk);
  });

  // 从解压缩后的数据源读取
  dataSource.on('data', (chunk) => {
    responseData += chunk.toString();
  });

  dataSource.on('end', () => {
    try {
      const jsonData = JSON.parse(responseData);
      loggerCtx.logOutput(uid, jsonData, resInfo);
    } catch (e) {
      logger.error(`Failed to parse non-stream response for uid=${uid}`, e);
    }
  });

  proxyRes.on('end', () => {
    res.end();
  });

  dataSource.on('error', (error) => {
    logger.error(`[${uid}] Decompression error`, error);
    loggerCtx.logError(uid, error);
  });

  proxyRes.on('error', (error) => {
    loggerCtx.logError(uid, error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  });
}

/**
 * 处理流式响应
 * @param {object} proxyRes - 代理响应对象
 * @param {object} res - Express 响应对象
 * @param {string} uid - 请求唯一标识
 * @param {object} resInfo - 响应信息 {statusCode, headers}
 * @param {object} loggerCtx - Logger context for this request
 */
function handleStreamResponse(proxyRes, res, uid, resInfo, loggerCtx) {
  const parser = new StreamParser();
  let buffer = '';

  // 检测是否需要解压缩
  const contentEncoding = proxyRes.headers['content-encoding'];
  const decompressor = createDecompressionStream(contentEncoding);
  const dataSource = decompressor || proxyRes;

  if (decompressor) {
    logger.info(`[${uid}] Decompressing stream (${contentEncoding})`);
    proxyRes.pipe(decompressor);
  }

  // 转发原始压缩数据给客户端
  proxyRes.on('data', (chunk) => {
    res.write(chunk);
  });

  // 从解压缩后的数据源读取并解析
  dataSource.on('data', (chunk) => {
    buffer += chunk.toString();

    const { events, remaining } = parseSSEBuffer(buffer);
    events.forEach(event => parser.handleEvent(event));
    buffer = remaining;
  });

  dataSource.on('end', () => {
    try {
      if (buffer.trim()) {
        const { events } = parseSSEBuffer(`${buffer}\n\n`);
        events.forEach(event => parser.handleEvent(event));
      }
      const final = parser.getFinal();
      loggerCtx.logStreamFinal(uid, final, resInfo);
    } catch (e) {
      logger.error(`Failed to finalize stream for uid=${uid}`, e);
    }
  });

  proxyRes.on('end', () => {
    res.end();
  });

  dataSource.on('error', (error) => {
    logger.error(`[${uid}] Decompression error`, error);
    parser.finalizeDangling(error);
    loggerCtx.logError(uid, error);
  });

  proxyRes.on('error', (error) => {
    parser.finalizeDangling(error);
    loggerCtx.logError(uid, error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  });
}

// 处理所有路由
app.get('/__claude-monitor/health', (req, res) => {
  res.json({ ok: true });
});

app.all('*', proxyRequest);

// 启动服务器
const server = app.listen(config.proxy.port, config.proxy.host, () => {
  console.log('');
  console.log('🚀 Claude Code Monitor proxy started');
  console.log('');
  console.log(`📡 监听地址: http://${config.proxy.host}:${config.proxy.port}`);
  console.log(`🎯 转发目标: ${config.target.baseUrl}`);
  console.log(`📝 日志路径: ~/.claude-code-monitor/raw_logs/`);
  console.log('');
  console.log('💡 使用方法:');
  console.log(`   claude --settings ~/.claude-code-monitor/settings.json`);
  console.log('');
});

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('收到 SIGTERM 信号,正在关闭服务器...');
  server.close(async () => {
    // 等待所有日志写入完成
    await logger.closeAll();
    logger.info('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('收到 SIGINT 信号,正在关闭服务器...');
  server.close(async () => {
    // 等待所有日志写入完成
    await logger.closeAll();
    logger.info('服务器已关闭');
    process.exit(0);
  });
});

export default app;
