'use strict';

const path = require('path');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'vscode-mcp-open-docs',
  version: '0.2.0'
};

const TOOLS_SCHEMA = [
  {
    name: 'ping',
    description: 'Check MCP server connectivity, health, open document count, and workspace roots.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'listOpenDocuments',
    description: 'List documents currently open in VS Code.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'readDocument',
    description:
      'Open (if needed) and read a document via VS Code in-memory buffer. Supports optional 1-indexed startLine/endLine slicing or path:line-endLine syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'VS Code document URI (e.g. file:///...)' },
        path: { type: 'string', description: 'File path, optionally suffixed with :line[:col] or #Lstart-Lend' },
        startLine: { type: 'integer', minimum: 1, description: 'Optional 1-indexed start line (inclusive)' },
        endLine: { type: 'integer', minimum: 1, description: 'Optional 1-indexed end line (inclusive)' }
      },
      anyOf: [{ required: ['uri'] }, { required: ['path'] }]
    }
  },
  {
    name: 'openFile',
    description:
      'Open and focus a document in VS Code editor, optionally navigating to a 1-indexed line/column range or path:line:col target.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        path: { type: 'string', description: 'File path, optionally suffixed with :line[:col] or #Lstart-Lend' },
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        endColumn: { type: 'integer', minimum: 1 },
        preserveFocus: { type: 'boolean', default: false },
        preview: { type: 'boolean', default: false }
      },
      anyOf: [{ required: ['uri'] }, { required: ['path'] }]
    }
  },
  {
    name: 'openMultipleFiles',
    description: 'Open multiple files (each optionally with :line[:col] navigation) in VS Code tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'List of file paths (optionally with :line[:col] or #Lstart-Lend suffixes)'
        },
        preserveFocus: { type: 'boolean', default: true }
      },
      required: ['paths']
    }
  },
  {
    name: 'searchOpenDocuments',
    description: 'Search text or regular expressions across currently open VS Code documents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        isCaseSensitive: { type: 'boolean', default: false },
        isRegex: { type: 'boolean', default: false },
        maxResults: { type: 'integer', minimum: 1, maximum: 5000, default: 200 }
      },
      required: ['query']
    }
  }
];

function findHeaderEnd(buf) {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, sepLength: 4 };
  }
  if (lf !== -1) {
    return { index: lf, sepLength: 2 };
  }
  return null;
}

function parseContentLength(headerText) {
  const lines = headerText.split(/\r?\n/);
  for (const line of lines) {
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function formatFramedMessage(jsonText, mode = 'header') {
  if (mode === 'json') {
    return `${jsonText}\n`;
  }
  const len = Buffer.byteLength(jsonText, 'utf8');
  return `Content-Length: ${len}\r\n\r\n${jsonText}`;
}

class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.mode = null; // 'header' | 'json'
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (incoming.length === 0) {
      return [];
    }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    const messages = [];

    while (this.buffer.length > 0) {
      // Strip leading CR/LF whitespace between frames
      let firstNonWs = 0;
      while (
        firstNonWs < this.buffer.length &&
        (this.buffer[firstNonWs] === 13 ||
          this.buffer[firstNonWs] === 10 ||
          this.buffer[firstNonWs] === 32 ||
          this.buffer[firstNonWs] === 9)
      ) {
        firstNonWs += 1;
      }
      if (firstNonWs > 0) {
        this.buffer = this.buffer.slice(firstNonWs);
      }
      if (this.buffer.length === 0) {
        break;
      }

      const firstByte = this.buffer[0];
      // JSON / NDJSON frame starts with '{' (123) or '[' (91)
      if (firstByte === 123 || firstByte === 91) {
        const nlIdx = this.buffer.indexOf(10); // '\n'
        if (nlIdx !== -1) {
          const line = this.buffer.slice(0, nlIdx).toString('utf8').trim();
          this.buffer = this.buffer.slice(nlIdx + 1);
          if (line) {
            this.mode = this.mode || 'json';
            messages.push(line);
          }
          continue;
        }

        // No trailing newline yet: check if buffer is already a complete valid JSON payload
        const candidate = this.buffer.toString('utf8').trim();
        try {
          JSON.parse(candidate);
          this.buffer = Buffer.alloc(0);
          this.mode = this.mode || 'json';
          messages.push(candidate);
          continue;
        } catch (_err) {
          // Incomplete JSON chunk; wait for remaining bytes
          break;
        }
      }

      // Otherwise expect LSP/MCP Content-Length header framing
      const headerSep = findHeaderEnd(this.buffer);
      if (!headerSep) {
        // Wait for complete header (\r\n\r\n or \n\n)
        break;
      }

      const headerText = this.buffer.slice(0, headerSep.index).toString('utf8');
      const contentLength = parseContentLength(headerText);
      if (contentLength === null) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`Invalid MCP header: missing Content-Length in "${headerText}"`);
      }

      const bodyStart = headerSep.index + headerSep.sepLength;
      if (this.buffer.length < bodyStart + contentLength) {
        // Wait for full UTF-8 byte payload
        break;
      }

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + contentLength);
      this.mode = this.mode || 'header';
      messages.push(body);
    }

    return messages;
  }
}

/**
 * Parse file location strings like:
 * - "C:\\dir\\file.js:42:10"
 * - "C:\\dir\\file.js:10-25"
 * - "/workspace/app.ts#L12-L30"
 */
