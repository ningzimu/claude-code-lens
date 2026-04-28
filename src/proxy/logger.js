import fs from 'fs';
import path from 'path';
import os from 'os';

// JSON log directory - unified storage location
const APP_HOME = process.env.CLAUDE_MONITOR_HOME ||
  path.join(os.homedir(), '.claude-code-monitor');
const LOG_DIR = path.join(APP_HOME, 'raw_logs');

/**
 * Main Logger class (Singleton)
 * Manages session writers and provides factory method for creating logger contexts
 */
class Logger {
  constructor() {
    // Map: session ID -> SessionFileWriter
    this.sessionWriters = new Map();
    this.initLogDir();

    // Start cleanup timer for inactive writers
    this.startCleanupTimer();
  }

  /**
   * Ensure log directory exists
   */
  initLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  /**
   * Create a logger context for a request
   * @param {object} requestBody - API request body
   * @returns {LoggerContext} Logger context for this request
   */
  createContext(requestBody) {
    const sessionId = this.extractSessionId(requestBody);
    const writer = this.getOrCreateWriter(sessionId);
    return new LoggerContext(writer, sessionId);
  }

  /**
   * Extract session ID from request body
   * @param {object} requestBody - API request body
   * @returns {string} session ID (UUID) or 'unknown'
   */
  extractSessionId(requestBody) {
    const metadata = requestBody?.metadata;
    const directSessionId = metadata?.session_id;
    if (this.isSessionId(directSessionId)) {
      return directSessionId;
    }

    const userId = metadata?.user_id;
    if (!userId) {
      return 'unknown';
    }

    if (typeof userId === 'object' && this.isSessionId(userId.session_id)) {
      return userId.session_id;
    }

    if (typeof userId !== 'string') {
      return 'unknown';
    }

    try {
      const parsed = JSON.parse(userId);
      if (this.isSessionId(parsed?.session_id)) {
        return parsed.session_id;
      }
    } catch (error) {
      // Fall back to legacy string matching below.
    }

    // Legacy format: user_{hash}_account__session_{uuid}
    const match = userId.match(/session_([a-f0-9-]+)$/i);
    return match ? match[1] : 'unknown';
  }

  /**
   * Validate Claude session IDs before using them in file names
   * @param {unknown} value - Candidate session ID
   * @returns {boolean} true when value looks like a UUID
   */
  isSessionId(value) {
    return typeof value === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  }

  /**
   * Get or create SessionFileWriter for a session
   * @param {string} sessionId - Session ID
   * @returns {SessionFileWriter} Writer for this session
   */
  getOrCreateWriter(sessionId) {
    if (!this.sessionWriters.has(sessionId)) {
      const writer = new SessionFileWriter(sessionId);
      this.sessionWriters.set(sessionId, writer);

      const shortId = sessionId === 'unknown' ? 'unknown' : sessionId.substring(0, 8);
      console.log(`📁 Created writer for session: ${shortId}`);
    }

    return this.sessionWriters.get(sessionId);
  }

  /**
   * Start timer to clean up inactive writers
   * Runs every 10 minutes, removes writers inactive for > 1 hour
   */
  startCleanupTimer() {
    const cleanupInterval = 10 * 60 * 1000; // 10 minutes
    const inactiveThreshold = 60 * 60 * 1000; // 1 hour

    setInterval(async () => {
      const now = Date.now();

      for (const [sessionId, writer] of this.sessionWriters.entries()) {
        if (now - writer.lastAccess > inactiveThreshold) {
          await writer.close();
          this.sessionWriters.delete(sessionId);

          const shortId = sessionId === 'unknown' ? 'unknown' : sessionId.substring(0, 8);
          console.log(`🧹 Cleaned up writer for session: ${shortId}`);
        }
      }
    }, cleanupInterval);
  }

  /**
   * Close all writers (for graceful shutdown)
   * @returns {Promise} Resolves when all writers are closed
   */
  async closeAll() {
    const closePromises = [];

    for (const writer of this.sessionWriters.values()) {
      closePromises.push(writer.close());
    }

    await Promise.all(closePromises);
    console.log('✅ All log writers closed');
  }

