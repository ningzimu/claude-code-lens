(function attachDownloadCurrentLog(root) {
  function fileNameFromUrl(value) {
    const lastSegment = String(value || '').split('/').pop() || '';
    try {
      return decodeURIComponent(lastSegment);
    } catch {
      return lastSegment;
    }
  }

  function slug(value, fallback = 'session') {
    const text = String(value || '').trim()
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return text || fallback;
  }

  function fileSlug(value, fallback = 'session') {
    const text = String(value || '').trim()
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return text || fallback;
  }

  function projectNameFromNativeFile(nativeFile) {
    const projectDir = String(nativeFile || '').split('/').filter(Boolean).slice(-2, -1)[0] || '';
    if (!projectDir) return '';
    const parts = projectDir.split('-').filter(Boolean);
    if (parts.length >= 3) return parts.slice(-3).join('_');
    return parts.join('_');
  }

  function markdownEscape(value) {
    return String(value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();
  }

  function resolvePromptRef(value, prompts = {}) {
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(prompts, value)) {
      return prompts[value];
    }
    return value;
  }

  function contentToMarkdown(content, prompts = {}) {
    const resolved = resolvePromptRef(content, prompts);
    if (typeof resolved === 'string') return markdownEscape(resolved);
    if (!Array.isArray(resolved)) {
      return `\`\`\`json\n${JSON.stringify(resolved ?? {}, null, 2)}\n\`\`\``;
    }

    const lines = [];
    resolved.forEach(block => {
      if (!block) return;
      if (block.type === 'text') {
        lines.push(markdownEscape(resolvePromptRef(block.text, prompts)));
      } else if (block.type === 'thinking') {
        lines.push('**Thinking:**');
        lines.push('');
        lines.push(markdownEscape(block.thinking || ''));
      } else if (block.type === 'tool_use') {
        lines.push(`**Tool Use:** \`${block.name || 'tool'}\``);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(block.input || {}, null, 2));
        lines.push('```');
      } else if (block.type === 'tool_result') {
        lines.push('**Tool Result:**');
        lines.push('');
        lines.push('```');
        lines.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {}, null, 2));
        lines.push('```');
      } else {
        lines.push('```json');
        lines.push(JSON.stringify(block, null, 2));
        lines.push('```');
      }
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  function filterDetails(agentFilter, view = {}) {
    if (agentFilter === 'lead') return { label: 'Lead', slug: 'lead' };
    if (agentFilter === 'unmatched') return { label: 'Unmatched', slug: 'unmatched' };
    if (String(agentFilter || '').startsWith('agent:')) {
      const agentId = String(agentFilter).slice('agent:'.length);
      const agent = (view.agents || []).find(item => item.id === agentId) || {};
      const type = agent.subagentType || 'subagent';
      const description = agent.description ? ` · ${agent.description}` : '';
      return {
        label: `Subagent: ${type}${description}`,
        slug: fileSlug(type, 'subagent')
      };
    }
    return { label: 'All agents', slug: 'all' };
  }

  function isTitleGenerationConversation(conv, prompts) {
    const systemText = contentToMarkdown(conv?.input?.system, prompts);
    return systemText.includes('Generate a concise, sentence-case title') &&
      systemText.includes('Return JSON with a single "title" field');
  }

  function buildMarkdownExport({
    currentLogUrl,
    parsedData,
    conversations = [],
    agentFilter = 'all',
    leadSubagentView = {},
    date = new Date()
  } = {}) {
    const prompts = parsedData?.prompts || {};
    const filter = filterDetails(agentFilter, leadSubagentView);
    const nativeFile = leadSubagentView?.nativeTrace?.nativeFile || '';
    const projectName = projectNameFromNativeFile(nativeFile) || parsedData?.session_title || fileNameFromUrl(currentLogUrl);
    const dateText = date.toISOString().split('T')[0];
    const fileName = `claude-context-${slug(projectName)}-${filter.slug}-${dateText}.md`;
    const historyLines = [];
    let messageNumber = 1;

    function pushConversationMessage(role, timestamp, content) {
      const rendered = contentToMarkdown(content, prompts);
      if (!rendered) return;

      historyLines.push(`### Message ${messageNumber}: ${role}`);
      historyLines.push(timestamp ? `*${timestamp}*` : '');
      historyLines.push('');
      historyLines.push(rendered);
      historyLines.push('');
      historyLines.push('---');
      historyLines.push('');
      messageNumber += 1;
    }

    conversations.forEach(conv => {
      if (isTitleGenerationConversation(conv, prompts)) return;

      if (Array.isArray(conv.input?.messages) && conv.input.messages.length) {
        const message = conv.input.messages[conv.input.messages.length - 1];
        const role = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'Message';
        pushConversationMessage(role, conv.started_at, message.content);
      }

      if (Array.isArray(conv.result?.data?.content)) {
        pushConversationMessage('Assistant', conv.finished_at || conv.started_at, conv.result.data.content);
      } else if (conv.result?.data?.text) {
        pushConversationMessage('Assistant', conv.finished_at || conv.started_at, conv.result.data.text);
      }
    });

    const lines = [];
    lines.push('# Previous Conversation Context');
    lines.push('');
    lines.push('> Human-readable Claude Code Lens trace export for the currently selected Lead/Subagent filter.');
    lines.push('');
    lines.push(`**Project:** ${projectName || 'Unknown'}`);
    lines.push(`**Date:** ${dateText}`);
    lines.push(`**Current filter:** ${filter.label}`);
    lines.push(`**Messages in this export:** ${messageNumber - 1}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Conversation History');
    lines.push('');
    lines.push(...historyLines);
    lines.push('*Generated by Claude Code Lens*');
    return { text: lines.join('\n'), fileName };
  }

  function resolveDownloadInfo({ currentLogUrl, localFile } = {}) {
    const args = arguments[0] || {};
    if (!currentLogUrl) {
      return { enabled: false };
    }

    if (args.parsedData && Array.isArray(args.conversations)) {
      const exported = buildMarkdownExport(args);
      return {
        enabled: true,
        kind: 'blob',
        text: exported.text,
        fileName: exported.fileName,
        mimeType: 'text/markdown'
      };
    }

    if (localFile?.text != null) {
      return {
        enabled: true,
        kind: 'blob',
        text: localFile.text,
        fileName: localFile.name || 'claude-code-lens-session.json'
      };
    }

    return {
      enabled: true,
      kind: 'remote',
      href: currentLogUrl,
      fileName: fileNameFromUrl(currentLogUrl) || 'claude-code-lens-session.json'
    };
  }

  root.CCLensDownloadCurrentLog = {
    resolveDownloadInfo,
    buildMarkdownExport
  };
})(typeof window !== 'undefined' ? window : globalThis);
