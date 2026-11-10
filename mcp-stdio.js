'use strict';

const fs = require('fs');
const WebSocket = require('ws');
const {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOLS_SCHEMA,
  FrameParser,
  formatFramedMessage
} = require('./lib/mcp-protocol');

const wsUrl = process.env.MCP_WS_URL || 'ws://127.0.0.1:7310';
const authToken = process.env.MCP_AUTH_TOKEN || '';
const connectTimeoutMs = Number.parseInt(process.env.MCP_CONNECT_TIMEOUT_MS || '4000', 10);
const logPath = process.env.MCP_LOG_FILE || '';
const debugEnabled = process.env.MCP_DEBUG === '1' || Boolean(logPath);

function log(line) {
  if (!debugEnabled) {
    return;
  }
  const msg = `${new Date().toISOString()} ${line}\n`;
  if (logPath) {
    try {
      fs.appendFileSync(logPath, msg, 'utf8');
    } catch (_err) {
      // ignore log file write errors
    }
  }
  console.error(line);
}

let ws = null;
let wsOpen = false;
let stdinEnded = false;
const pending = []; // { body, id, timer }
const inFlightIds = new Set();
const parser = new FrameParser();

const keepAliveInterval = setInterval(() => {}, 60000);

function maybeShutdownAfterStdinEnd() {
  if (!stdinEnded) {
    return;
  }
  if (pending.length === 0 && inFlightIds.size === 0) {
    clearInterval(keepAliveInterval);
    if (ws) {
      try {
        ws.close();
      } catch (_err) {
        // ignore
      }
    }
  }
}

function buildWsOptions() {
  const headers = {};
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return { headers, handshakeTimeout: connectTimeoutMs };
}

function dispatchOverOpenWs(body, id) {
  if (id !== null && id !== undefined) {
    inFlightIds.add(id);
  }
  ws.send(body);
}

function failPending(reason) {
  while (pending.length > 0) {
    const item = pending.shift();
    if (item.timer) {
      clearTimeout(item.timer);
    }
    if (item.id !== null && item.id !== undefined) {
      writeMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: item.id,
          error: {
            code: -32001,
            message: reason
          }
        })
      );
    }
  }
  maybeShutdownAfterStdinEnd();
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(wsUrl, buildWsOptions());

  ws.on('open', () => {
    wsOpen = true;
    log(`mcp-stdio: connected to ${wsUrl}`);
    while (pending.length > 0) {
      const item = pending.shift();
      if (item.timer) {
        clearTimeout(item.timer);
      }
      dispatchOverOpenWs(item.body, item.id);
    }
  });

  ws.on('message', (data) => {
    const text = data.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.id !== undefined && parsed.id !== null) {
        inFlightIds.delete(parsed.id);
      }
    } catch (_err) {
      // pass raw payload through
    }
    writeMessage(text);
    maybeShutdownAfterStdinEnd();
  });

  ws.on('close', () => {
    wsOpen = false;
    log('mcp-stdio: websocket closed');
    if (inFlightIds.size > 0) {
      for (const id of Array.from(inFlightIds)) {
        inFlightIds.delete(id);
        writeMessage(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32002,
              message: 'VS Code MCP WebSocket connection closed before replying.'
            }
          })
        );
      }
    }
    maybeShutdownAfterStdinEnd();
  });

  ws.on('error', (err) => {
    wsOpen = false;
    log(`mcp-stdio: ws error: ${err && err.message ? err.message : err}`);
  });
}

connectWs();

process.stdin.on('data', (chunk) => {
  log(`mcp-stdio: stdin ${chunk.length} bytes`);
  let frames;
  try {
    frames = parser.push(chunk);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return;
  }
  for (const body of frames) {
    handleMessage(body);
  }
});

process.stdin.on('end', () => {
  log('mcp-stdio: stdin ended');
  stdinEnded = true;
  maybeShutdownAfterStdinEnd();
});

function writeMessage(jsonText) {
  const mode = parser.mode || 'header';
  const framed = formatFramedMessage(jsonText, mode);
  log(`mcp-stdio: write ${Buffer.byteLength(jsonText, 'utf8')} bytes (${mode})`);
  process.stdout.write(framed);
}

function sendToWs(body, id) {
  if (wsOpen && ws && ws.readyState === WebSocket.OPEN) {
    dispatchOverOpenWs(body, id);
    return;
  }

  const entry = { body, id, timer: null };
  if (id !== null && id !== undefined) {
    entry.timer = setTimeout(() => {
      const idx = pending.indexOf(entry);
      if (idx !== -1) {
        pending.splice(idx, 1);
      }
      writeMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32001,
            message: `Cannot connect to VS Code MCP WebSocket at ${wsUrl}. Ensure the VS Code extension is running.`
          }
        })
      );
      maybeShutdownAfterStdinEnd();
    }, connectTimeoutMs);
  }
  pending.push(entry);
  connectWs();
}

function handleMessage(body) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (_err) {
    sendToWs(body, null);
    return;
  }

  if (!msg || msg.jsonrpc !== '2.0' || !msg.method) {
    sendToWs(body, msg && msg.id !== undefined ? msg.id : null);
    return;
  }

  if (msg.method === 'notifications/initialized') {
    maybeShutdownAfterStdinEnd();
    return;
  }

  if (msg.method === 'initialize') {
    writeMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO
        }
      })
    );
    maybeShutdownAfterStdinEnd();
    return;
  }

  if (msg.method === 'tools/list') {
    writeMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        result: { tools: TOOLS_SCHEMA }
      })
    );
    maybeShutdownAfterStdinEnd();
    return;
  }

  if (
    msg.method === 'tools/call' &&
    msg.params &&
    msg.params.name === 'ping' &&
    (!wsOpen || !ws || ws.readyState !== WebSocket.OPEN)
  ) {
    writeMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: true,
                  connectedToVsCode: false,
                  wsUrl,
                  server: SERVER_INFO,
                  hint: 'Bridge is healthy, waiting for VS Code extension WebSocket listener.'
                },
                null,
                2
              )
            }
          ]
        }
      })
    );
    maybeShutdownAfterStdinEnd();
    return;
  }

  if (msg.method === 'shutdown') {
    failPending('MCP bridge shutting down');
    writeMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: null }));
    if (ws) {
      ws.close();
    }
    maybeShutdownAfterStdinEnd();
    return;
  }

  sendToWs(body, msg.id ?? null);
}
