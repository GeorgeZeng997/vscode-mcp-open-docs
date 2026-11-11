# vscode-mcp-open-docs

A **Model Context Protocol (MCP)** VS Code extension and `stdio` bridge that lets AI coding agents (Codex, Claude Code, Cursor/MCP hosts) inspect, search, slice, and navigate documents through VS Code's live in-memory editor buffers—including unsaved (`isDirty`) edits—rather than reading stale files directly from disk.

---

## Key Features

- **In-Memory VS Code Buffer Access**: Reads active editor text buffers (including unsaved modifications) and opens documents on demand.
- **Line-Range Slicing (`readDocument`)**: Supports `startLine` / `endLine` parameters as well as `path:start-end` or `path#L10-L30` syntax to fetch targeted code windows without overflowing LLM context.
- **Precision Editor Navigation (`openFile` & `openMultipleFiles`)**: Opens single or batch files in VS Code tabs and centers the cursor/selection on `path:line:col` ranges.
- **Regex & Substring Search (`searchOpenDocuments`)**: Searches across all open VS Code buffers with regex validation and result-count caps.
- **Hardened Local Security**:
  - Loopback-only binding (`127.0.0.1` by default).
  - Cross-Site WebSocket Hijacking (CSWSH) protection rejecting browser `http(s)://` `Origin` headers.
  - Optional workspace-root sandbox (`vscodeMcp.restrictToWorkspace`) and Bearer token authentication (`vscodeMcp.authToken` / `MCP_AUTH_TOKEN`).
- **Dual-Framing `stdio` Bridge (`mcp-stdio.js`)**: Losslessly parses both `Content-Length` LSP/MCP headers and newline-delimited JSON (NDJSON) across arbitrary stream chunk boundaries.

---

## Installation & Quick Start

### Prerequisites

- **VS Code** `>= 1.85.0`
- **Node.js** `>= 18.0.0`

### 1. Install Dependencies

```bash
npm ci
```

### 2. Run the VS Code Extension

1. Open this repository folder in **VS Code**.
2. Press `F5` (**Run Extension**) to launch an **Extension Development Host** window.
3. Verify the status bar item in the bottom-right corner displays:
   `MCP: ws://127.0.0.1:7310`

### 3. Configure Your MCP Client (e.g., Codex `~/.codex/config.toml`)

```toml
[mcp_servers.vscodeOpenDocs]
command = "node"
args = ["/path/to/vscode-mcp-open-docs/mcp-stdio.js"]
startup_timeout_sec = 10

[mcp_servers.vscodeOpenDocs.env]
MCP_WS_URL = "ws://127.0.0.1:7310"
```

---

## Available MCP Tools

| Tool | Description | Key Arguments |
| :--- | :--- | :--- |
| `ping` | Health check returning extension connection state, open buffer count, and workspace roots. | *(none)* |
| `listOpenDocuments` | Lists all documents currently loaded in VS Code (`uri`, `fileName`, `languageId`, `lineCount`, `isDirty`). | *(none)* |
| `readDocument` | Opens (if needed) and reads a document buffer, optionally sliced to a 1-indexed line range. | `path` or `uri`, optional `startLine`, `endLine` |
| `openFile` | Opens a document in VS Code and reveals/selects an optional line/column range. | `path` (supports `file.ts:42:5` or `file.ts#L10-L20`) or `uri`, `line`, `column`, `endLine`, `endColumn` |
| `openMultipleFiles` | Batch-opens multiple files (each supporting `:line[:col]`) in VS Code editor tabs. | `paths` (`string[]`), optional `preserveFocus` |
| `searchOpenDocuments` | Searches across all open VS Code buffers via substring or regular expression. | `query`, optional `isCaseSensitive`, `isRegex`, `maxResults` |

---

## VS Code Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `vscodeMcp.host` | `"127.0.0.1"` | Interface address for the local MCP WebSocket server. |
| `vscodeMcp.port` | `7310` | Port for the local MCP WebSocket server. |
| `vscodeMcp.autoOpenDocument` | `true` | Reveal documents in the VS Code editor when called via `readDocument`. |
| `vscodeMcp.restrictToWorkspace` | `false` | Restrict `readDocument` / `openFile` to active VS Code workspace folders. |
| `vscodeMcp.authToken` | `""` | Optional shared Bearer token required on incoming WebSocket connections (`MCP_AUTH_TOKEN` on the bridge). |

---

## Testing

Run syntax verification and the automated unit & integration test suite:

```bash
npm run check
npm test
```

Manual smoke scripts against a live VS Code Extension Development Host:

```bash
node mcp-stdio-test.js
node mcp-client-test.js
```
