/**
 * Parse SSE streaming responses and accumulate complete Anthropic Message object
 * No filtering - preserves all fields from the API response
 */
export class StreamParser {
  constructor() {
    this.reset();
  }

  reset() {
    // Complete message object - mirrors Anthropic API Message structure
    this.message = {
      id: null,
      type: 'message',
      role: 'assistant',
      model: null,
      stop_reason: null,
      stop_sequence: null,
      usage: null,
      content: []
    };

    // Track open content blocks by index
    this.openBlocks = new Map();
  }

  /**
   * Handle a single SSE event
   * @param {object} event - Parsed event object from SSE stream
   */
  handleEvent(event) {
    if (!event || typeof event !== 'object') return;

    const { type } = event;

    switch (type) {
      case 'message_start':
        this.handleMessageStart(event);
        break;
      case 'content_block_start':
        this.handleContentBlockStart(event);
        break;
      case 'content_block_delta':
        this.handleContentBlockDelta(event);
        break;
      case 'content_block_stop':
        this.handleContentBlockStop(event);
        break;
      case 'message_delta':
        this.handleMessageDelta(event);
        break;
      case 'message_stop':
        // Message complete - nothing to do, getFinal() will be called
        break;
      default:
        // Handle legacy tool_use format for compatibility
        if (type === 'tool_use') {
          this.handleLegacyToolUse(event);
        }
        break;
    }
  }

  /**
   * Handle message_start event - initialize message metadata
   */
  handleMessageStart(event) {
    const msg = event.message;
    if (!msg) return;

    // Copy all message-level fields
    this.message.id = msg.id ?? this.message.id;
    this.message.type = msg.type ?? this.message.type;
    this.message.role = msg.role ?? this.message.role;
    this.message.model = msg.model ?? this.message.model;
    this.message.stop_reason = msg.stop_reason ?? this.message.stop_reason;
    this.message.stop_sequence = msg.stop_sequence ?? this.message.stop_sequence;

    // Copy usage if present
    if (msg.usage) {
      this.message.usage = { ...msg.usage };
    }

    // Initialize content array if provided (usually empty at start)
    if (Array.isArray(msg.content)) {
      this.message.content = [...msg.content];
    }
  }

  /**
   * Handle content_block_start event - begin a new content block
   */
  handleContentBlockStart(event) {
    const { index, content_block } = event;
    if (index == null || !content_block) return;

    // Create a copy of the content block to accumulate
    const block = { ...content_block };

    // Initialize accumulation fields based on block type
    if (block.type === 'text') {
      block.text = block.text ?? '';
    } else if (block.type === 'tool_use') {
      block.input = block.input ?? {};
      // Track raw input JSON for parsing
      block._inputJson = '';
    } else if (block.type === 'thinking') {
      block.thinking = block.thinking ?? '';
    }

    // Store in open blocks map
    this.openBlocks.set(index, block);

    // Ensure content array is large enough
    while (this.message.content.length <= index) {
      this.message.content.push(null);
    }
    this.message.content[index] = block;
  }

  /**
   * Handle content_block_delta event - append to content block
   */
  handleContentBlockDelta(event) {
    const { index, delta } = event;
    if (index == null || !delta) return;

    const block = this.openBlocks.get(index);
    if (!block) {
      // Block not started yet, create a placeholder
      this.handleContentBlockStart({ index, content_block: { type: delta.type?.replace('_delta', '') || 'unknown' } });
      return this.handleContentBlockDelta(event);
    }

    // Handle different delta types
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      block.text = (block.text ?? '') + delta.text;
    } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      block._inputJson = (block._inputJson ?? '') + delta.partial_json;
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      block.thinking = (block.thinking ?? '') + delta.thinking;
    }

    // Update in message content
    this.message.content[index] = block;
  }

  /**
   * Handle content_block_stop event - finalize content block
   */
  handleContentBlockStop(event) {
    const { index } = event;
    if (index == null) return;

    const block = this.openBlocks.get(index);
    if (!block) return;

    // Parse accumulated JSON for tool_use blocks
    if (block.type === 'tool_use' && block._inputJson) {
      try {
        block.input = JSON.parse(block._inputJson);
      } catch (e) {
        // Keep raw string if JSON parsing fails
        block.input = block._inputJson;
      }
      delete block._inputJson;
    }

    // Update final block in message content
    this.message.content[index] = block;

    // Remove from open blocks
    this.openBlocks.delete(index);
  }

  /**
   * Handle message_delta event - update message metadata
   */
  handleMessageDelta(event) {
    const { delta, usage } = event;

    // Update delta fields
    if (delta) {
      if (delta.stop_reason !== undefined) {
        this.message.stop_reason = delta.stop_reason;
      }
      if (delta.stop_sequence !== undefined) {
        this.message.stop_sequence = delta.stop_sequence;
      }
    }

    // Update usage - this is the final usage from the API
    if (usage) {
      this.message.usage = {
        ...(this.message.usage || {}),
        ...usage
      };
    }
  }

  /**
   * Handle legacy tool_use event format for backwards compatibility
   */
  handleLegacyToolUse(event) {
    const { index, start, delta, stop, name, id } = event;
    
    if (start) {
      this.handleContentBlockStart({
        index,
        content_block: { type: 'tool_use', id, name, input: {} }
      });
    }
    
    if (typeof delta === 'string') {
      this.handleContentBlockDelta({
        index,
        delta: { type: 'input_json_delta', partial_json: delta }
      });
    }
    
    if (stop) {
      this.handleContentBlockStop({ index });
    }
  }

  /**
   * Finalize any open content blocks (e.g., on stream error)
   */
  finalizeDangling(error) {
    for (const [index, block] of this.openBlocks.entries()) {
      // Parse accumulated JSON for tool_use blocks
      if (block.type === 'tool_use' && block._inputJson) {
        try {
          block.input = JSON.parse(block._inputJson);
        } catch (e) {
          block.input = block._inputJson;
        }
        delete block._inputJson;
      }

      // Add error info if provided
      if (error) {
        block._error = error.stack || String(error);
      }

      this.message.content[index] = block;
    }
    this.openBlocks.clear();
  }

  /**
   * Get final complete message object
   * @returns {object} Complete Anthropic Message object
   */
  getFinal() {
    this.finalizeDangling();

    // Remove any null placeholders from content array
    this.message.content = this.message.content.filter(b => b !== null);

    return this.message;
  }
}

export default StreamParser;