function parseTargetLocation(rawInput) {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    throw new Error('Target path must be a non-empty string.');
  }
  if (rawInput.includes('\0')) {
    throw new Error('Target path contains invalid null byte.');
  }

  let input = rawInput.trim();
  let startLine = null;
  let startColumn = null;
  let endLine = null;
  let endColumn = null;

  // Match #L10 or #L10-L25 anchor first
  const hashMatch = /^(.*)#L(\d+)(?:-L?(\d+))?$/i.exec(input);
  if (hashMatch && hashMatch[1]) {
    return {
      filePath: hashMatch[1],
      startLine: Number.parseInt(hashMatch[2], 10),
      startColumn: null,
      endLine: hashMatch[3] ? Number.parseInt(hashMatch[3], 10) : null,
      endColumn: null
    };
  }

  // Match trailing :startLine-endLine or :line[:col], preserving Windows drive prefix (e.g. C:\...)
  const hasDrivePrefix = /^[A-Za-z]:[\\/]/.test(input);
  const prefix = hasDrivePrefix ? input.slice(0, 2) : '';
  const rest = hasDrivePrefix ? input.slice(2) : input;

  const rangeSuffix = /^(.*):(\d+)-(\d+)$/.exec(rest);
  if (rangeSuffix && rangeSuffix[1]) {
    return {
      filePath: prefix + rangeSuffix[1],
      startLine: Number.parseInt(rangeSuffix[2], 10),
      startColumn: null,
      endLine: Number.parseInt(rangeSuffix[3], 10),
      endColumn: null
    };
  }

  const lineColSuffix = /^(.*?):(\d+)(?::(\d+))?$/.exec(rest);
  if (lineColSuffix && lineColSuffix[1]) {
    startLine = Number.parseInt(lineColSuffix[2], 10);
    startColumn = lineColSuffix[3] ? Number.parseInt(lineColSuffix[3], 10) : null;
    input = prefix + lineColSuffix[1];
  }

  return {
    filePath: input,
    startLine,
    startColumn,
    endLine,
    endColumn
  };
}

function sliceTextByLines(text, startLine, endLine) {
  const lines = String(text).split(/\r?\n/);
  const totalLines = lines.length;
  if (startLine == null && endLine == null) {
    return {
      text: String(text),
      totalLines,
      startLine: 1,
      endLine: totalLines,
      sliced: false
    };
  }

  const s = Math.max(1, Math.min(totalLines, Number(startLine || 1)));
  const e = Math.max(s, Math.min(totalLines, Number(endLine || totalLines)));
  return {
    text: lines.slice(s - 1, e).join('\n'),
    totalLines,
    startLine: s,
    endLine: e,
    sliced: true
  };
}

function isPathWithinRoots(targetPath, workspaceRoots, platform = process.platform) {
  if (!targetPath || targetPath.includes('\0')) {
    return false;
  }
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) {
    return false;
  }

  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const normTarget =
    platform === 'win32'
      ? pathMod.resolve(targetPath).toLowerCase()
      : pathMod.resolve(targetPath);

  for (const root of workspaceRoots) {
    if (!root) continue;
    const normRoot =
      platform === 'win32'
        ? pathMod.resolve(root).toLowerCase()
        : pathMod.resolve(root);
    const rel = pathMod.relative(normRoot, normTarget);
    if (rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

function isAllowedWsClient({ origin, headers = {}, expectedToken = '' } = {}) {
  // Block Cross-Site WebSocket Hijacking (CSWSH) from web browsers
  if (origin && /^https?:\/\//i.test(origin)) {
    return false;
  }
  if (expectedToken) {
    const authHeader = headers.authorization || headers.Authorization || '';
    const tokenHeader = headers['x-mcp-token'] || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (bearer !== expectedToken && tokenHeader !== expectedToken) {
      return false;
    }
  }
  return true;
}

function findMatchesInText(text, query, { isCaseSensitive = false, isRegex = false, maxResults = 200 } = {}) {
  if (!query) {
    throw new Error('query is required.');
  }
  const limit = Math.max(1, Math.min(5000, Number(maxResults) || 200));
  const lines = String(text).split(/\r?\n/);
  const matches = [];

  if (isRegex) {
    let matcher;
    try {
      matcher = new RegExp(query, isCaseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new Error(`Invalid regular expression "${query}": ${err.message}`);
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      matcher.lastIndex = 0;
      let match;
      while ((match = matcher.exec(line)) !== null) {
        matches.push({
          line: lineIndex + 1,
          character: match.index + 1,
          matchText: match[0],
          lineText: line.trim()
        });
        if (matches.length >= limit) {
          return matches;
        }
        if (match.index === matcher.lastIndex) {
          matcher.lastIndex += 1;
        }
      }
    }
    return matches;
  }

  const needle = isCaseSensitive ? query : query.toLowerCase();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const haystack = isCaseSensitive ? line : line.toLowerCase();
    let startIndex = 0;
    while (true) {
      const idx = haystack.indexOf(needle, startIndex);
      if (idx === -1) {
        break;
      }
      matches.push({
        line: lineIndex + 1,
        character: idx + 1,
        matchText: line.slice(idx, idx + needle.length),
        lineText: line.trim()
      });
      if (matches.length >= limit) {
        return matches;
      }
      startIndex = idx + Math.max(1, needle.length);
    }
  }

  return matches;
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOLS_SCHEMA,
  FrameParser,
  findHeaderEnd,
  parseContentLength,
  formatFramedMessage,
  parseTargetLocation,
  sliceTextByLines,
  isPathWithinRoots,
  isAllowedWsClient,
  findMatchesInText
};
