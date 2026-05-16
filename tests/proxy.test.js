import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const proxyPath = path.join(repoRoot, 'src', 'proxy', 'server.js');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 1000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitForHttp(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) {
        return response;
      }
    } catch (error) {
      // Retry until deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function readOnlyLogFile(logDir, options = {}) {
  const {
    timeoutMs = 5000,
    predicate = () => true
  } = typeof options === 'number' ? { timeoutMs: options } : options;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const files = await readdir(logDir);
      if (files.length === 1) {
        const content = await readFile(path.join(logDir, files[0]), 'utf8');
        const result = {
          files,
          data: JSON.parse(content)
        };
        if (predicate(result.data)) {
          return result;
        }
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw lastError || new Error(`Timed out waiting for one complete JSON log in ${logDir}`);
}

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => {
        responseBody += chunk.toString();
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: JSON.parse(responseBody)
        });
      });
    });

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

function requestText(url, body) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => {
        responseBody += chunk.toString();
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody
        });
      });
    });

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

test('proxy preserves query strings and filters upstream length headers', async (t) => {
  let upstreamRequest;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      upstreamRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body)
      };

      const responseBody = JSON.stringify({ ok: true, url: req.url });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(responseBody),
        'Connection': 'close',
        'X-Upstream': 'ok'
      });
      res.end(responseBody);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxyPort = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-proxy-test-'));
  t.after(() => rm(monitorHome, { recursive: true, force: true }));

  const child = spawn(process.execPath, [proxyPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_PROXY_PORT: String(proxyPort),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: `http://127.0.0.1:${upstreamPort}`
    }
  });
  t.after(() => terminateChild(child));

  await waitForHttp(`http://127.0.0.1:${proxyPort}/__claude-code-lens/health`);

  const response = await requestJson(
    `http://127.0.0.1:${proxyPort}/v1/messages?beta=true&n=1`,
    { stream: false, messages: [{ role: 'user', content: 'hello' }] }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-upstream'], 'ok');
  assert.equal(response.headers['content-length'], undefined);
  assert.equal(upstreamRequest.url, '/v1/messages?beta=true&n=1');
  assert.equal(upstreamRequest.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.deepEqual(upstreamRequest.body.messages, [{ role: 'user', content: 'hello' }]);
});

test('proxy preserves target base path prefix when forwarding requests', async (t) => {
  let upstreamRequest;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      upstreamRequest = {
        url: req.url,
        body: JSON.parse(body)
      };

      const responseBody = JSON.stringify({ ok: true, url: req.url });
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      res.end(responseBody);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxyPort = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-base-path-test-'));
  t.after(() => rm(monitorHome, { recursive: true, force: true }));

  const child = spawn(process.execPath, [proxyPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_PROXY_PORT: String(proxyPort),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: `http://127.0.0.1:${upstreamPort}/proxy/anthropic/`
    }
  });
  t.after(() => terminateChild(child));

  await waitForHttp(`http://127.0.0.1:${proxyPort}/__claude-code-lens/health`);

  const response = await requestJson(
    `http://127.0.0.1:${proxyPort}/v1/messages?beta=true`,
    { stream: false, messages: [{ role: 'user', content: 'hello through prefixed upstream' }] }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamRequest.url, '/proxy/anthropic/v1/messages?beta=true');
  assert.deepEqual(upstreamRequest.body.messages, [{ role: 'user', content: 'hello through prefixed upstream' }]);
});

test('proxy groups logs by JSON metadata session_id', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const responseBody = JSON.stringify({ id: 'msg_test', type: 'message', content: [] });
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      res.end(responseBody);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxyPort = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-session-test-'));
  t.after(() => rm(monitorHome, { recursive: true, force: true }));

  const child = spawn(process.execPath, [proxyPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_PROXY_PORT: String(proxyPort),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: `http://127.0.0.1:${upstreamPort}`
    }
  });
  t.after(() => terminateChild(child));

  await waitForHttp(`http://127.0.0.1:${proxyPort}/__claude-code-lens/health`);

  const sessionId = '7342f1a7-c287-4039-b26e-2a3481ca98a7';
  await requestJson(
    `http://127.0.0.1:${proxyPort}/v1/messages?beta=true`,
    {
      stream: false,
      metadata: {
        user_id: JSON.stringify({
          device_id: 'device-test',
          account_uuid: '',
          session_id: sessionId
        })
      },
      messages: [{ role: 'user', content: 'hello' }]
    }
  );

  const rawLogDir = path.join(monitorHome, 'raw_logs');
  const { files, data: logData } = await readOnlyLogFile(rawLogDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /-7342f1a7\.json$/);

  assert.equal(logData.session_id, sessionId);
});

