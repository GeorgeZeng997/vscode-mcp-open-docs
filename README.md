# vscode-mcp-open-docs

MCP server that reads file contents via VS Code opened documents. The MCP process **does not read files directly**; it asks VS Code to open documents and reads from the VS Code in-memory model.

## What this does

- Starts a VS Code extension that exposes a local WebSocket MCP server.
- Provides a stdio bridge for MCP clients (e.g., Codex) to talk to the extension.
- Reads file contents by opening documents in VS Code.

## Prerequisites

- VS Code installed
- Node.js installed

## Run the VS Code extension

1. Open this folder in **VS Code**.
2. Press `F5` (Run Extension). A new **Extension Development Host** window opens.
3. In that window, ensure the status bar shows:
   `MCP: ws://localhost:7310`

## MCP stdio bridge (for Codex)

Run the bridge:

```
node C:\Users\Administrator\Desktop\mcp-test\mcp-stdio.js
```

### Codex config example

Add to `~/.codex/config.toml`:

```
[mcp_servers.vscodeOpenDocs]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ['C:\\Users\\Administrator\\Desktop\\mcp-test\\mcp-stdio.js']
startup_timeout_sec = 10
cwd = "C:\\Users\\Administrator\\Desktop\\mcp-test"

[mcp_servers.vscodeOpenDocs.env]
MCP_WS_URL = "ws://localhost:7310"
```

## Tools

- `listOpenDocuments`: list VS Code open documents
- `readDocument`: open (if needed) and read a document by path or URI
- `searchOpenDocuments`: search in currently open documents

## Testing

### stdio test

```
node C:\Users\Administrator\Desktop\mcp-test\mcp-stdio-test.js
```

### Open a test file in VS Code

```
C:\Users\Administrator\Desktop\mcp-test\open-test-file.bat
```

## Notes

- `readDocument` will open files in VS Code before returning content.
- If 7310 is not listening, ensure the extension is running.