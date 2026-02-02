const WebSocket = require('ws');

const expectedPath = process.argv[2] || '';
const url = 'ws://localhost:7310';
const maxAttempts = 20;
let attempts = 0;

function connect() {
  attempts += 1;
  console.log(`Connecting to ${url} (attempt ${attempts}/${maxAttempts})...`);
  const ws = new WebSocket(url, { handshakeTimeout: 2000 });
  const pending = new Set([1, 2, 3, 4]);

  ws.on('open', () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'listOpenDocuments', arguments: {} }
      })
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'readDocument', arguments: { path: expectedPath } }
      })
    );
  });

  ws.on('message', (data) => {
    const text = data.toString();
    console.log('<<', text);

    let msg;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      return;
    }

    if (typeof msg.id === 'number') {
      pending.delete(msg.id);
    }

    if (pending.size === 0) {
      ws.close();
    }
  });

  ws.on('error', (err) => {
    if (attempts < maxAttempts) {
      setTimeout(connect, 1000);
      return;
    }
    console.error('ws error', err);
    process.exit(1);
  });

  ws.on('close', () => {
    console.log('Done.');
  });
}

connect();