test('proxy creates one raw log per distinct Claude session_id', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const responseBody = JSON.stringify({ id: 'msg_test', type: 'message', content: [] });
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      res.end(responseBody);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxyPort = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-multi-session-test-'));
  t.after(() => rm(monitorHome, { recursive: true, force: true }));

  const child = spawn(process.execPath, [proxyPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_PROXY_PORT: String(proxyPort),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: `http://127.0.0.1:${upstreamPort}`
    }
  });
  t.after(() => terminateChild(child));

  await waitForHttp(`http://127.0.0.1:${proxyPort}/__claude-code-lens/health`);

  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';

  await requestJson(
    `http://127.0.0.1:${proxyPort}/v1/messages`,
    {
      stream: false,
      metadata: { session_id: sessionA },
      messages: [{ role: 'user', content: 'first session request 1' }]
    }
  );
  await requestJson(
    `http://127.0.0.1:${proxyPort}/v1/messages`,
    {
      stream: false,
      metadata: { session_id: sessionA },
      messages: [{ role: 'user', content: 'first session request 2' }]
    }
  );
  await requestJson(
    `http://127.0.0.1:${proxyPort}/v1/messages`,
    {
      stream: false,
      metadata: { session_id: sessionB },
      messages: [{ role: 'user', content: 'second session request' }]
    }
  );

  const rawLogDir = path.join(monitorHome, 'raw_logs');
  const deadline = Date.now() + 5000;
  let files = [];
  while (Date.now() < deadline) {
    files = (await readdir(rawLogDir)).filter(file => file.endsWith('.json')).sort();
    if (files.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  assert.equal(files.length, 2);
  assert.equal(files.some(file => file.endsWith('-11111111.json')), true);
  assert.equal(files.some(file => file.endsWith('-22222222.json')), true);

  const sessionAFile = files.find(file => file.endsWith('-11111111.json'));
  const sessionBFile = files.find(file => file.endsWith('-22222222.json'));
  const sessionALog = JSON.parse(await readFile(path.join(rawLogDir, sessionAFile), 'utf8'));
  const sessionBLog = JSON.parse(await readFile(path.join(rawLogDir, sessionBFile), 'utf8'));

  assert.equal(sessionALog.session_id, sessionA);
  assert.equal(sessionBLog.session_id, sessionB);
  assert.equal(sessionALog.interactions.filter(item => item.type === 'input').length, 2);
  assert.equal(sessionBLog.interactions.filter(item => item.type === 'input').length, 1);
});

test('proxy discovers target base URL from Claude Code project settings', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const responseBody = JSON.stringify({ ok: true, upstreamUrl: req.url });
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      res.end(responseBody);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxyPort = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-discovery-home-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-discovery-project-'));
  t.after(() => rm(monitorHome, { recursive: true, force: true }));
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  await mkdir(path.join(projectDir, '.claude'), { recursive: true });
  await writeFile(
    path.join(projectDir, '.claude', 'settings.local.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`
      }
    })
  );

  const child = spawn(process.execPath, [proxyPath], {
    cwd: projectDir,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_PROXY_PORT: String(proxyPort),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: '',
      ANTHROPIC_BASE_URL: ''
    }
  });
  t.after(() => terminateChild(child));

  await waitForHttp(`http://127.0.0.1:${proxyPort}/__claude-code-lens/health`);

  const response = await requestJson(
    `http://127.0.0.1:${proxyPort}/v1/messages?discovered=true`,
    { stream: false, messages: [{ role: 'user', content: 'hello' }] }
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    upstreamUrl: '/v1/messages?discovered=true'
  });
});

test('proxy preserves streamed tool_use blocks when SSE events are split across chunks', async (t) => {
  const streamPayload = [
    sseEvent({
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: []
      }
    }),
    sseEvent({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'Bash',
        input: {}
      }
    }),
    sseEvent({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"command":"echo hi"}'
      }
    }),
    sseEvent({ type: 'content_block_stop', index: 0 }),
    sseEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 2 }
    }),
    sseEvent({ type: 'message_stop' })
  ].join('');

  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream'
      });

      const firstEventEnd = streamPayload.indexOf('\n\n') + 2;
      const splitAt = firstEventEnd + 'data: '.length;
      res.write(streamPayload.slice(0, splitAt));
      setTimeout(() => {
        res.end(streamPayload.slice(splitAt));
      }, 10);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxyPort = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-stream-test-'));
  t.after(() => rm(monitorHome, { recursive: true, force: true }));

  const child = spawn(process.execPath, [proxyPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_PROXY_PORT: String(proxyPort),
      CLAUDE_CODE_LENS_TARGET_BASE_URL: `http://127.0.0.1:${upstreamPort}`
    }
  });
  t.after(() => terminateChild(child));

  await waitForHttp(`http://127.0.0.1:${proxyPort}/__claude-code-lens/health`);

  const sessionId = '123e4567-e89b-12d3-a456-426614174001';
  const response = await requestText(
    `http://127.0.0.1:${proxyPort}/v1/messages`,
    {
      stream: true,
      metadata: { session_id: sessionId },
      messages: [{ role: 'user', content: 'use tool' }]
    }
  );

  assert.equal(response.statusCode, 200);

  const { files, data: logData } = await readOnlyLogFile(path.join(monitorHome, 'raw_logs'), {
    predicate: data => Boolean(
      data.interactions
        ?.find(interaction => interaction.type === 'stream.final')
        ?.data?.content?.[0]
    )
  });
  assert.equal(files.length, 1);

  const final = logData.interactions.find(interaction => interaction.type === 'stream.final');
  const block = final?.data?.content?.[0];

  assert.deepEqual(block, {
    type: 'tool_use',
    id: 'toolu_test',
    name: 'Bash',
    input: { command: 'echo hi' }
  });
});