  /**
   * Generate unique ID for requests
   * @returns {string} Unique identifier
   */
  uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Log proxy server message (not written to API interaction log)
   * @param {string} message - Log message
   */
  info(message) {
    console.log(`[PROXY] ${message}`);
  }

  /**
   * Log proxy server error
   * @param {string} message - Error message
   * @param {Error} error - Error object
   */
  error(message, error) {
    console.error(`[PROXY ERROR] ${message}`, error);
  }
}

/**
 * LoggerContext class (Request-scoped)
 * Provides logging methods for a single HTTP request
 */
class LoggerContext {
  constructor(writer, sessionId) {
    this.writer = writer;
    this.sessionId = sessionId;
  }

  /**
   * Sanitize sensitive header values
   * @param {object} headers - Original headers object
   * @returns {object} Sanitized headers object
   */
  sanitizeHeaders(headers) {
    if (!headers) return headers;

    const sanitized = { ...headers };

    // Headers to sanitize (lowercase)
    const sensitiveHeaders = ['authorization', 'x-api-key'];

    for (const key of Object.keys(sanitized)) {
      const lowerKey = key.toLowerCase();

      if (sensitiveHeaders.includes(lowerKey)) {
        const value = sanitized[key];

        if (typeof value === 'string') {
          // Handle Bearer token: "Bearer sk-xxx" -> "Bearer sk-*******"
          if (value.toLowerCase().startsWith('bearer ')) {
            const token = value.slice(7);
            sanitized[key] = `Bearer ${this.maskToken(token)}`;
          }
          // Handle plain API key: "sk-xxx" -> "sk-*******"
          else if (value.startsWith('sk-')) {
            sanitized[key] = this.maskToken(value);
          }
          // Other sensitive values: keep first 4 chars, mask rest
          else {
            sanitized[key] = this.maskToken(value);
          }
        }
      }
    }

    return sanitized;
  }

  /**
   * Mask token value
   * @param {string} token - Original token
   * @returns {string} Masked token
   */
  maskToken(token) {
    if (!token || token.length <= 4) {
      return '*******';
    }
    // Keep prefix (e.g., "sk-") and first few chars, mask rest
    const prefixMatch = token.match(/^([a-zA-Z]+-)/);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      const rest = token.slice(prefix.length);
      const visibleChars = Math.min(4, rest.length);
      return `${prefix}${rest.slice(0, visibleChars)}${'*'.repeat(7)}`;
    }
    // No prefix, keep first 4 chars
    return `${token.slice(0, 4)}${'*'.repeat(7)}`;
  }

  /**
   * Log API request input
   * @param {string} uid - Request unique identifier
   * @param {object} params - Request parameters
   * @param {object} reqInfo - Request info {method, path, headers}
   */
  logInput(uid, params, reqInfo = {}) {
    const sanitizedInfo = {
      method: reqInfo.method,
      path: reqInfo.path,
      headers: this.sanitizeHeaders(reqInfo.headers)
    };

    this.writer.appendInteraction('input', uid, params, sanitizedInfo);
  }

  /**
   * Log non-streaming response output
   * @param {string} uid - Request unique identifier
   * @param {object} data - Response data
   * @param {object} resInfo - Response info {statusCode, headers}
   */
  logOutput(uid, data, resInfo = {}) {
    const sanitizedInfo = {
      status_code: resInfo.statusCode,
      headers: this.sanitizeHeaders(resInfo.headers)
    };

    this.writer.appendInteraction('output', uid, data, sanitizedInfo);
  }

  /**
   * Log streaming response final result
   * @param {string} uid - Request unique identifier
   * @param {object} data - Final aggregated data
   * @param {object} resInfo - Response info {statusCode, headers}
   */
  logStreamFinal(uid, data, resInfo = {}) {
    const sanitizedInfo = {
      status_code: resInfo.statusCode,
      headers: this.sanitizeHeaders(resInfo.headers)
    };

    this.writer.appendInteraction('stream.final', uid, data, sanitizedInfo);
  }

  /**
   * Log error
   * @param {string} uid - Request unique identifier
   * @param {Error|string} error - Error object or message
   */
  logError(uid, error) {
    const errorMsg = error?.stack || String(error);

    this.writer.appendInteraction('error', uid, { message: errorMsg }, {});

    console.error(`[${uid}] ERROR:`, errorMsg);
  }
}

