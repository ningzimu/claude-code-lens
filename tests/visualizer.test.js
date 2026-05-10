import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const visualizerPath = path.join(repoRoot, 'src', 'visualizer', 'server.js');
const visualizerHtmlPath = path.join(repoRoot, 'src', 'visualizer', 'public', 'index.html');
const reloadPositionPath = path.join(repoRoot, 'src', 'visualizer', 'public', 'reload-position.js');
const downloadCurrentLogPath = path.join(repoRoot, 'src', 'visualizer', 'public', 'download-current-log.js');
const leadSubagentSessionId = '11111111-2222-4333-8444-555555555555';

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

function jsonl(entries) {
  return entries.map(entry => JSON.stringify(entry)).join('\n');
}

test('visualizer server reads port from monitor config', async (t) => {
  const port = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-visualizer-test-'));
  await mkdir(monitorHome, { recursive: true });
  await writeFile(
    path.join(monitorHome, 'config.json'),
    JSON.stringify({
      visualizer: { port }
    })
  );

  const child = spawn(process.execPath, [visualizerPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND: 'true',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: ''
    }
  });
  t.after(() => terminateChild(child));

  const response = await waitForHttp(`http://127.0.0.1:${port}/__claude-code-lens/health`);
  assert.equal(response.status, 200);
});

test('visualizer log API sorts files by modified time descending', async (t) => {
  const port = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-visualizer-test-'));
  const logsDir = path.join(monitorHome, 'raw_logs');
  await mkdir(logsDir, { recursive: true });

  const oldLog = path.join(logsDir, 'old.json');
  const newLog = path.join(logsDir, 'new.json');
  await writeFile(oldLog, '{}');
  await writeFile(newLog, '{}');
  await utimes(oldLog, new Date('2026-04-27T00:00:00Z'), new Date('2026-04-27T00:00:00Z'));
  await utimes(newLog, new Date('2026-04-28T00:00:00Z'), new Date('2026-04-28T00:00:00Z'));

  const child = spawn(process.execPath, [visualizerPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND: 'true',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: String(port)
    }
  });
  t.after(() => terminateChild(child));

  const response = await waitForHttp(`http://127.0.0.1:${port}/api/logs`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.logs.map(log => log.name), ['new.json', 'old.json']);
});

test('visualizer lead/subagent API enriches a Lens log with native trace metadata', async (t) => {
  const port = await freePort();
  const monitorHome = await mkdtemp(path.join(os.tmpdir(), 'claude-monitor-lead-subagent-test-'));
  const logsDir = path.join(monitorHome, 'raw_logs');
  const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-projects-lead-subagent-test-'));
  const projectDir = path.join(projectsDir, '-tmp-project');
  const sessionDir = path.join(projectDir, leadSubagentSessionId);
  const subagentsDir = path.join(sessionDir, 'subagents');
  await mkdir(logsDir, { recursive: true });
  await mkdir(subagentsDir, { recursive: true });

  await writeFile(
    path.join(projectDir, `${leadSubagentSessionId}.jsonl`),
    jsonl([
      {
        type: 'assistant',
        timestamp: '2026-05-09T10:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Lead response for API test' }]
        }
      }
    ])
  );

  await writeFile(
    path.join(subagentsDir, 'agent-b456.jsonl'),
    jsonl([
      {
        type: 'assistant',
        timestamp: '2026-05-09T10:00:10.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'demo.txt' } }]
        }
      }
    ])
  );

  await writeFile(
    path.join(logsDir, 'messages-test.json'),
    JSON.stringify({
      session_id: leadSubagentSessionId,
      interactions: [
        {
          uid: 'subagent-request',
          type: 'stream.final',
          timestamp: '2026-05-09T10:00:10.000Z',
          data: {
            model: 'claude-sonnet-4-5',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'demo.txt' } }]
          }
        }
      ]
    })
  );

  const child = spawn(process.execPath, [visualizerPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_LENS_HOME: monitorHome,
      CLAUDE_CODE_LENS_CLAUDE_PROJECTS_DIR: projectsDir,
      CLAUDE_CODE_LENS_VISUALIZER_BACKGROUND: 'true',
      CLAUDE_CODE_LENS_VISUALIZER_PORT: String(port)
    }
  });
  t.after(() => terminateChild(child));

  const response = await waitForHttp(`http://127.0.0.1:${port}/api/lead-subagent-view?log=messages-test.json`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.nativeTrace.found, true);
  assert.equal(body.agents.some(agent => agent.id === 'lead'), true);
  assert.equal(body.agents.some(agent => agent.id === 'b456'), true);
  assert.equal(body.assignments['subagent-request'].agentId, 'b456');
  assert.equal(body.assignments['subagent-request'].confidence, 'high');
});

