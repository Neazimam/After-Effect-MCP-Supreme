# After Effect Supreme MCP

v0.3.9  ·  installer v0.3.9 (banner shows the version - make sure you run the exe from THIS zip, not an older extraction)

An After Effects MCP server with a live dashboard, an HTML→AE motion-graphics converter and a realtime viewport. One daemon serves three things:

- **MCP endpoint** (`http://127.0.0.1:7654/mcp`): any number of AI clients at once
- **After Effects bridge** (`ws://127.0.0.1:7654/ae`): instant request/response, no file polling, token-authenticated
- **Dashboard** (`http://127.0.0.1:7654`): live viewport, connected AIs, tool-call log, safety switches

```
AI clients ──MCP/HTTP──► daemon ◄──WebSocket── CEP panel in After Effects ──► ExtendScript (host.jsx)
                           │
              dashboard (browser) · live viewport + time scrub
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

## One-click install on Windows (Supreme-MCP.exe)

Put `Supreme-MCP.exe` in the project folder (next to `package.json`) and double-click it. Every run does the same predictable 7 steps — no admin rights needed (everything lives in `%APPDATA%` and `HKCU`):

| Step | What happens |
|---|---|
| 1. Clean | stops any running daemon (`POST /api/shutdown` + targeted process kill by command line), deletes **old CEP extension folders of any previous generation** (`com.aesupreme.*`, `com.aemcp.*`, `com.aegod.*`), removes stale autostart entries and writes `stop.flag` - the old install is fully uninstalled before anything new is installed |
| 2. Detect AE | finds every installed After Effects **dynamically**: registry (`HKLM\SOFTWARE\Adobe\After Effects`, WOW6432Node, HKCU) plus a `Program Files` scan, deduped; each install is labelled with its **internal AE version** (2026 → v26.x, 2024 → v24.x, 2021 → v18.x); if nothing is found you can type the path manually |
| 3. Panel | removes the old panel, copies `ae-panel/` → `%APPDATA%\Adobe\CEP\extensions\com.aesupreme.mcp` (one shared panel serves **all** detected AE versions), **adapts the manifest host range** if a pre-2021 AE was detected, enables `PlayerDebugMode` for CSXS 9–14, and warns if After Effects is running (restart AE to load the panel) |
| 4. Node | finds Node ≥ 18 on PATH / known folders; offers a `winget` install if missing |
| 5. Build | runs `npm install` / `npm run build` **only when missing or outdated** (mtime check) - normally instant; the zip ships the **Windows esbuild binary** (`@esbuild/win32-x64`) so a rebuild works on Windows too; a failed build falls back to the prebuilt `build/daemon.js` |
| 6. Autostart | writes the watchdog (`%APPDATA%\AfterEffectsMCP\watchdog.vbs`, restarts the daemon if it dies, stops on `stop.flag`) + `HKCU\...\Run` entry |
| 7. Start | spawns `node build/daemon.js` (logs to `%APPDATA%\AfterEffectsMCP\daemon.log`) and waits for the health check on `127.0.0.1:7654`; reminds you to restart AE if it was running during install |

Flags: `--list` (show detected AE installs) · `--status` · `--uninstall` (full clean) · `--no-start` · `--port N` · `--silent`. Source: `installer/supreme_installer.cpp`.

Rebuild the exe (optional, MinGW): `x86_64-w64-mingw32-g++ -std=c++17 -O2 -static -o Supreme-MCP.exe installer/supreme_installer.cpp -lws2_32 -lole32 -luuid`

## HTML → AE motion graphics

The flagship tool: **`ae_html_to_layers`** turns a self-contained HTML+CSS snippet into *real* After Effects layers — this is the "Claude writes motion graphics" fast path. Write HTML like you would for a browser, call the tool once, get editable layers:

| CSS | After Effects |
|---|---|
| `div` with background | solid / shape layer (borders, radius or gradients → shape) |
| `border-radius: 50%` | ellipse shape layer |
| text elements (`h1`, `p`, `div` with text) | text layers with font/size/color/tracking/leading, justification from `text-align` |
| `@keyframes` transform: translate | Position keyframes |
| `@keyframes` scale / rotate / opacity | Scale / Rotation / Opacity keyframes |
| `background-color` / `color` animation | animated Fill (Fill effect on solids & text) |
| `linear-gradient(...)` / `radial-gradient(...)` | Ramp effect in **layer coordinates** with the correct **Ramp Shape** (linear / radial) and alpha-aware previews |
| `transform-origin` | a real AE anchor-point pivot — scale/rotate keys grow from the CSS-specified edge (e.g. `left center` wipes grow from the left) |
| `box-shadow` / `text-shadow` | Drop Shadow effect (direction/distance/softness from the offset/blur) |
| `animation` timing | `linear` → linear keys, `steps()` → hold keys, ease → bezier with temporal ease |
| `infinite` / iteration count | keys repeated to fill the comp duration (alternating supported) |
| `animation-delay` | keys shifted in time |
| absolute positioning, margins, flexbox (row/column, justify, align, gap, flex:1) | full layout engine, px = comp px, top-left stage → AE center origin |
| `<img src="C:\path.png">` (absolute path) | imported footage layer, scaled to the box (animatable like any layer) |
| `<div data-start="1" data-duration="4">` | layer in/out points — **HyperFrames-compatible** composition attributes |
| element with `opacity:0` + `animation` | kept (static transparent layers are dropped only when never animated) |
| `body { background }` | comp background color |

Everything lands as **one undo step**. The panel has an **HTML → AE** tab too: **import a `.html` file** (native file dialog) or paste, **Plan** to preview the layer list, **Convert** to build. The **dashboard has an HTML → AE card** as well: import/drag & drop a `.html` file, edit it, see a **live browser preview** next to the AE viewport, then **Plan** or **Convert → AE** directly. Both UIs show the daemon version in the interface.

> **HyperFrames interop:** snippets that follow [HeyGen's HyperFrames](https://github.com/heygen-com/hyperframes) composition conventions (`data-start`, `data-duration` in seconds) convert directly — each element becomes a layer trimmed to its slot. JS-driven animation (GSAP timelines) is out of scope for the static converter; stick to `@keyframes`.

**Ready-made examples** in `examples/`: paste `lower-third-neon.html` or `hyperframes-scene.html` into the panel's HTML → AE tab (or feed the file contents to `ae_html_to_layers`). Verify with `node tests/examples.test.mjs`.

**Exact-layer test scene** in `test-scene/`: `ui-animation-test.html` is a 1920×1080 UI animation built entirely from the converter's 1:1 feature set (text, cards, gradients, shadows, staggered keyframes, wipe, line-draw, color-cycle, spin). Import it, Convert → AE, and compare with `preview-t1.5s.png` / `preview-t12.0s-end.png`; `expected-ae-layers.json` is the exact spec the converter emits (21 layers, 53 keyframes). If AE matches the PNGs, your install converts exactly; if not, the diff points at the failing layer.

## Realtime viewport

The dashboard shows a **live viewport** of the active comp drawn from real layer data (positions, sizes, colors, text, rotation, opacity). It refreshes automatically after every AI tool call, every panel conversion, and on a slow poll that catches manual AE edits. There's a **time slider + play button** that scrub the AE playhead so you can watch animations without leaving the browser. The CEP panel has a mini **Preview** tab with the same renderer.

## Connect an AI

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http after-effects http://127.0.0.1:7654/mcp` |
| Cursor / VS Code | `{ "mcpServers": { "after-effects": { "url": "http://127.0.0.1:7654/mcp" } } }` |
| Stdio-only apps | `{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:7654/mcp"] }` (dashboard will list the client as `mcp-remote`) |

