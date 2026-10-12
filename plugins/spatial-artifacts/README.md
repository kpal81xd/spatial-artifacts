# spatial-artifacts plugin

Reference for the plugin. For what it is and how to install it, see the [main README](../../README.md).

The `SpatialArtifact`, `SpatialArtifactComments`, `SpatialArtifactData` and `SpatialArtifactCheck` tools talk to a
daemon on `127.0.0.1`. Nothing leaves your machine except the CDN scripts and Google Fonts a page loads.

- Gallery: <http://localhost:47328/code/artifacts> (or `/spatial`)
- Artifact: `http://localhost:47328/code/artifact/<uuid>`. Each page runs on its own origin, `<uuid>.localhost`, so
  browser storage is per artifact. Chrome and Firefox resolve `*.localhost`; Safari may not.

## Layout

```
.claude-plugin/, .codex-plugin/   manifests (Codex's MCP server is codex.mcp.json)
.mcp.json                         the "spatial" MCP server
hooks/, monitors/, scripts/       comment delivery: prompt hook, monitor, watch-comments.ts
commands/spatial.md               /spatial
server/                           MCP server (mcp.ts, tools/) and the daemon (daemon.ts, store, db, preview, ...)
web/                              viewer shell, gallery and the in-page runtime (window.claude, comment mode)
skills/                           spatial-design, spatial-diagramming, spatial-capabilities, spatial-3d-design
~/.spatial-artifacts/             all state: artifacts, comments, db, assets, grants, server.json, server.log
```

## Comments

**Send to Claude** (or `@claude` in a comment) hands the thread to Claude, which replies and resolves it with
`SpatialArtifactComments`. The thread shows **Queued**, then **Working on it…**, then the reply.

A comment or reply can carry up to 4 reference images: paste them into its box, drop them on it, or pick them with its
image button. They are scaled to at most 1568 px, and Claude sees them when it reads the thread.

- In Claude Code, the `artifact-comments` monitor wakes an idle session. It starts the first time `spatial-design` or
  `spatial-3d-design` loads. Without it (non-interactive sessions), comments arrive with your next message.
- Comments go to the sessions linked to the artifact: one that published it, read it, or used
  `SpatialArtifactComments` on it. To link another session, paste the artifact URL and ask Claude to read it.
- The circle in the viewer header shows presence: green while a session is watching, amber when one is open but not
  watching, hollow when there's none.

## Settings

Environment variables:

| Variable | Default | Effect |
|---|---|---|
| `SPATIAL_ARTIFACTS_PORT` | `47328` | viewer and API port |
| `SPATIAL_ARTIFACTS_DIR` | `~/.spatial-artifacts` | state directory |
| `SPATIAL_ARTIFACTS_AUTO_OPEN` | on | `0` stops opening artifacts in the browser |
| `SPATIAL_ARTIFACTS_USER` | OS username | your name in comments and the `user` capability |
| `CHROME_PATH` | auto | Chrome binary for `SpatialArtifactCheck` previews |

- Sessions read these when they start. The daemon reads `SPATIAL_ARTIFACTS_USER` when it starts, so restart it
  after changing that.
- The daemon keeps running after the session. Stop it with `kill $(jq .pid ~/.spatial-artifacts/server.json)`.

## Codex

Codex uses the same server and daemon, so both share one set of artifacts.

- Codex asks before each tool call unless you approve the server's tools.
- Codex doesn't tell MCP servers the workspace, so pass absolute file paths.
- Codex has no monitors. On your first message the prompt hook starts a `watch-comments.ts --codex` watcher for that
  session, which hands comments to `codex queue` (experimental) and exits with Codex.

## Privacy

The plugin has no server of its own and collects nothing. It runs a daemon on `127.0.0.1` that only your browser and
your Claude Code session reach.

- **Stored, on your machine only:** published pages and their files, comment threads (with your OS username as the
  author, or `SPATIAL_ARTIFACTS_USER`), images attached to comments, page database rows, uploaded assets and the
  permissions you granted. All of it lives in `~/.spatial-artifacts`; delete that folder to remove it.
- **Sent to Claude:** what you ask Claude to read through the plugin's tools, such as comments you send to Claude and
  page data, as part of your normal Claude Code session.
- **Sent elsewhere:** nothing by the plugin. Pages load scripts from five CDN hosts (cdnjs, jsDelivr, unpkg, Tailwind,
  jQuery) and fonts from Google Fonts, so your browser requests those as it would on any website.
- **Not collected:** no analytics, telemetry, accounts or credentials.

## Security

- Binds `127.0.0.1` only and rejects any `Host` other than `localhost`, `127.0.0.1` or `<uuid>.localhost`.
- The agent API needs the bearer token in `~/.spatial-artifacts/server.json` (mode 0600).
- Comment writes must come from the viewer origin. A page's API is scoped to its own artifact and to the capabilities
  it declares.
- Pages run in a sandboxed iframe under a strict CSP: scripts only from five CDN hosts, styles only from Google Fonts,
  `connect-src 'self'`, no modals or downloads.
- Comment text, database rows and other page data reach the model fenced and marked as data, not instructions.
- Anything a page does as you (comments, project files) is asked in the viewer's own dialog.
  Grants are checked by the daemon on every call. Downloads and sends to Claude are confirmed each time.

## 3D page hooks

Scenes built with `spatial-3d-design` use these viewer hooks; 2D pages don't need them.

- `window.claude.pick(el, fn)` and `window.claude.pickRect(el, fn)` resolve what's under the cursor or inside a dragged
  area in comment mode. Either may return `image`, a data URL capture handed to Claude. Returning `false` marks empty
  space.
- `claude:comment-mode` on `document` and a cancelable `claude:focus` on the element let the page draw its own
  highlight.
- `claude:pin` on the element asks where a comment sits (set `detail.x`/`y` in client px, or `detail.hidden`).
  `claude:layout` on `document` makes pins follow a moving camera. `claude:draft` (`detail.open`) says a comment box is
  open.
- `claude:fullscreen` (`detail.on`) requests full screen; `claude:fullscreen-change` reports it.

`SpatialArtifactCheck` runs headless Chrome with `--enable-unsafe-swiftshader` so WebGL renders in previews.

## Differences from hosted Artifacts

- `SpatialArtifact` adds `open`, `pin`/`unpin`, `delete` and `quickstart`. There are no Artifact types or design
  systems, so `type_url`, `type`, `type_query` and `auto_open` are refused.
- A publish won't replace a file this session hasn't read or listed, unless it's named in `overwrite_unread`.
- `SpatialArtifactData` requires `if_version` to overwrite an existing document (page writes are exempt) and caps a
  batch at 1 MiB.
- Capabilities: `artifact` (alias `self`), `assets`, `comments`, `db`, `downloads`, `files`, `room` and `user`. `room` only connects tabs on this machine.
- `window.claude.hot` carries state across a republish; 3D scenes keep their selection and tool, and show their last
  frame until the new version's models have loaded.
- Not available: sharing, audiences, handlers, live-doc sync and live watches.
