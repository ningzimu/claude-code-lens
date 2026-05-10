import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLeadSubagentView
} from '../src/visualizer/lead-subagent-trace.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function jsonl(entries) {
  return entries.map(entry => JSON.stringify(entry)).join('\n');
}

function assistantEvent(timestamp, model, content) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      model,
      content
    }
  };
}

function lensInput(uid, timestamp) {
  return {
    uid,
    timestamp,
    type: 'input',
    data: {
      model: 'claude-sonnet-4-5',
      messages: [],
      metadata: {
        user_id: JSON.stringify({ session_id: SESSION_ID })
      }
    }
  };
}

function lensOutput(uid, timestamp, model, content) {
  return {
    uid,
    timestamp,
    type: 'stream.final',
    data: {
      model,
      stop_reason: 'tool_use',
      content
    }
  };
}

test('buildLeadSubagentView attributes Lens requests to lead, subagent, and unmatched buckets', async () => {
  const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'cclens-projects-'));
  const projectDir = path.join(projectsDir, '-tmp-project');
  const sessionDir = path.join(projectDir, SESSION_ID);
  const subagentsDir = path.join(sessionDir, 'subagents');
  await mkdir(subagentsDir, { recursive: true });

  await writeFile(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    jsonl([
      assistantEvent('2026-05-09T10:00:00.000Z', 'claude-sonnet-4-5', [
        {
          type: 'tool_use',
          id: 'toolu_lead',
          name: 'Agent',
          input: {
            description: 'Mock subagent task',
            subagent_type: 'mock-worker',
            prompt: 'Subagent task'
          }
        }
      ]),
      assistantEvent('2026-05-09T10:00:10.000Z', 'claude-sonnet-4-5', [
        {
          type: 'text',
          text: 'Lead agent summary'
        }
      ])
    ])
  );

  await writeFile(
    path.join(subagentsDir, 'agent-a123.jsonl'),
    jsonl([
      {
        type: 'user',
        timestamp: '2026-05-09T10:00:15.000Z',
        message: {
          role: 'user',
          content: 'Subagent task'
        }
      },
      assistantEvent('2026-05-09T10:00:20.000Z', 'claude-sonnet-4-5', [
        {
          type: 'tool_use',
          id: 'toolu_sub',
          name: 'Read',
          input: {
            file_path: 'demo.txt'
          }
        }
      ])
    ])
  );

  const logData = {
    session_id: SESSION_ID,
    interactions: [
      lensInput('lead-request', '2026-05-09T10:00:09.000Z'),
      lensOutput('lead-request', '2026-05-09T10:00:10.000Z', 'claude-sonnet-4-5', [
        {
          type: 'text',
          text: 'Lead agent summary'
        }
      ]),
      lensInput('subagent-request', '2026-05-09T10:00:19.000Z'),
      lensOutput('subagent-request', '2026-05-09T10:00:20.000Z', 'claude-sonnet-4-5', [
        {
          type: 'tool_use',
          id: 'toolu_sub',
          name: 'Read',
          input: {
            file_path: 'demo.txt'
          }
        }
      ]),
      lensInput('unmatched-request', '2026-05-09T11:00:00.000Z'),
      lensOutput('unmatched-request', '2026-05-09T11:00:01.000Z', 'claude-sonnet-4-5', [
        {
          type: 'text',
          text: 'No native event nearby'
        }
      ])
    ]
  };

  const view = await buildLeadSubagentView(logData, { projectsDir });

  assert.equal(view.nativeTrace.found, true);
  assert.equal(view.agents.find(agent => agent.id === 'lead')?.role, 'lead');
  const subagent = view.agents.find(agent => agent.id === 'a123');
  assert.equal(subagent?.role, 'subagent');
  assert.equal(subagent?.description, 'Mock subagent task');
  assert.equal(subagent?.subagentType, 'mock-worker');
  assert.equal(subagent?.name, 'mock-worker · Mock subagent task');

  assert.equal(view.assignments['lead-request'].agentId, 'lead');
  assert.equal(view.assignments['lead-request'].confidence, 'high');
  assert.equal(view.assignments['subagent-request'].agentId, 'a123');
  assert.equal(view.assignments['subagent-request'].confidence, 'high');
  assert.equal(view.assignments['unmatched-request'].agentId, 'unmatched');
  assert.equal(view.assignments['unmatched-request'].confidence, 'unmatched');
  assert.equal(view.stats.totalRequests, 3);
  assert.equal(view.stats.highConfidence, 2);
  assert.equal(view.stats.unmatched, 1);
});

test('buildLeadSubagentView returns an empty view when native trace is absent', async () => {
  const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'cclens-empty-projects-'));

  const view = await buildLeadSubagentView({
    session_id: SESSION_ID,
    interactions: [
      lensInput('request-1', '2026-05-09T10:00:00.000Z')
    ]
  }, { projectsDir });

  assert.equal(view.nativeTrace.found, false);
  assert.deepEqual(view.agents, []);
  assert.deepEqual(view.assignments, {});
  assert.equal(view.stats.totalRequests, 0);
});

test('buildLeadSubagentView does not recursively scan nested project files', async () => {
  const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'cclens-nested-projects-'));
  const nestedDir = path.join(projectsDir, '-tmp-project', 'nested');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(
    path.join(nestedDir, `${SESSION_ID}.jsonl`),
    jsonl([
      assistantEvent('2026-05-09T10:00:00.000Z', 'claude-sonnet-4-5', [
        { type: 'text', text: 'Nested file should be ignored' }
      ])
    ])
  );

  const view = await buildLeadSubagentView({
    session_id: SESSION_ID,
    interactions: [
      lensOutput('request-1', '2026-05-09T10:00:00.000Z', 'claude-sonnet-4-5', [
        { type: 'text', text: 'Nested file should be ignored' }
      ])
    ]
  }, { projectsDir });

  assert.equal(view.nativeTrace.found, false);
  assert.equal(view.nativeTrace.reason, 'native_trace_not_found');
});

test('buildLeadSubagentView consumes native assistant events only once', async () => {
  const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'cclens-one-to-one-projects-'));
  const projectDir = path.join(projectsDir, '-tmp-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    jsonl([
      assistantEvent('2026-05-09T10:00:00.000Z', 'claude-sonnet-4-5', [
        { type: 'text', text: 'Shared native response body for matching' }
      ])
    ])
  );

  const view = await buildLeadSubagentView({
    session_id: SESSION_ID,
    interactions: [
      lensOutput('request-1', '2026-05-09T10:00:00.000Z', 'claude-sonnet-4-5', [
        { type: 'text', text: 'Shared native response body for matching' }
      ]),
      lensOutput('request-2', '2026-05-09T10:00:00.000Z', 'claude-sonnet-4-5', [
        { type: 'text', text: 'Shared native response body for matching' }
      ])
    ]
  }, { projectsDir });

  assert.equal(view.assignments['request-1'].agentId, 'lead');
  assert.equal(view.assignments['request-1'].confidence, 'high');
  assert.equal(view.assignments['request-2'].agentId, 'unmatched');
  assert.equal(view.assignments['request-2'].confidence, 'unmatched');
  assert.equal(view.stats.highConfidence, 1);
  assert.equal(view.stats.unmatched, 1);
});
