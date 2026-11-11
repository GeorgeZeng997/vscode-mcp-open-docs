'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const {
  FrameParser,
  formatFramedMessage,
  parseTargetLocation,
  sliceTextByLines,
  isPathWithinRoots,
  isAllowedWsClient,
  findMatchesInText,
  TOOLS_SCHEMA
} = require('../lib/mcp-protocol');

test('FrameParser handles split Content-Length headers and multi-byte UTF-8 bodies', () => {
  const parser = new FrameParser();
  const payload1 = JSON.stringify({ jsonrpc: '2.0', id: 1, text: 'caf\u00e9 \u2603' });
  const framed1 = formatFramedMessage(payload1, 'header');
  const payload2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
  const framed2 = formatFramedMessage(payload2, 'header');

  const combined = Buffer.from(framed1 + framed2, 'utf8');
  // Feed in awkward chunk boundaries (mid-header, mid-CRLFCRLF, mid-UTF8 char)
  const out = [];
  for (const step of [
    combined.subarray(0, 11),
    combined.subarray(11, 21),
    combined.subarray(21, 35),
    combined.subarray(35)
  ]) {
    out.push(...parser.push(step));
  }

  assert.equal(out.length, 2);
  assert.deepEqual(JSON.parse(out[0]), JSON.parse(payload1));
  assert.deepEqual(JSON.parse(out[1]), JSON.parse(payload2));
  assert.equal(parser.mode, 'header');
});

test('FrameParser handles split NDJSON lines without dropping trailing partial chunks', () => {
  const parser = new FrameParser();
  const chunk1 = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.';
  const chunk2 = '0","id":2,"method":"tools/list"}\n';

  const firstBatch = parser.push(chunk1);
  assert.equal(firstBatch.length, 1);
  assert.equal(JSON.parse(firstBatch[0]).id, 1);

  const secondBatch = parser.push(chunk2);
  assert.equal(secondBatch.length, 1);
  assert.equal(JSON.parse(secondBatch[0]).id, 2);
  assert.equal(parser.mode, 'json');
});

test('parseTargetLocation parses Windows drives, line:col, ranges, and #L anchors', () => {
  assert.deepEqual(parseTargetLocation('C:\\repo\\src\\app.ts:42:9'), {
    filePath: 'C:\\repo\\src\\app.ts',
    startLine: 42,
    startColumn: 9,
    endLine: null,
    endColumn: null
  });

  assert.deepEqual(parseTargetLocation('C:\\repo\\src\\app.ts:10-25'), {
    filePath: 'C:\\repo\\src\\app.ts',
    startLine: 10,
    startColumn: null,
    endLine: 25,
    endColumn: null
  });

  assert.deepEqual(parseTargetLocation('/workspace/main.js#L5-L18'), {
    filePath: '/workspace/main.js',
    startLine: 5,
    startColumn: null,
    endLine: 18,
    endColumn: null
  });

  assert.throws(() => parseTargetLocation('bad\0path.js'), /null byte/i);
});

test('sliceTextByLines and findMatchesInText handle boundaries and invalid regex safely', () => {
  const sample = 'alpha\nbeta\ngamma\ndelta\nepsilon';
  const slice = sliceTextByLines(sample, 2, 4);
  assert.equal(slice.totalLines, 5);
  assert.equal(slice.startLine, 2);
  assert.equal(slice.endLine, 4);
  assert.equal(slice.sliced, true);
  assert.equal(slice.text, 'beta\ngamma\ndelta');

  const matches = findMatchesInText(sample, 'a$', { isRegex: true, maxResults: 2 });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].line, 1);
  assert.equal(matches[1].line, 2);

  assert.throws(
    () => findMatchesInText(sample, '[unclosed', { isRegex: true }),
    /Invalid regular expression/
  );
});

test('isPathWithinRoots and isAllowedWsClient enforce sandbox and CSWSH defenses', () => {
  assert.equal(
    isPathWithinRoots('C:\\Work\\Proj\\src\\a.js', ['C:\\work\\proj'], 'win32'),
    true
  );
  // Sibling prefix bypass check
  assert.equal(
    isPathWithinRoots('C:\\Work\\Proj-evil\\a.js', ['C:\\Work\\Proj'], 'win32'),
    false
  );
  // Parent traversal check
  assert.equal(
    isPathWithinRoots('C:\\Work\\Proj\\..\\secret.txt', ['C:\\Work\\Proj'], 'win32'),
    false
  );

  // Browser Origin rejected (CSWSH defense)
  assert.equal(isAllowedWsClient({ origin: 'https://malicious.example' }), false);
  assert.equal(isAllowedWsClient({ origin: 'http://localhost:3000' }), false);
  // Stdio client (no Origin) allowed
  assert.equal(isAllowedWsClient({ origin: undefined }), true);
  // Token validation
  assert.equal(
    isAllowedWsClient({ headers: { authorization: 'Bearer s3cr3t' }, expectedToken: 's3cr3t' }),
    true
  );
  assert.equal(
    isAllowedWsClient({ headers: { authorization: 'Bearer wrong' }, expectedToken: 's3cr3t' }),
    false
  );
});

test('mcp-stdio.js end-to-end round-trip with mock WebSocket extension server', async () => {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.method === 'tools/call' && msg.params.name === 'readDocument') {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    fileName: msg.params.arguments.path,
                    totalLines: 3,
                    startLine: 1,
                    endLine: 2,
                    sliced: true,
                    text: 'line1\nline2'
                  })
                }
              ]
            }
          })
        );
      }
    });
  });

  try {
    const bridgePath = path.join(__dirname, '..', 'mcp-stdio.js');
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, MCP_WS_URL: `ws://127.0.0.1:${port}` },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const outParser = new FrameParser();
    const responses = [];
    child.stdout.on('data', (chunk) => {
      for (const frame of outParser.push(chunk)) {
        responses.push(JSON.parse(frame));
      }
    });

    const send = (obj) => {
      child.stdin.write(formatFramedMessage(JSON.stringify(obj), 'header'));
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'readDocument', arguments: { path: 'demo.js:1-2' } }
    });
    child.stdin.end();

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Timed out waiting for mcp-stdio.js to finish'));
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0);
    assert.equal(responses.length, 3);
    assert.equal(responses[0].result.serverInfo.name, 'vscode-mcp-open-docs');
    assert.equal(responses[1].result.tools.length, TOOLS_SCHEMA.length);
    const readPayload = JSON.parse(responses[2].result.content[0].text);
    assert.equal(readPayload.text, 'line1\nline2');
  } finally {
    wss.close();
  }
});
