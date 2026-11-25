# DabbleCAD Plus — notes for Claude

A fork of DabbleCAD (jonsole/DabbleCAD): a simple 3D CAD app with a built-in CuraEngine slicer.
It runs on the web (GitHub Pages) and as an Electron desktop app.

## Working rules
- Work on a feature branch and open a PR to `main`. Don't push to `main` directly.
  Other sessions also work on this repo, so fetch and rebase before you push.
- Pushing a branch publishes a preview build at jonsole/DabbleCAD-preview.
- **After every push or merge, state the short commit hash.** The owner checks it against the
  build number shown on the web page to confirm the change is deployed.
- Ask before implementing anything that is only an issue for now.

## Layout
- `electron/`: the main process. `main.js` holds the window, settings, IPC and printer link.
  Also here: `googleauth.js` (Drive sign-in for desktop, loopback OAuth with PKCE) and
  `mcpserver.js` (the MCP server; run with Node on its own, it is the web helper `dabblecad-mcp.cjs`).
- `src/renderer/`: the app.
  - `editor.js`, `parttool.js`, `core/`: design editing. Face/edge/corner modes are shape edits.
  - `slicer/`: the slicer workspace (settings store, profiles, plate, `orient.js` for auto-orient,
    printer link, CuraEngine loader).
  - `ai/`: the in-app AI chat.
  - `ui/`: dialogs, settings, inspector.
  - `mcp/`: MCP tools. This folder exists only on the `feature/mcp-server` branch (PR #26).
- `tools/`: test runners and fakes (`fakegoogle.js`, a fake AI server, smoke suites).

## Building and testing
- `npm ci`, then `npm run build`. Use `npm run dev` for Vite on port 5183.
- To run the full suite: `npm run test:all` (`tools/test.js`).
- In a headless Linux container, run one suite at a time:
  `xvfb-run -a node tools/run.js --no-sandbox --software --smoke=tools/smoke3.js`.
  The suites are smoke3, smoke-laser, smoke-depth, smoke6, smoke-save, smoke-drive and smoke-ai.
  - smoke-drive needs `--fake-google=<url>` from `tools/fakegoogle.js`.
  - smoke-ai needs `--fake-ai=<url>`.
- Slicer tests need CuraEngine. It is fetched from https://jonsole.github.io/DabbleCAD-curaengine/,
  or you can serve a local clone on 127.0.0.1 with CORS and set `slicerEngine` in settings.

## Open work
- **PR #26, MCP server (issue #8):** not merged yet. `main` has gained the AI chat since
  (#31, #32), so the branch needs rebasing and re-testing. It adds 40 tools (design, slicer,
  printer), desktop and web routes, Settings → AI connection, and `tools/test-mcp.js`.
  It was tested end to end with the official MCP SDK client and a fake Moonraker.
- **Issue #4:** Drive as personal storage.
- **Issue #2:** rounding and chamfering individual edges.
