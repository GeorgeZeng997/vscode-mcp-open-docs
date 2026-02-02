const WebSocket = require('ws');

const fs = require('fs');
const path = require('path');

const wsUrl = process.env.MCP_WS_URL || 'ws://localhost:7310';
const logPath = path.join(__dirname, 'mcp-stdio.log');

function log(line) {
  const msg = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.appendFileSync(logPath, msg, 'utf8');
  } catch (err) {
    // ignore
  }
  console.error(line);
}
let ws;
let wsOpen = false;
const pending = [];

function connectWs() {
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    wsOpen = true;
    for (const msg of pending.splice(0)) {
      ws.send(msg);
    }
  });

  ws.on('message', (data) => {
    const text = data.toString();
    writeMessage(text);
  });

  ws.on('error', (err) => {
    console.error(`ws error: ${err.message || err}`);
  });
}

connectWs();

let buffer = Buffer.alloc(0);
log('mcp-stdio: started');
log(`mcp-stdio: ws url ${wsUrl}`);
let responseMode = null; // 'header' or 'json'
// Keep process alive even if stdin is closed and ws is idle.
setInterval(() => {}, 1000);
process.stdin.on('data', (chunk) => {
  log(`mcp-stdio: stdin ${chunk.length} bytes`);
  buffer = Buffer.concat([buffer, chunk]);
  parseMessages();
});

process.stdin.on('end', () => {
  log('mcp-stdio: stdin ended');
  // Keep process alive; Codex may close stdin but still expect responses.
});

process.on('exit', (code) => {
  log(`mcp-stdio: exit ${code}`);
});

function parseMessages() {
  while (true) {
    // Log raw buffer when any data arrives to aid debugging.
    if (buffer.length > 0) {
      log(`mcp-stdio: buffer ${buffer.length} bytes: ${previewBuffer(buffer)}`);
    }
    const headerEnd = findHeaderEnd(buffer);
    if (headerEnd === -1) {
      if (!tryParseJsonLines()) {
        if (buffer.length > 0) {
          log(`mcp-stdio: unparsed ${buffer.length} bytes: ${previewBuffer(buffer)}`);
        }
        return;
      }
      continue;
    }

    responseMode = responseMode || 'header';
    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    log(`mcp-stdio: header ${headerText.replace(/\r?\n/g, '\\n')}`);
    const contentLength = parseContentLength(headerText);
    if (contentLength === null) {
      process.stderr.write('Invalid MCP header: missing Content-Length\n');
      process.exit(1);
    }

    const bodyStart = headerEnd + (buffer[headerEnd] === 13 ? 4 : 2);
    if (buffer.length < bodyStart + contentLength) {
      const need = bodyStart + contentLength - buffer.length;
      log(`mcp-stdio: waiting for ${need} more bytes`);
      return;
    }

    const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
    buffer = buffer.slice(bodyStart + contentLength);
    log(`mcp-stdio: body ${previewBuffer(Buffer.from(body, 'utf8'))}`);
    handleMessage(body);
  }
}

function findHeaderEnd(buf) {
  const crlf = buf.indexOf('\r\n\r\n');
  if (crlf !== -1) return crlf;
  const lf = buf.indexOf('\n\n');
  return lf;
}

function parseContentLength(headerText) {
  const lines = headerText.split(/\r?\n/);
  for (const line of lines) {
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function sendToWs(body) {
  if (wsOpen) {
    ws.send(body);
  } else {
    pending.push(body);
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWs();
    }
  }
}

function writeMessage(jsonText) {
  const len = Buffer.byteLength(jsonText, 'utf8');
  log(`mcp-stdio: write ${len} bytes`);
  if (responseMode === 'json') {
    process.stdout.write(`${jsonText}\n`);
  } else {
    process.stdout.write(`Content-Length: ${len}\r\n\r\n${jsonText}`);
  }
}

function tryParseJsonLines() {
  const text = buffer.toString('utf8').trim();
  if (!text) {
    return false;
  }

  // If it looks like newline-delimited JSON, process line by line.
  if (text.includes('\n') || text.includes('\r')) {
    const lines = text.split(/\r?\n/);
    responseMode = responseMode || 'json';
    buffer = Buffer.alloc(0);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        handleMessage(trimmed);
      }
    }
    return true;
  }

  // If it looks like a single JSON object without headers, accept it.
  if (text.startsWith('{') && text.endsWith('}')) {
    responseMode = responseMode || 'json';
    buffer = Buffer.alloc(0);
    handleMessage(text);
    return true;
  }

  return false;
}

function previewBuffer(buf) {
  const slice = buf.slice(0, 200).toString('utf8');
  return slice.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function handleMessage(body) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (err) {
    sendToWs(body);
    return;
  }

  if (!msg || msg.jsonrpc !== '2.0' || !msg.method) {
    sendToWs(body);
    return;
  }

  if (msg.method === 'notifications/initialized') {
    return;
  }

  if (msg.method === 'initialize') {
    const response = {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vscode-mcp-open-docs', version: '0.1.0' }
      }
    };
    writeMessage(JSON.stringify(response));
    return;
  }

  if (msg.method === 'tools/list') {
    const response = {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: {
        tools: [
          {
            name: 'listOpenDocuments',
            description: 'List documents currently open in VS Code.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'readDocument',
            description: 'Open (if needed) and read a document via VS Code. Provide uri or path.',
            inputSchema: {
              type: 'object',
              properties: { uri: { type: 'string' }, path: { type: 'string' } },
              anyOf: [{ required: ['uri'] }, { required: ['path'] }]
            }
          },
          {
            name: 'searchOpenDocuments',
            description: 'Search in currently open documents.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                isCaseSensitive: { type: 'boolean' },
                isRegex: { type: 'boolean' }
              },
              required: ['query']
            }
          }
        ]
      }
    };
    writeMessage(JSON.stringify(response));
    return;
  }

  sendToWs(body);
}
