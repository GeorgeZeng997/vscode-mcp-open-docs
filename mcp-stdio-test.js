const { spawn } = require('child_process');
const path = require('path');

const bridgePath = path.join(__dirname, 'mcp-stdio.js');
const child = spawn(process.execPath, [bridgePath], {
  stdio: ['pipe', 'pipe', 'inherit']
});

let buffer = Buffer.alloc(0);

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parseResponses();
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {}
});

send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {}
});

send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'listOpenDocuments', arguments: {} }
});

send({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'readDocument',
    arguments: { path: 'C:\\\\Users\\\\Administrator\\\\Desktop\\\\mcp-test\\\\test-mcp-file.js' }
  }
});

function send(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  child.stdin.write(header + body);
}

function parseResponses() {
  while (true) {
    const headerEnd = findHeaderEnd(buffer);
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const contentLength = parseContentLength(headerText);
    if (contentLength === null) {
      process.stderr.write('Invalid response header\n');
      process.exit(1);
    }

    const bodyStart = headerEnd + (buffer[headerEnd] === 13 ? 4 : 2);
    if (buffer.length < bodyStart + contentLength) return;

    const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
    buffer = buffer.slice(bodyStart + contentLength);
    console.log('<<', body);
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
