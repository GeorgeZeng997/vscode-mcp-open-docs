'use strict';

const vscode = require('vscode');
const WebSocket = require('ws');
const {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOLS_SCHEMA,
  parseTargetLocation,
  sliceTextByLines,
  isPathWithinRoots,
  isAllowedWsClient,
  findMatchesInText
} = require('./lib/mcp-protocol');

let server;

function getExtensionOptions() {
  const config = vscode.workspace.getConfiguration('vscodeMcp');
  return {
    host: config.get('host', '127.0.0.1') || '127.0.0.1',
    port: config.get('port', 7310),
    autoOpen: config.get('autoOpenDocument', true),
    restrictToWorkspace: config.get('restrictToWorkspace', false),
    authToken: config.get('authToken', '') || process.env.MCP_AUTH_TOKEN || ''
  };
}

function getWorkspaceRoots() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.map((f) => f.uri.fsPath).filter(Boolean);
}

function activate(context) {
  const initialOpts = getExtensionOptions();
  const { host, port } = initialOpts;

  server = new WebSocket.Server({
    host,
    port,
    maxPayload: 16 * 1024 * 1024,
    verifyClient: (info, done) => {
      const opts = getExtensionOptions();
      const allowed = isAllowedWsClient({
        origin: info.origin,
        headers: (info.req && info.req.headers) || {},
        expectedToken: opts.authToken
      });
      if (!allowed) {
        done(false, 403, 'Forbidden MCP WebSocket client');
        return;
      }
      done(true);
    }
  });

  server.on('connection', (ws) => {
    ws.on('message', async (data) => {
      const text = data.toString('utf8');
      let request;
      try {
        request = JSON.parse(text);
      } catch (_err) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: invalid JSON' }
          })
        );
        return;
      }

      if (!request || request.jsonrpc !== '2.0' || !request.method) {
        return;
      }

      const id = request.id ?? null;
      try {
        const result = await handleRequest(request, getExtensionOptions());
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

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = `MCP: ws://${host}:${port}`;
  status.tooltip = 'VS Code MCP (Open Docs) server active';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push({
    dispose() {
      if (server) {
        server.close();
        server = undefined;
      }
    }
  });
}

async function handleRequest(request, options) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: SERVER_INFO
      };
    case 'tools/list':
      return {
        tools: TOOLS_SCHEMA
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

function wrapTextResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

async function handleToolCall(params, options) {
  const name = params.name;
  const args = params.arguments || {};

  switch (name) {
    case 'ping':
      return wrapTextResult({
        ok: true,
        connectedToVsCode: true,
        server: SERVER_INFO,
        host: options.host,
        port: options.port,
        restrictToWorkspace: !!options.restrictToWorkspace,
        openDocumentCount: vscode.workspace.textDocuments.length,
        workspaceRoots: getWorkspaceRoots()
      });
    case 'listOpenDocuments':
      return wrapTextResult(listOpenDocuments());
    case 'readDocument':
      return wrapTextResult(await readDocument(args, options));
    case 'openFile':
      return wrapTextResult(await openFile(args, options));
    case 'openMultipleFiles':
      return wrapTextResult(await openMultipleFiles(args, options));
    case 'searchOpenDocuments':
      return wrapTextResult(searchOpenDocuments(args));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function listOpenDocuments() {
  return vscode.workspace.textDocuments.map((doc) => ({
    uri: doc.uri.toString(),
    fileName: doc.fileName,
    languageId: doc.languageId,
    lineCount: doc.lineCount,
    isDirty: doc.isDirty,
    isUntitled: doc.isUntitled
  }));
}

function resolveValidatedTarget(args, options) {
  let uri;
  let parsed = {
    filePath: null,
    startLine: null,
    startColumn: null,
    endLine: null,
    endColumn: null
  };

  if (args.uri) {
    uri = vscode.Uri.parse(args.uri);
    if (!['file', 'untitled'].includes(uri.scheme)) {
      throw new Error(`Unsupported URI scheme "${uri.scheme}". Only file:// and untitled: are allowed.`);
    }
  } else if (args.path) {
    parsed = parseTargetLocation(args.path);
    uri = vscode.Uri.file(parsed.filePath);
  } else {
    throw new Error('Provide uri or path.');
  }

  if (options && options.restrictToWorkspace && uri.scheme === 'file') {
    const roots = getWorkspaceRoots();
    if (!isPathWithinRoots(uri.fsPath, roots)) {
      throw new Error(
        `Access denied: "${uri.fsPath}" is outside open VS Code workspace folders.`
      );
    }
  }

  return { uri, parsed };
}

async function loadDocument(uri) {
  let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc) {
    doc = await vscode.workspace.openTextDocument(uri);
  }
  return doc;
}

async function revealEditorRange(doc, editorOpts, rangeSpec) {
  const editor = await vscode.window.showTextDocument(doc, editorOpts);
  const startLine = rangeSpec.startLine;
  if (startLine != null && Number.isFinite(Number(startLine))) {
    const sLine0 = Math.max(0, Math.min(doc.lineCount - 1, Number(startLine) - 1));
    const sCol0 = Math.max(0, Number(rangeSpec.startColumn || 1) - 1);
    const eLine0 =
      rangeSpec.endLine != null
        ? Math.max(sLine0, Math.min(doc.lineCount - 1, Number(rangeSpec.endLine) - 1))
        : sLine0;
    const eCol0 =
      rangeSpec.endColumn != null ? Math.max(0, Number(rangeSpec.endColumn) - 1) : sCol0;

    const startPos = new vscode.Position(sLine0, sCol0);
    const endPos = new vscode.Position(eLine0, eCol0);
    const range = new vscode.Range(startPos, endPos);
    editor.selection = new vscode.Selection(startPos, endPos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
  return editor;
}

async function readDocument(args, options) {
  const autoOpen = options && options.autoOpen;
  const { uri, parsed } = resolveValidatedTarget(args, options);
  const doc = await loadDocument(uri);

  const reqStartLine = args.startLine != null ? args.startLine : parsed.startLine;
  const reqEndLine =
    args.endLine != null
      ? args.endLine
      : parsed.endLine != null
        ? parsed.endLine
        : parsed.startLine != null && args.startLine == null
          ? null
          : null;

  if (autoOpen) {
    await revealEditorRange(
      doc,
      { preview: false, preserveFocus: true },
      {
        startLine: reqStartLine,
        startColumn: parsed.startColumn,
        endLine: reqEndLine,
        endColumn: parsed.endColumn
      }
    );
  }

  const slice = sliceTextByLines(doc.getText(), reqStartLine, reqEndLine);
  return {
    uri: doc.uri.toString(),
    fileName: doc.fileName,
    languageId: doc.languageId,
    isDirty: doc.isDirty,
    totalLines: slice.totalLines,
    startLine: slice.startLine,
    endLine: slice.endLine,
    sliced: slice.sliced,
    text: slice.text
  };
}

async function openFile(args, options) {
  const { uri, parsed } = resolveValidatedTarget(args, options);
  const doc = await loadDocument(uri);

  const startLine = args.line != null ? args.line : parsed.startLine;
  const startColumn = args.column != null ? args.column : parsed.startColumn;
  const endLine = args.endLine != null ? args.endLine : parsed.endLine;
  const endColumn = args.endColumn != null ? args.endColumn : parsed.endColumn;

  await revealEditorRange(
    doc,
    {
      preview: args.preview === true,
      preserveFocus: args.preserveFocus === true
    },
    { startLine, startColumn, endLine, endColumn }
  );

  return {
    opened: true,
    uri: doc.uri.toString(),
    fileName: doc.fileName,
    languageId: doc.languageId,
    lineCount: doc.lineCount,
    navigatedTo:
      startLine != null
        ? {
            line: Number(startLine),
            column: Number(startColumn || 1),
            endLine: endLine != null ? Number(endLine) : Number(startLine),
            endColumn: endColumn != null ? Number(endColumn) : Number(startColumn || 1)
          }
        : null
  };
}

async function openMultipleFiles(args, options) {
  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths.');
  }
  const preserveFocus = args.preserveFocus !== false;
  const results = [];
  for (const target of args.paths) {
    try {
      const res = await openFile({ path: target, preserveFocus, preview: false }, options);
      results.push({ target, ok: true, ...res });
    } catch (err) {
      results.push({
        target,
        ok: false,
        error: err && err.message ? err.message : String(err)
      });
    }
  }
  return {
    totalRequested: args.paths.length,
    openedCount: results.filter((r) => r.ok).length,
    results
  };
}

function searchOpenDocuments(args) {
  const query = args.query;
  const isCaseSensitive = !!args.isCaseSensitive;
  const isRegex = !!args.isRegex;
  const maxResults = args.maxResults != null ? Number(args.maxResults) : 200;

  if (!query) {
    throw new Error('query is required.');
  }

  const results = [];
  let totalMatches = 0;
  for (const doc of vscode.workspace.textDocuments) {
    const remaining = Math.max(1, maxResults - totalMatches);
    const matches = findMatchesInText(doc.getText(), query, {
      isCaseSensitive,
      isRegex,
      maxResults: remaining
    });
    if (matches.length > 0) {
      results.push({
        uri: doc.uri.toString(),
        fileName: doc.fileName,
        matches
      });
      totalMatches += matches.length;
      if (totalMatches >= maxResults) {
        break;
      }
    }
  }

  return results;
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
