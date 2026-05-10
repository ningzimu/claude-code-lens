import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HIGH_CONFIDENCE_SCORE = 60;
const LOW_CONFIDENCE_SCORE = 25;
const TIME_MATCH_LIMIT_MS = 30_000;
const nativeSessionFileCache = new Map();

function emptyView(sessionId, reason = 'native_trace_not_found') {
  return {
    nativeTrace: {
      found: false,
      sessionId,
      reason
    },
    agents: [],
    assignments: {},
    stats: {
      totalRequests: 0,
      highConfidence: 0,
      lowConfidence: 0,
      unmatched: 0
    }
  };
}

function isSessionId(value) {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findNativeSessionFile(sessionId, projectsDir = DEFAULT_PROJECTS_DIR) {
  if (!isSessionId(sessionId)) return null;

  const cacheKey = `${projectsDir}\0${sessionId}`;
  if (nativeSessionFileCache.has(cacheKey)) {
    return nativeSessionFileCache.get(cacheKey);
  }

  let projectEntries = [];
  try {
    projectEntries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const exactName = `${sessionId}.jsonl`;
  const projectDirs = projectEntries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  for (const projectDir of projectDirs) {
    const candidate = path.join(projectsDir, projectDir, exactName);
    if (await pathExists(candidate)) {
      nativeSessionFileCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  return null;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(safeJsonParse)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function contentBlocks(content) {
  return Array.isArray(content) ? content : [];
}

function textFromContent(content) {
  if (typeof content === 'string') return content;

  return contentBlocks(content)
    .filter(block => block?.type === 'text' || block?.type === 'thinking')
    .map(block => block.text || block.thinking || '')
    .join('\n');
}

function toolSignatureFromContent(content) {
  return contentBlocks(content)
    .filter(block => block?.type === 'tool_use')
    .map(block => block.name)
    .filter(Boolean)
    .join(',');
}

function firstMeaningfulText(events) {
  for (const event of events) {
    const text = textFromContent(event.message?.content).replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

function countTools(events) {
  const counts = new Map();
  for (const event of events) {
    for (const block of contentBlocks(event.message?.content)) {
      if (block?.type === 'tool_use' && block.name) {
        counts.set(block.name, (counts.get(block.name) || 0) + 1);
      }
    }
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstUserText(events) {
  const firstUser = events.find(event => event.type === 'user');
  return compactText(textFromContent(firstUser?.message?.content) || firstUser?.message?.content);
}

function collectSubagentSpawns(nativeFile) {
  return readJsonl(nativeFile)
    .filter(event => event.type === 'assistant' && event.timestamp)
    .flatMap(event => contentBlocks(event.message?.content)
      .filter(block => block?.type === 'tool_use' && ['Agent', 'Task'].includes(block.name))
      .map(block => ({
        timestamp: event.timestamp,
        description: block.input?.description || '',
        subagentType: block.input?.subagent_type || '',
        prompt: compactText(block.input?.prompt),
        toolName: block.name
      })))
    .filter(spawn => spawn.description || spawn.subagentType || spawn.prompt);
}

function scoreSpawnForAgent(spawn, agent) {
  const spawnTime = Date.parse(spawn.timestamp);
  const startTime = Date.parse(agent.startTime);
  if (!Number.isFinite(spawnTime) || !Number.isFinite(startTime)) return 0;
  const deltaMs = startTime - spawnTime;
  if (deltaMs < -1000 || deltaMs > 10 * 60 * 1000) return 0;

  let score = deltaMs <= 5000 ? 40 : deltaMs <= 60_000 ? 25 : 10;
  const prompt = spawn.prompt;
  const firstText = compactText(agent.firstUserText);
  if (prompt && firstText) {
    const sample = firstText.slice(0, 80);
    if (prompt.includes(sample) || firstText.includes(prompt.slice(0, 80))) {
      score += 80;
    }
  }
  return score;
}

function agentDisplayName(agentId, metadata = {}) {
  if (metadata.subagentType && metadata.description) {
    return `${metadata.subagentType} · ${metadata.description}`;
  }
  if (metadata.description) return metadata.description;
  if (metadata.subagentType) return metadata.subagentType;
  return agentId;
}

function matchSpawnMetadata(agent, spawns, usedSpawnIndexes) {
  let best = null;
  spawns.forEach((spawn, index) => {
    if (usedSpawnIndexes.has(index)) return;
    const score = scoreSpawnForAgent(spawn, agent);
    if (!best || score > best.score) {
      best = { spawn, index, score };
    }
  });

  if (!best || best.score <= 0) return {};
  usedSpawnIndexes.add(best.index);
  return {
    description: best.spawn.description || '',
    subagentType: best.spawn.subagentType || '',
    spawnTimestamp: best.spawn.timestamp,
    spawnToolName: best.spawn.toolName
  };
}

function parseAgentFile(filePath, agentId, role, metadata = {}) {
  const rawEvents = readJsonl(filePath)
    .filter(event => event.timestamp && (event.type === 'user' || event.type === 'assistant'));

  const assistantEvents = rawEvents
    .filter(event => event.type === 'assistant')
    .map((event, index) => {
      const content = event.message?.content;
      return {
        id: `${agentId}:${index}`,
        agentId,
        role,
        timestamp: event.timestamp,
        model: event.message?.model || null,
        toolSignature: toolSignatureFromContent(content),
        text: textFromContent(content).replace(/\s+/g, ' ').trim(),
        sourceFile: filePath
      };
    });

  return {
    agent: {
      id: agentId,
      role,
      name: role === 'lead' ? 'Lead' : agentDisplayName(agentId, metadata),
      description: metadata.description || '',
      subagentType: metadata.subagentType || '',
      spawnTimestamp: metadata.spawnTimestamp || null,
      spawnToolName: metadata.spawnToolName || null,
      sourceFile: filePath,
      startTime: rawEvents[0]?.timestamp || null,
      endTime: rawEvents[rawEvents.length - 1]?.timestamp || null,
      eventCount: rawEvents.length,
      assistantEventCount: assistantEvents.length,
      firstUserText: firstUserText(rawEvents),
      firstText: firstMeaningfulText(rawEvents),
      toolsUsed: countTools(rawEvents)
    },
    assistantEvents
  };
}

export function parseNativeSession(nativeFile) {
  const sessionId = path.basename(nativeFile, '.jsonl');
  const lead = parseAgentFile(nativeFile, 'lead', 'lead');
  const agents = [lead.agent];
  const assistantEvents = [...lead.assistantEvents];
  const spawns = collectSubagentSpawns(nativeFile);
  const usedSpawnIndexes = new Set();

  const subagentsDir = path.join(path.dirname(nativeFile), sessionId, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    const subagentFiles = fs.readdirSync(subagentsDir)
      .filter(name => name.startsWith('agent-') && name.endsWith('.jsonl') && !name.includes('acompact-'))
      .sort();

    for (const fileName of subagentFiles) {
      const agentId = fileName.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      const subagentFile = path.join(subagentsDir, fileName);
      const metadata = matchSpawnMetadata(parseAgentFile(subagentFile, agentId, 'subagent').agent, spawns, usedSpawnIndexes);
      const parsed = parseAgentFile(subagentFile, agentId, 'subagent', metadata);
      agents.push(parsed.agent);
      assistantEvents.push(...parsed.assistantEvents);
    }
  }

  return {
    found: true,
    sessionId,
    nativeFile,
    subagentsDir,
    agents,
    assistantEvents
  };
}

function lensRequests(logData) {
  const byUid = new Map();

  for (const interaction of logData?.interactions || []) {
    if (!interaction?.uid) continue;
    if (!byUid.has(interaction.uid)) {
      byUid.set(interaction.uid, { uid: interaction.uid });
    }

    const request = byUid.get(interaction.uid);
    if (interaction.type === 'input') {
      request.inputAt = interaction.timestamp;
      request.inputModel = interaction.data?.model || null;
    } else if (interaction.type === 'output' || interaction.type === 'stream.final') {
      request.outputAt = interaction.timestamp;
      request.model = interaction.data?.model || request.inputModel || null;
      request.toolSignature = toolSignatureFromContent(interaction.data?.content);
      request.text = textFromContent(interaction.data?.content).replace(/\s+/g, ' ').trim();
    }
  }

  return [...byUid.values()].filter(request => request.outputAt);
}

function textMatches(a, b) {
  if (!a || !b) return false;
  const left = a.slice(0, 80);
  const right = b.slice(0, 80);
  const min = 24;

  if (left.length < min || right.length < min) return false;
  return left.includes(right.slice(0, min)) || right.includes(left.slice(0, min));
}

function scoreMatch(request, event) {
  const requestTime = Date.parse(request.outputAt);
  const eventTime = Date.parse(event.timestamp);
  if (!Number.isFinite(requestTime) || !Number.isFinite(eventTime)) {
    return { score: 0, deltaMs: Number.POSITIVE_INFINITY, reasons: [] };
  }

  const deltaMs = Math.abs(requestTime - eventTime);
  const reasons = [];
  let score = 0;

  if (deltaMs <= 1500) {
    score += 50;
    reasons.push('timestamp<=1.5s');
  } else if (deltaMs <= 5000) {
    score += 35;
    reasons.push('timestamp<=5s');
  } else if (deltaMs <= TIME_MATCH_LIMIT_MS) {
    score += 15;
    reasons.push('timestamp<=30s');
  } else {
    return { score: 0, deltaMs, reasons: ['timestamp-too-far'] };
  }

  if (request.model && event.model && request.model === event.model) {
    score += 10;
    reasons.push('model');
  }

  if (request.toolSignature && event.toolSignature && request.toolSignature === event.toolSignature) {
    score += 25;
    reasons.push('tools');
  }

  if (textMatches(request.text, event.text)) {
    score += 20;
    reasons.push('text');
  }

  return { score, deltaMs, reasons };
}

function confidenceForScore(score) {
  if (score >= HIGH_CONFIDENCE_SCORE) return 'high';
  if (score >= LOW_CONFIDENCE_SCORE) return 'low';
  return 'unmatched';
}

function unmatchedAssignment(uid) {
  return {
    uid,
    agentId: 'unmatched',
    agentName: 'Unmatched',
    agentRole: 'unmatched',
    confidence: 'unmatched',
    score: 0,
    deltaMs: null,
    matchReason: 'no-native-assistant-event'
  };
}

export function attributeLensRequests(logData, nativeTrace) {
  const agentsById = new Map(nativeTrace.agents.map(agent => [agent.id, agent]));
  const availableEvents = [...nativeTrace.assistantEvents].sort((a, b) =>
    Date.parse(a.timestamp) - Date.parse(b.timestamp)
  );
  const usedEventIds = new Set();
  const assignments = {};
  const stats = {
    totalRequests: 0,
    highConfidence: 0,
    lowConfidence: 0,
    unmatched: 0
  };

  const requests = lensRequests(logData).sort((a, b) =>
    Date.parse(a.outputAt) - Date.parse(b.outputAt)
  );

  for (const request of requests) {
    stats.totalRequests += 1;

    let best = null;
    for (const event of availableEvents) {
      if (usedEventIds.has(event.id)) continue;
      const match = scoreMatch(request, event);
      if (!best || match.score > best.score || (match.score === best.score && match.deltaMs < best.deltaMs)) {
        best = { ...match, event };
      }
    }

    const confidence = confidenceForScore(best?.score || 0);
    if (!best || confidence === 'unmatched') {
      assignments[request.uid] = unmatchedAssignment(request.uid);
      stats.unmatched += 1;
      continue;
    }

    usedEventIds.add(best.event.id);
    const agent = agentsById.get(best.event.agentId);
    assignments[request.uid] = {
      uid: request.uid,
      agentId: best.event.agentId,
      agentName: agent?.name || best.event.agentId,
      agentRole: agent?.role || 'subagent',
      confidence,
      score: best.score,
      deltaMs: best.deltaMs,
      matchReason: best.reasons.join('+') || 'timestamp'
    };

    if (confidence === 'high') {
      stats.highConfidence += 1;
    } else {
      stats.lowConfidence += 1;
    }
  }

  return { assignments, stats };
}

export async function buildLeadSubagentView(logData, options = {}) {
  const sessionId = logData?.session_id;
  if (!isSessionId(sessionId)) {
    return emptyView(sessionId || null, 'missing-session-id');
  }

  const projectsDir = options.projectsDir || DEFAULT_PROJECTS_DIR;
  const nativeFile = await findNativeSessionFile(sessionId, projectsDir);
  if (!nativeFile) {
    return emptyView(sessionId);
  }

  const parsed = parseNativeSession(nativeFile);
  const { assignments, stats } = attributeLensRequests(logData, parsed);

  return {
    nativeTrace: {
      found: true,
      sessionId,
      nativeFile: parsed.nativeFile,
      subagentsDir: parsed.subagentsDir,
      assistantEventCount: parsed.assistantEvents.length
    },
    agents: parsed.agents,
    assignments,
    stats
  };
}