/**
 * SessionFileWriter class (Session-scoped)
 * Manages log file for a single session with async I/O and write queue
 */
class SessionFileWriter {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.jsonPath = null;
    this.jsonData = null;
    this.lastAccess = Date.now();

    // Write queue: ensures write operations are sequential
    this.writeQueue = Promise.resolve();

    this.init();
  }

  /**
   * Initialize writer: find or create log file
   */
  init() {
    const existingFile = this.findLogFile();

    if (existingFile) {
      this.loadFile(existingFile);
    } else {
      this.createNewFile();
    }
  }

  /**
   * Find existing log file by session ID
   * @returns {string|undefined} Path to existing log file or undefined
   */
  findLogFile() {
    if (!fs.existsSync(LOG_DIR)) {
      return undefined;
    }

    const shortId = this.sessionId === 'unknown' ? 'unknown' : this.sessionId.substring(0, 8);
    const pattern = new RegExp(`messages-\\d{8}_\\d{6}-${shortId}\\.json$`);

    try {
      const files = fs.readdirSync(LOG_DIR);
      return files
        .filter(f => pattern.test(f))
        .map(f => path.join(LOG_DIR, f))
        .sort()  // Lexicographic sort (timestamp format naturally sorted)
        .pop();  // Return newest file
    } catch (err) {
      console.warn(`⚠️  Failed to search log directory: ${err.message}`);
      return undefined;
    }
  }

  /**
   * Load existing log file
   * @param {string} filePath - Path to log file
   */
  loadFile(filePath) {
    this.jsonPath = filePath;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.jsonData = JSON.parse(content);
      console.log(`📝 Log file (resumed): ${filePath} (${this.jsonData.interactions.length} existing)`);
    } catch (err) {
      console.warn(`⚠️  Failed to load log file, creating new: ${err.message}`);
      this.createNewFile();
    }
  }

  /**
   * Create new log file
   */
  createNewFile() {
    const timestamp = this.formatTimestamp(new Date());
    const shortId = this.sessionId === 'unknown' ? 'unknown' : this.sessionId.substring(0, 8);
    const filename = `messages-${timestamp}-${shortId}.json`;
    this.jsonPath = path.join(LOG_DIR, filename);

    this.jsonData = {
      session_id: this.sessionId,
      created_at: new Date().toISOString(),
      interactions: []
    };

    // Initial write (synchronous for simplicity)
    this.saveSync();
    console.log(`📝 Log file (new): ${this.jsonPath}`);
  }

  /**
   * Format timestamp for filename
   * @param {Date} date - Date object
   * @returns {string} Formatted timestamp (YYYYMMDD_HHMMSS)
   */
  formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
  }

  /**
   * Append interaction to log (async with queue)
   * @param {string} type - Type (input/output/stream.final/error)
   * @param {string} uid - Request unique identifier
   * @param {object} data - Data content
   * @param {object} info - Request/response info
   * @returns {Promise} Resolves when write is complete
   */
  appendInteraction(type, uid, data, info) {
    this.lastAccess = Date.now();

    // Add write operation to queue
    this.writeQueue = this.writeQueue.then(async () => {
      this.jsonData.interactions.push({
        uid,
        timestamp: new Date().toISOString(),
        type,
        ...info,
        data
      });

      await this.saveAsync();
    }).catch(err => {
      const shortId = this.sessionId === 'unknown' ? 'unknown' : this.sessionId.substring(0, 8);
      console.error(`❌ Failed to write log for session ${shortId}:`, err);
    });

    return this.writeQueue;
  }

  /**
   * Save JSON data to file (synchronous, for initialization only)
   */
  saveSync() {
    const content = JSON.stringify(this.jsonData, null, 2);
    fs.writeFileSync(this.jsonPath, content, 'utf-8');
  }

  /**
   * Save JSON data to file (asynchronous, for runtime)
   */
  async saveAsync() {
    const content = JSON.stringify(this.jsonData, null, 2);
    await fs.promises.writeFile(this.jsonPath, content, 'utf-8');
  }

  /**
   * Close writer (wait for pending writes)
   * @returns {Promise} Resolves when all pending writes complete
   */
  close() {
    return this.writeQueue;
  }
}

// Export singleton
export default new Logger();
