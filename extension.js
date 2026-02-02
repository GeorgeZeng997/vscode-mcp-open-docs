const vscode = require('vscode');
const WebSocket = require('ws');

let server;

function activate(context) {
  const config = vscode.workspace.getConfiguration('vscodeMcp');
  const port = config.get('port', 7310);
  const autoOpen = config.get('autoOpenDocument', true);

  server = new WebSocket.Server({ port });
  server.on('connection', (ws) => {
    ws.on('message', async (data) => {
      const text = data.toString();
      let request;
      try {
        request = JSON.parse(text);
      } catch (err) {
        return;
      }

      if (!request || request.jsonrpc !== '2.0' || !request.method) {
        return;
      }

      const id = request.id ?? null;
      try {
        const result = await handleRequest(request, { autoOpen });
        if (id !== null) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
        }
      } catch (err) {
        if (id !== null) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32000,
                message: err && err.message ? err.message : 'Unknown error'
              }
            })
          );
        }
      }
    });
  });

  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  status.text = `MCP: ws://localhost:${port}`;
  status.tooltip = 'VS Code MCP (Open Docs) running';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push({
    dispose() {
      if (server) {
        server.close();
      }
    }
  });
}

async function handleRequest(request, options) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: 'vscode-mcp-open-docs',
          version: '0.1.0'
        }
      };
    case 'tools/list':
      return {
        tools: [
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
              'Open (if needed) and read a document via VS Code. Provide uri or path.',
            inputSchema: {
              type: 'object',
              properties: {
                uri: { type: 'string' },
                path: { type: 'string' }
              },
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
      };
    case 'tools/call':
      return await handleToolCall(request.params || {}, options);
    case 'shutdown':
      if (server) {
        server.close();
      }
      return null;
    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}

async function handleToolCall(params, options) {
  const name = params.name;
  const args = params.arguments || {};

  switch (name) {
    case 'listOpenDocuments':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(listOpenDocuments(), null, 2)
          }
        ]
      };
    case 'readDocument':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(await readDocument(args, options), null, 2)
          }
        ]
      };
    case 'searchOpenDocuments':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(searchOpenDocuments(args), null, 2)
          }
        ]
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function listOpenDocuments() {
  return vscode.workspace.textDocuments.map((doc) => ({
    uri: doc.uri.toString(),
    fileName: doc.fileName,
    languageId: doc.languageId,
    isDirty: doc.isDirty,
    isUntitled: doc.isUntitled
  }));
}

async function readDocument(args, options) {
  const autoOpen = options && options.autoOpen;
  let uri;
  if (args.uri) {
    uri = vscode.Uri.parse(args.uri);
  } else if (args.path) {
    uri = vscode.Uri.file(args.path);
  } else {
    throw new Error('Provide uri or path.');
  }

  let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc) {
    doc = await vscode.workspace.openTextDocument(uri);
  }

  if (autoOpen) {
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  }

  return {
    uri: doc.uri.toString(),
    fileName: doc.fileName,
    languageId: doc.languageId,
    isDirty: doc.isDirty,
    text: doc.getText()
  };
}

function searchOpenDocuments(args) {
  const query = args.query;
  const isCaseSensitive = !!args.isCaseSensitive;
  const isRegex = !!args.isRegex;

  if (!query) {
    throw new Error('query is required.');
  }

  let matcher;
  if (isRegex) {
    matcher = new RegExp(query, isCaseSensitive ? 'g' : 'gi');
  }

  const results = [];
  for (const doc of vscode.workspace.textDocuments) {
    const matches = findMatches(doc.getText(), query, matcher, isCaseSensitive);
    if (matches.length > 0) {
      results.push({
        uri: doc.uri.toString(),
        fileName: doc.fileName,
        matches
      });
    }
  }

  return results;
}

function findMatches(text, query, matcher, isCaseSensitive) {
  const lines = text.split(/\r?\n/);
  const matches = [];

  if (matcher) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      matcher.lastIndex = 0;
      let match;
      while ((match = matcher.exec(line)) !== null) {
        matches.push({
          line: lineIndex + 1,
          character: match.index + 1,
          lineText: line.trim()
        });
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
        lineText: line.trim()
      });
      startIndex = idx + Math.max(1, needle.length);
    }
  }

  return matches;
}

function deactivate() {
  if (server) {
    server.close();
    server = undefined;
  }
}

module.exports = {
  activate,
  deactivate
};