The dashboard names each AI from the `clientInfo` it sends during the MCP handshake.

Suggested AI workflow for motion graphics: write the HTML+CSS snippet (1920×1080 stage, absolute positioning, `@keyframes`) → `ae_html_to_layers` → `ae_viewport` to verify → tweak with `ae_set_property` / `ae_set_keyframes` → `ae_render`.

## Tools

| Tool | What it does |
|---|---|
| `ae_html_to_layers` | Convert an HTML+CSS motion graphics snippet into real layers + keyframes + effects (see table above) |
| `ae_viewport` | Structured snapshot of the active comp (what the dashboard viewport draws) |
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
- **Bridge token**: the daemon writes `~/.ae-supreme-mcp/daemon-token`; the panel (and mock-ae) must present it during the WebSocket handshake. A website in a sandboxed iframe (`Origin: null`) can no longer open the AE bridge.
- Dashboard switches: **Allow raw scripts** and **Read-only mode** (blocks every mutating tool, including HTML → AE). Both apply instantly.
- Every call is one undo group (`Ctrl+Z` reverts an AI action).
- Logs persist to `~/.ae-supreme-mcp/logs/*.jsonl`.
- `ae_execute_script` is full code execution inside AE with your file access. Leave it on only for AIs you trust.

## What's tested, what isn't

- `tests/html2ae.test.mjs` — 114 unit tests over the converter (parser, selectors, cascade, layout, keyframes incl. synthesized boundary stops, gradients, shadows, z-order, data-start/data-duration trim, footage keyframes). Run: `node --experimental-strip-types tests/html2ae.test.mjs` (or `node tests/html2ae.test.mjs` on Node ≥ 23).
- Daemon, MCP sessions, multi-client attribution, queueing, errors, safety switches, origin checks, token auth and dashboard rendering are tested against the mock.
- **Not yet run inside real After Effects**: `host.jsx` command bodies (including `buildLayers`/`viewport`) and the CEP panel. Expect small API-edge fixes on first contact. Use the dashboard log (errors show line numbers) and CEP's debugger at `http://localhost:8099`.
- Effect lookup uses English display names (`Ramp`, `Drop Shadow`, `Fill`) with matchName fallbacks — English AE is recommended.

Adobe is moving panels from CEP to UXP; as of writing UXP isn't in After Effects. The panel is deliberately tiny so only `ae-panel/` needs replacing later.

## Layout

```
src/daemon.ts   HTTP, MCP sessions, WebSockets, token auth, viewport push
src/hub.ts      log store, AI client tracking, AE bridge + command queue, panel API
src/tools.ts    MCP tool definitions
src/html2ae.ts  HTML+CSS parser, layout engine, keyframes converter (pure TS, no deps)
public/index.html   dashboard (live viewport, log, safety switches)
ae-panel/       CEP panel: Bridge | HTML → AE | Preview tabs + ExtendScript library (host/host.jsx)
scripts/        install-panel, mock-ae, smoke-test, panel-api-test, visual-driver
tests/          html2ae unit tests + example verification
Supreme-MCP.exe optional Windows auto-installer: clean old install → dynamic AE detect → panel → node/build when needed → watchdog autostart (source: installer/supreme_installer.cpp)
```