test('visualizer live reload follows newest request only when already at latest', async () => {
  await import(`${pathToFileURL(reloadPositionPath).href}?cache=${Date.now()}`);
  const { normalizeLoadOptions, resolveTargetIndex } = globalThis.CCLensReloadPosition;
  const options = normalizeLoadOptions({ preservePosition: true });

  assert.equal(resolveTargetIndex({
    total: 15,
    options,
    previousIndex: 13,
    previousTotal: 14,
    storedIndex: 6
  }), 14);

  assert.equal(resolveTargetIndex({
    total: 15,
    options,
    previousIndex: 6,
    previousTotal: 14,
    storedIndex: 6
  }), 6);

  assert.equal(resolveTargetIndex({
    total: 15,
    options: normalizeLoadOptions({ preferLatest: true }),
    storedIndex: 6
  }), 14);
});

test('visualizer builds download metadata for remote and local session logs', async () => {
  await import(`${pathToFileURL(downloadCurrentLogPath).href}?cache=${Date.now()}`);
  const { resolveDownloadInfo } = globalThis.CCLensDownloadCurrentLog;

  const markdownInfo = resolveDownloadInfo({
    currentLogUrl: '/logs/messages-20260429_032823-a72e23d4.json',
    parsedData: {
      session_title: 'Session a72e23d4',
      prompts: { prompt_1: 'System prompt text' }
    },
    conversations: [{
      uid: 'req-1',
      started_at: '2026-05-09T10:00:00.000Z',
      agentRole: 'subagent',
      agentName: 'mock-worker · Mock subagent task',
      agentId: 'a04a',
      agentConfidence: 'high',
      input: {
        model: 'claude-sonnet',
        system: 'prompt_1',
        messages: [
          { role: 'user', content: 'Earlier context should not repeat' },
          {
            role: 'user',
            content: '<system-reminder>Hidden runtime reminder</system-reminder>\nRun mock task'
          }
        ]
      },
      result: {
        data: {
          content: [
            { type: 'thinking', thinking: 'Consider the mock task context.' },
            { type: 'text', text: 'Mock task complete' }
          ],
          text: 'Mock task complete'
        }
      }
    }],
    agentFilter: 'agent:a04a',
    leadSubagentView: {
      nativeTrace: {
        nativeFile: '/tmp/mock-home/.claude/projects/-workspace-demo-project/session.jsonl'
      },
      agents: [{
        id: 'a04a',
        role: 'subagent',
        description: 'Mock subagent task',
        subagentType: 'mock-worker'
      }]
    },
    date: new Date('2026-05-09T12:00:00.000Z')
  });

  assert.equal(markdownInfo.enabled, true);
  assert.equal(markdownInfo.kind, 'blob');
  assert.equal(markdownInfo.mimeType, 'text/markdown');
  assert.equal(markdownInfo.fileName, 'claude-context-workspace_demo_project-mock-worker-2026-05-09.md');
  assert.match(markdownInfo.text, /# Previous Conversation Context/);
  assert.match(markdownInfo.text, /Current filter:\*\* Subagent: mock-worker/);
  assert.match(markdownInfo.text, /## Conversation History/);
  assert.match(markdownInfo.text, /### Message 1: User/);
  assert.match(markdownInfo.text, /### Message 2: Assistant/);
  assert.match(markdownInfo.text, /Run mock task/);
  assert.doesNotMatch(markdownInfo.text, /system-reminder/);
  assert.doesNotMatch(markdownInfo.text, /Hidden runtime reminder/);
  assert.doesNotMatch(markdownInfo.text, /Earlier context should not repeat/);
  assert.match(markdownInfo.text, /Thinking:/);
  assert.match(markdownInfo.text, /Consider the mock task context/);
  assert.match(markdownInfo.text, /Mock task complete/);
  assert.doesNotMatch(markdownInfo.text, /### System/);
  assert.doesNotMatch(markdownInfo.text, /System prompt text/);
  assert.doesNotMatch(markdownInfo.text, /Agent ID/);
  assert.doesNotMatch(markdownInfo.text, /Confidence/);
  assert.doesNotMatch(markdownInfo.text, /Model:/);
  assert.doesNotMatch(markdownInfo.text, /messages-20260429_032823-a72e23d4\.json"\s*:/);

  const titleRequestInfo = resolveDownloadInfo({
    currentLogUrl: '/logs/messages-20260429_032823-a72e23d4.json',
    parsedData: {
      session_title: 'Session a72e23d4',
      prompts: { title_prompt: 'Generate a concise, sentence-case title. Return JSON with a single "title" field.' }
    },
    conversations: [{
      uid: 'title-req',
      started_at: '2026-05-09T10:00:00.000Z',
      input: {
        system: 'title_prompt',
        messages: [{ role: 'user', content: 'Original user request' }]
      },
      result: {
        data: {
          content: [{ type: 'text', text: '{"title":"Demo task"}' }]
        }
      }
    }],
    agentFilter: 'lead',
    date: new Date('2026-05-09T12:00:00.000Z')
  });
  assert.doesNotMatch(titleRequestInfo.text, /Original user request/);
  assert.doesNotMatch(titleRequestInfo.text, /Demo task/);
  assert.match(titleRequestInfo.text, /Messages in this export:\*\* 0/);

  assert.deepEqual(resolveDownloadInfo({
    currentLogUrl: '/logs/messages-20260429_032823-a72e23d4.json'
  }), {
    enabled: true,
    kind: 'remote',
    href: '/logs/messages-20260429_032823-a72e23d4.json',
    fileName: 'messages-20260429_032823-a72e23d4.json'
  });

  assert.deepEqual(resolveDownloadInfo({
    currentLogUrl: 'local-file:1',
    localFile: {
      name: 'manual-session.json',
      text: '{"ok":true}'
    }
  }), {
    enabled: true,
    kind: 'blob',
    text: '{"ok":true}',
    fileName: 'manual-session.json'
  });

  assert.deepEqual(resolveDownloadInfo({ currentLogUrl: '' }), {
    enabled: false
  });
});

test('visualizer fixes the right rail in the viewport and exposes a back-to-top control', async () => {
  const html = await readFile(visualizerHtmlPath, 'utf8');

  assert.match(html, /#resourceRail\.rail-right\s*\{[^}]*position:\s*fixed/s);
  assert.match(html, /#resourceRail\.rail-right\s*\{[^}]*right:\s*0/s);
  assert.match(html, /#resourceRail\.rail-right\s*\{[^}]*bottom:\s*0/s);
  assert.match(html, /id="backToTopBtn"/);
  assert.match(html, /function syncBackToTopButton\(\)/);
  assert.match(html, /window\.scrollTo\(\{\s*top:\s*0,\s*behavior:\s*'smooth'\s*\}\)/s);
});

test('visualizer renders rail hover information outside the scroll-clipped rail', async () => {
  const html = await readFile(visualizerHtmlPath, 'utf8');

  assert.match(html, /id="railHoverTooltip"/);
  assert.match(html, /function showRailHoverTooltip\(trigger\)/);
  assert.match(html, /railHoverTooltip\.style\.position\s*=\s*'fixed'/);
  assert.match(html, /document\.addEventListener\('mouseover'/);
  assert.doesNotMatch(html, /button\.title\s*=\s*option\.tooltip/);
  assert.doesNotMatch(html, /\|\|\s*trigger\.title/);
});
