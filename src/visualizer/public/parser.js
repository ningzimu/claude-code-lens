/**
 * Parse JSON log file into structured output
 * Only supports JSON format from ~/.claude-code-monitor/raw_logs/
 * 
 * @param {string} rawLogString - The raw log content as a string (JSON format)
 * @returns {Object} Parsed and structured log data
 */
function parseConversationLog(rawLogString) {
  const ts = () => new Date().toISOString();

  // Parse JSON - only JSON format is supported
  let logData;
  try {
    logData = JSON.parse(rawLogString);
  } catch (e) {
    throw new Error(`Invalid log format: expected JSON. ${e.message}`);
  }

  // Validate JSON structure
  if (!logData.interactions || !Array.isArray(logData.interactions)) {
    throw new Error('Invalid log format: missing interactions array');
  }

  // Filter count messages setting (browser/Node.js compatible)
  const shouldFilterCountMessages = typeof process !== 'undefined' && process.env
    ? process.env.FILTER_COUNT_MESSAGES !== 'false'
    : true;

  /** Stable stringify with sorted keys for consistent dedupe */
  function stableStringify(v) {
    return JSON.stringify(v, function replacer(_key, value) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value;
        const sorted = {};
        for (const k of Object.keys(obj).sort()) {
          sorted[k] = obj[k];
        }
        return sorted;
      }
      return value;
    });
  }

  /** Deep JSON clone for plain data */
  function cloneJSON(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return obj;
    }
  }

  // ----- Global registries for tools and prompts -----

  const toolDefs = {};
  const toolCanonToId = new Map();
  const toolNameCounters = {};

  const promptDefs = {};
  const promptTextToId = new Map();
  let promptCounter = 0;

  const promptCounts = {};

  function registerTool(toolObj) {
    const canon = stableStringify(toolObj);
    let id = toolCanonToId.get(canon);
    if (!id) {
      const name =
        typeof toolObj?.["name"] === "string" && toolObj["name"].trim()
          ? toolObj["name"]
          : "Tool";
      const n = (toolNameCounters[name] = (toolNameCounters[name] || 0) + 1);
      id = `${name}_${n}`;
      toolCanonToId.set(canon, id);
      toolDefs[id] = toolObj;
    }
    return id;
  }

  function registerToolsArr(toolsArr) {
    if (!Array.isArray(toolsArr)) return toolsArr;
    return toolsArr.map((t) => registerTool((t ?? {})));
  }

  function registerPrompt(text) {
    if (typeof text !== "string") return text;
    let id = promptTextToId.get(text);
    if (!id) {
      id = `prompt_${++promptCounter}`;
      promptTextToId.set(text, id);
      promptDefs[id] = text;
      promptCounts[id] = 0;
    }
    promptCounts[id] = (promptCounts[id] ?? 0) + 1;
    return id;
  }

  // ----- Transform helpers applied to input params -----

  function transformContentBlock(block, isUser) {
    const b = cloneJSON(block);
    if (b && b["type"] === "text" && typeof b["text"] === "string") {
      const byPass = isUser && !b["text"].startsWith("<system-reminder>");
      if (!byPass) {
        b["text"] = registerPrompt(b["text"]);
      }
    }
    return b;
  }

  function transformMessage(mess) {
    const m = cloneJSON(mess);
    const content = m["content"];
    if (Array.isArray(content)) {
      m["content"] = content.map((blk) => transformContentBlock(blk, true));
    } else if (typeof content === "string") {
      const byPass = m["role"] === "user" && !content.startsWith("<system-reminder>");
      if (!byPass) {
        m["content"] = registerPrompt(content);
      }
    }
    return m;
  }

  /** Transform top-level params:
   * - tools -> array of tool ids
   * - messages/system -> replace text blocks with prompt_#
   */
  function transformParams(params) {
    const p = cloneJSON(params);

    if (Array.isArray(p["tools"])) {
      p["tools"] = registerToolsArr(p["tools"]);
    }

    if (Array.isArray(p["messages"])) {
      p["messages"] = p["messages"].map((m) => transformMessage(m));
    }

    const sys = p["system"];
    if (Array.isArray(sys)) {
      p["system"] = sys.map((b) => transformContentBlock(b));
    } else if (typeof sys === "string") {
      p["system"] = registerPrompt(sys);
    }

    return p;
  }

  // ----- Process interactions from JSON -----

  const convByUid = new Map();

  function ensureConv(uid, iso) {
    let c = convByUid.get(uid);
    if (!c) {
      c = {
        uid,
        started_at: iso,
        finished_at: null,
        request_id: null,
        input: null,
        result: null,
      };
      convByUid.set(uid, c);
    }
    return c;
  }

  /**
   * Normalize stream.final response data to support both old and new formats
   * Old format: { text: "...", tools: [...] }
   * New format: { id, model, content: [...], usage: {...}, ... }
   * Error format: { error: { message: "...", type: "...", ... } }
   * Returns: { text, tools, usage, raw } where raw is the original data
   */
  function normalizeResponseData(data) {
    if (!data) return { text: '', tools: [], usage: null, raw: data };

    // Check if error response
    if (data.error) {
      const errorMsg = typeof data.error === 'string' ? data.error :
                      (data.error.message || JSON.stringify(data.error));
      return {
        text: `[Error] ${errorMsg}`,
        tools: [],
        usage: null,
        model: null,
        stop_reason: 'error',
        raw: data
      };
    }

    // Check if new format (has content array)
    if (Array.isArray(data.content)) {
      let text = '';
      const tools = [];

      for (const block of data.content) {
        if (!block) continue;
        
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          // Include thinking in text with marker
          text += `[thinking]\n${block.thinking}\n[/thinking]\n`;
        } else if (block.type === 'tool_use') {
          tools.push({
            id: block.id,
            name: block.name,
            input: block.input
          });
        }
      }

      return {
        text,
        tools,
        usage: data.usage || null,
        model: data.model || null,
        stop_reason: data.stop_reason || null,
        raw: data
      };
    }

    // Old format - direct text and tools
    return {
      text: data.text || '',
      tools: data.tools || [],
      usage: null,
      model: null,
      stop_reason: null,
      raw: data
    };
  }

  // Process each interaction
  for (const interaction of logData.interactions) {
    const { uid, timestamp, type, data } = interaction;
    
    if (!uid || !type) continue;

    const conv = ensureConv(uid, timestamp);

    if (type === 'input') {
      // Check if should filter count messages
      const messages = data?.messages || [];
      const hasCountMessage = shouldFilterCountMessages && messages.some(m => {
        if (m.role === "user") {
          const content = typeof m.content === "string" ? m.content :
                         Array.isArray(m.content) ? m.content.map(c => c.text || "").join("") : "";
          return content.trim().toLowerCase() === "count";
        }
        return false;
      });

      if (hasCountMessage) {
        conv.filtered = true;
      } else {
        conv.input = transformParams(data);
        conv.started_at = conv.started_at || timestamp;
      }
    } else if (type === 'output') {
      // Normalize output response
      const normalized = normalizeResponseData(data);
      // Wrap in data property for renderer compatibility
      conv.result = { 
        type: "output", 
        data: {
          text: normalized.text,
          tools: normalized.tools,
          usage: normalized.usage,
          model: normalized.model,
          stop_reason: normalized.stop_reason,
          content: normalized.raw?.content  // Keep original content for renderer
        }
      };
      conv.finished_at = timestamp;
    } else if (type === 'stream.final') {
      // Normalize stream.final response - supports both old and new formats
      const normalized = normalizeResponseData(data);
      // Wrap in data property for renderer compatibility
      conv.result = { 
        type: "stream_final", 
        data: {
          text: normalized.text,
          tools: normalized.tools,
          usage: normalized.usage,
          model: normalized.model,
          stop_reason: normalized.stop_reason,
          content: normalized.raw?.content  // Keep original content for renderer
        }
      };
      conv.finished_at = timestamp;
    } else if (type === 'error') {
      conv.result = { type: "error", data: data?.message || String(data) };
      conv.finished_at = timestamp;
    }
  }

  // ----- Generate prompt kind guesses -----
  const promptKindGuess = {};
  for (const id of Object.keys(promptDefs)) {
    const c = promptCounts[id] ?? 0;
    promptKindGuess[id] = c > 1 ? "system_like" : "user_like";
  }

  // ----- Finalize -----

  const conversations = Array.from(convByUid.values())
    .filter(c => !c.filtered)
    .sort((a, b) => {
      const ta = a.started_at ? Date.parse(a.started_at) : 0;
      const tb = b.started_at ? Date.parse(b.started_at) : 0;
      return ta - tb;
    });

  // Use session_id as title, or created_at as fallback
  const sessionTitle = logData.session_id 
    ? `Session ${logData.session_id.substring(0, 8)}` 
    : `Session ${logData.created_at || 'Unknown'}`;

  return {
    session_title: sessionTitle,
    tool_defs: toolDefs,
    prompts: promptDefs,
    prompt_counts: promptCounts,
    prompt_kind_guess: promptKindGuess,
    conversations,
    generated_at: ts(),
  };
}

// Export for use in modules (optional)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = parseConversationLog;
}

// Export for ES6 modules (optional)
if (typeof window !== 'undefined') {
  window.parseConversationLog = parseConversationLog;
}
