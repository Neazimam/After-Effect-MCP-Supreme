# After Effect Supreme MCP

An After Effects MCP server with a live dashboard. One daemon serves three things:

- **MCP endpoint** (`http://127.0.0.1:7654/mcp`): any number of AI clients at once
- **After Effects bridge** (`ws://127.0.0.1:7654/ae`): instant request/response, no file polling
- **Dashboard** (`http://127.0.0.1:7654`): connected AIs, live tool-call log, AE status, safety switches

```
AI clients ──MCP/HTTP──► daemon ◄──WebSocket── CEP panel in After Effects ──► ExtendScript (host.jsx)
                           │
                        dashboard (browser)
```

## Quick start

```bash
npm install
npm run build
npm start                 # daemon + dashboard
npm run install-panel     # copies the CEP panel into AE's extensions folder + enables unsigned panels
```

Restart After Effects → **Window → Extensions → After Effect Supreme MCP**. The panel connects on its own (dot turns green).

No AE handy? `npm run mock-ae` fakes one, and `npm run smoke -- cursor` plays an AI client, so you can watch the dashboard fill up.

## Connect an AI

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http after-effects http://127.0.0.1:7654/mcp` |
| Cursor / VS Code | `{ "mcpServers": { "after-effects": { "url": "http://127.0.0.1:7654/mcp" } } }` |
| Stdio-only apps | `{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:7654/mcp"] }` (dashboard will list the client as `mcp-remote`) |

The dashboard names each AI from the `clientInfo` it sends during the MCP handshake.

## Tools

| Tool | What it does |
|---|---|
| `ae_execute_script` | Run arbitrary ExtendScript (the "can do anything" escape hatch). One undo step. |
| `ae_get_project` / `ae_get_comp` | Project items; comp settings + layer summary |
| `ae_inspect` | Walk a layer's property tree with matchNames, values, expressions (lets the AI discover paths) |
| `ae_create_comp`, `ae_add_layer` | Comps; text/solid/shape/null/camera/light/adjustment/footage/precomp layers |
| `ae_set_property`, `ae_set_keyframes`, `ae_set_expression` | Any property by path, keyframes with easing, expressions (returns `expressionError`) |
| `ae_add_effect` | Effect by name/matchName with settings; returns its parameter list |
| `ae_layer_op` | delete / duplicate / rename / parent / reorder / solo / lock / shy / enable |
| `ae_menu_command` | Any menu item by English name or command id |
| `ae_import`, `ae_render` | Import files; queue (and optionally start) a render |
| `ae_status` | Connection + client info |

Conventions: 1-based layer indexes, times in seconds, colors as `"#rrggbb"` or `[r,g,b]` (0-1; values above 1 are read as 0-255), property paths like `Transform/Position` or `ADBE Transform Group/ADBE Position`.

## Safety

- Listens on **loopback only**; rejects foreign `Host` and browser `Origin` headers on HTTP and WebSocket, so a random website can't drive your AE.
- Dashboard switches: **Allow raw scripts** and **Read-only mode** (blocks every mutating tool). Both apply instantly.
- Every call is one undo group (`Ctrl+Z` reverts an AI action).
- Logs persist to `~/.ae-supreme-mcp/logs/*.jsonl`.
- `ae_execute_script` is full code execution inside AE with your file access. Leave it on only for AIs you trust.

## What's tested, what isn't

Tested here with a mock AE: daemon, MCP sessions, multi-client attribution, queueing, errors, safety switches, origin checks, dashboard rendering. The ExtendScript host library was run against a stubbed AE (serializer, undo groups, dispatch).

**Not yet run inside real After Effects**: `host.jsx` command bodies and the CEP panel. Expect small API-edge fixes on first contact. Use the dashboard log (errors show line numbers) and CEP's debugger at `http://localhost:8099`.

Adobe is moving panels from CEP to UXP; as of writing UXP isn't in After Effects. The panel is deliberately tiny so only `ae-panel/` needs replacing later.

## Layout

```
src/daemon.ts   HTTP, MCP sessions, WebSockets, security
src/hub.ts      log store, AI client tracking, AE bridge + command queue
src/tools.ts    MCP tool definitions
public/index.html   dashboard
ae-panel/       CEP panel (main.js) + ExtendScript library (host/host.jsx)
scripts/        install-panel, mock-ae, smoke-test
```
