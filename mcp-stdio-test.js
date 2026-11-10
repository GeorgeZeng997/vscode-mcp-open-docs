'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { FrameParser, formatFramedMessage } = require('./lib/mcp-protocol');

const targetFile = process.argv[2] || path.join(__dirname, 'test-mcp-file.js');
const bridgePath = path.join(__dirname, 'mcp-stdio.js');

const child = spawn(process.execPath, [bridgePath], {
  stdio: ['pipe', 'pipe', 'inherit']
});

const parser = new FrameParser();

child.stdout.on('data', (chunk) => {
  for (const body of parser.push(chunk)) {
    console.log('<<', body);
  }
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

function send(msg) {
  child.stdin.write(formatFramedMessage(JSON.stringify(msg), 'header'));
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'ping', arguments: {} }
});
send({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'readDocument', arguments: { path: targetFile } }
});

child.stdin.end();
