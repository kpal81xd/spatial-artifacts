---
name: spatial-capabilities
description: Runtime capabilities for Artifact pages - a shared document database, the current viewer, an asset store, self-republishing, offering files to save, writing comments, reading project files, calling local MCP servers, a live room of open views, and asking Claude - with the window.claude call contract. Load before passing `capabilities` to the SpatialArtifact tool or writing any `window.claude.*` code.
---

# Artifact runtime capabilities

Pages you publish can ask for **runtime capabilities**, extra abilities the local viewer hands the page when it opens, through the SpatialArtifact tool's `capabilities: {name: config}` field. How that field is read: **leaving it out** of a redeploy keeps the stored declaration as is (the contract pin saved with the artifact stays too); `{}`, an **empty object**, deliberately clears every capability; a **non-empty object** declares the whole set, revoking any stored capability it does not repeat. Change the runtime version of a republished artifact only on purpose — `contract: 'latest'` upgrades, a specific version pins or rolls back — never as a by-product of an edit.

**Self-republishing pages.** A page that publishes itself via the `artifact` capability must send the full document in the very form a SpatialArtifact-tool publish produces, so the tool's next publish can detect the skeleton and swap it out rather than nest it: `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>`, the small reset from the tool's description, `</style></head><body>` — tags run together with no whitespace, nothing more in the head — and next the page content just as authored for the tool (inside the body, led by its `<title>` and `<style>`, rebuilt from current state), then `</body></html>`. Assemble the string from the template the page itself holds plus its current state, never from `document.documentElement.outerHTML`, because the live DOM includes injected scripts and the viewer runtime.

**Available capabilities:** `artifact`, `assets`, `comments`, `db`, `downloads`, `files`, `mcp`, `room`, `self`, `user` — no other names can be declared. Most take an empty config object (`downloads` also takes `true`); `comments`, `files`, `mcp` and `room` take the configs below. Declare only what the page uses. `permissions` comes built into every page and is used with no declaration (never include it in `capabilities`). `self` is the former name of `artifact`; new pages declare `artifact`.

**Consent.** `comments` (full form), `files` and each `mcp` server act as the viewer, so the viewer is asked in the viewer — never in the page — at the first call, or once for several with `permissions.request([...])`. Their answer is kept per artifact and can be changed from the shield in the viewer's header (`permissions.manage()` opens it); the server checks it on every call, so a page cannot skip it. A "no" lasts the page load. A page opened on its own tab, outside the viewer, has no one to ask: it gets only what was allowed before.

| name | what the page gets |
|---|---|
| `db` | a document database shared by every open view of this artifact, durable across reloads and republishes; Claude reads and writes it with the `SpatialArtifactData` tool |
| `user` | who is viewing (`{id, name}`), and `data/users/me` resolving to that person |
| `assets` | an asset store for files people add through the page (and files Claude uploads with `asset: true`) |
| `artifact` | the page can publish a new version of itself |
| `downloads` | the page offers a file it generated; the viewer confirms each save |
| `comments` | open the viewer's comment box on an element or text range (`{composer_only: true}`), or also write, resolve and delete threads as the viewer (`{}`, asks consent); `"customAnchors": true` lets a page place pins itself (canvas, WebGL) |
| `files` | read the project folder as the viewer (asks consent): `{files: {}}` is the publishing session's working directory, `{files: {project: "/abs/path"}}` names one. Never `.git`, never through a symlink out |
| `mcp` | call the viewer's own MCP servers, as Claude Code configures them for the project (asks consent per server): `{mcp: {servers: [{server: "host:<name>", tools: ["…"]}]}}`. Tools not marked read-only are confirmed in the viewer on every call. claude.ai connectors are not reachable locally and are refused at publish |
| `room` | everyone with the artifact open right now (one peer per tab): moments on topics, presence objects, named rooms, and `sendToClaudeSession` to hand the linked Claude session data from the viewer's click, confirmed in the viewer |
| `permissions` | built in: read (`state`), ask for (`request`, one batched dialog) or let the viewer change (`manage`) this page's capability states |

**Call contract** (runtime contract 1.0.0; `comments`, `files`, `mcp` and `room` follow the claude.ai type definitions, summarized after this block). `window.claude.use(name)` returns a Promise of the capability's handle, or of `null` when the published version does not declare that name (or in `SpatialArtifactCheck` preview, where no runtime exists). Always handle `null` — render a static fallback — and never assume a handle exists.

```ts
interface Claude {
    use(name: 'db'): Promise<Db | null>;
    use(name: 'user'): Promise<User | null>;
    use(name: 'assets'): Promise<Assets | null>;
    use(name: 'artifact' | 'self'): Promise<ArtifactSelf | null>;
    use(name: 'downloads'): Promise<Downloads | null>;
    use(name: 'permissions'): Promise<Permissions>;   // built in, never null
    hot: Hot;
}

// db — paths alternate collection/document: "tasks/t1", "boards/b1/columns/c2".
// "data/users/me/…" is the current viewer's own subtree (declare `user` too).
interface Db {
    doc(path: string): DocRef;                       // path = "<collection>/<id>"
    collection(path: string): Query;                 // odd number of segments
    batch(writes: { op: 'set' | 'update' | 'delete'; path: string; data?: object }[]): Promise<void>; // ≤ 50, all-or-nothing
}
interface DocRef {
    get(): Promise<Snapshot>;
    set(data: object): Promise<void>;                // replace
    update(data: object): Promise<void>;             // deep-merge; a field set to {"__delete__": true} is removed
    delete(): Promise<void>;
    onSnapshot(cb: (s: Snapshot) => void): () => void; // called now and on every change; returns unsubscribe
}
interface Query {
    doc(id: string): DocRef;
    where(field: string, op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains', value: unknown): Query;
    orderBy(field: string, direction?: 'asc' | 'desc'): Query;
    limit(n: number): Query;                         // ≤ 1000
    get(): Promise<{ docs: Snapshot[] }>;
    onSnapshot(cb: (r: { docs: Snapshot[] }) => void): () => void;
}
interface Snapshot { id: string; exists: boolean; version?: number; data(): any }

interface User {
    me(): Promise<{ id: string; name: string }>;     // id is "u_" + 22 chars
    id(): Promise<string>;
    isOwner(): boolean; canEdit(): boolean; can(name: string): boolean; // the one local person owns the artifact: always true
    profiles(ids: string[]): Promise<Record<string, { id: string; name: string; guest: boolean }>>; // name "" when unknown
}

interface Assets {
    upload(file: Blob | File, name?: string): Promise<{ id: string; url: string; name: string; contentType: string; size: number }>;
    list(): Promise<{ id: string; url: string; name: string; contentType: string; size: number }[]>;
    url(id: string): string;                         // "/_blob/<id>", usable in <img src>, fetch, CSS url()
}

interface ArtifactSelf { publish(html: string): Promise<{ ver: string; seq: number }> } // rejects with code "conflict" when a newer version exists

// the viewer confirms the final name and size; resolves {status: "saved"} only if they accept. one prompt at a time.
// extensions: gif png jpg jpeg webp mp4 webm txt json md docx pptx epub csv ttf html svg pdf xlsx zip
interface Downloads { save(req: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<{ status: 'saved' }> }
// rejects with code: rejected_extension | declined | rate_limited | bad_request | request_unknown | unavailable

type PermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable';
interface Permissions {
    state(): Promise<Record<string, PermissionState>>;  // declared, usable capabilities only
    state(name: string): Promise<PermissionState>;     // a declared capability is "granted" locally; anything else "unavailable"
    request(names?: string[]): Promise<Record<string, PermissionState>>; // never prompts locally, never rejects
    manage(): Promise<void>;                           // rejects "unavailable": the local viewer has no Permissions panel
}

// a republish reaches open views at their next quiet moment (no button held, no input for 1.5 s; at most 30 s later) and
// reloads them; hot carries state worth keeping (a long form, a game in progress) across that reload, in that tab only
interface Hot {
    data: unknown;                                   // what the previous version's snapshot returned, or undefined
    snapshot(fn: () => unknown): void;               // fn runs just before the reload; return JSON-able state
    ready(start: (data: any) => void): Promise<void>; // calls start(data ?? {})
}
```

Writes reject with an `Error` whose `code` is one of `not_found`, `invalid_argument`, `version_mismatch`, `edit_no_match`, `edit_ambiguous`, `too_large`, `not_declared`. A write to a document this page has read is pinned to the version it read, so a concurrent change from another view or from Claude fails with `version_mismatch` instead of being overwritten — re-read, reapply, write again.

**The viewer-facing capabilities**, as served here (verbs, shapes and error codes are claude.ai's; what differs locally is noted):

- `comments` — `openComposer({element} | {range})` → `{opened}` (`false` is a soft refusal: a box holding typed text, a `data-uncommentable` target, or no gesture); `anchorFor(el)` → anchor for `create({anchor, text})` → `{threadId, commentId}`; `reply(threadId, text)`; `sendToClaude({anchor | threadId, text})` from the viewer's own click, gated on `canSendToClaude()` (`"available"`, `"no_session"` when no Claude session is linked, `"off"` under composer_only); `resolve(threadId, resolved)`; `delete(threadId)`. Text is plain, ≤ 4 KiB; `@claude` in page text never brings Claude in. Codes: `consent_required`, `forbidden`, `invalid`, `not_found`, `rate_limited`, `claude_unavailable`, `not_granted`. Write-only: the viewer shows every thread, labelled "via the artifact". `customAnchors({mode, threads, reveal, composing?})` → `{compose(anchor, at, opts?), open(id, at), placed(map), domAnchor(el, ev?), exitMode(), release(), areas}`; anchors are the page's own names (≤ 128 bytes), points are document px (`pageX`/`pageY`); `move` is not offered here.
- `files` — `list({path?, recursive?, cursor?})` → `{entries: [{path, isDirectory, size, createdAt?}], cursor?}` (500 a page); `read(path, {offset?, length?})` → `{bytes, size, revision}` (≤ 25 MiB a read); `download(path)` → the viewer confirms the name and size, the page never sees the bytes; programs and scripts are refused. Codes: `not_found`, `not_granted`, `changed`, `rate_limited`, `too_large`, `declined`, `bad_request`, `unavailable`.
- `mcp` — `callTool(server, tool, input?, {cache?, signal?})` → `{content, structuredContent?, payload, cache?}`; `watchTool(server, tool, input, handler, {cache?, refetchInterval?})` (reads only, ≥ 30 s polling, paused while hidden); `invalidate(server?, tool?, input?)`; `listTools(server?)`; `server(name)` → a handle whose methods are its tools and resolve to `payload`; `describeTool(server, tool)`. Read-only tools cache for 5 minutes by default. Codes as on claude.ai: `server_not_connected`, `not_in_manifest`, `tool_error`, `server_unavailable` (`retryable`), `cancelled` (also when the viewer declines a write), `bad_request`, `needs_reauth`. Servers come from the project's `.mcp.json` or `~/.spatial-artifacts/mcp.json`; stdio and streamable http only. File arguments are not available (`capability_disabled`).
- `room` — `emit(topic, data?)`, `on(topic, fn)`, `presence(patch)`, `peers()`, `onPeers(fn)` (once a frame, `{peers, joined, left, updated}`), `connected()`, `onConnection(fn)`, `join(name)` → a named room with the same calls plus `leave()`. Topics match `^[a-z][a-z0-9_.-]{0,47}$`; data and merged presence ≤ 4 KiB; about 40 sends a second. There is one local person, so every peer is `isMe` (`sameTab` tells this tab), `guest` is false, and every topic is open. `sendToClaudeSession(data, {deliver: "send", onStatus?})` must be called synchronously from a click; the viewer confirms it and it reaches the linked Claude session with its next notice (`canSendToClaudeSession()` is `"available_if_summoned"` when one is linked). There is no conversation beside the page to stage into, so `deliver: "stage"` rejects `claude_unavailable`.

**Patterns**

- Records people or Claude add later (a log, a tracker, the numbers on a dashboard, a sign-up sheet) live in `db`, one document per record in a collection, never in the page source or `localStorage`. Render from `collection(...).onSnapshot(...)` so the page stays current when Claude writes rows with `SpatialArtifactData`.
- Seed example rows only when the collection is empty, and mark them as examples.
- Per-person state (a viewer's votes, drafts, preferences that must survive) goes under `data/users/me/…` with `user` declared.
- A generated file the viewer takes away (a CSV export, a rendered PNG): `downloads.save({filename, data})` on a click, never on load; hide the button when `use("downloads")` resolves `null` and show `declined` quietly.
- State a viewer would lose on a republish: `window.claude?.hot?.snapshot(() => state)` and boot through `window.claude?.hot?.ready ? window.claude.hot.ready(start) : start(window.claude?.hot?.data ?? {})`.
- Make write affordances discoverable without writing anything: `comments` with `composer_only` and a button that calls `openComposer`.
- Ask for several consents at once only when the page needs them up front: `permissions.request(["files", "comments"])` from a startup step, otherwise let the first call ask.
- A dashboard of the viewer's local tools: `mcp.watchTool` per section, each section degrading on its own error code.
- Files people add: `assets.upload(file)` from an `<input type=file>` or drop handler, then store the returned `id` in a `db` document; render with `assets.url(id)`.
- Every capability call can fail: catch it, show the error in the page, and keep the rest of the page working.
- The runtime reports console errors, uncaught errors, failed loads and failed capability calls to `SpatialArtifactCheck` `verify` — after publishing, open the page yourself or have the user open it, then verify.

Tool spelling in this session: a call to the `SpatialArtifact` tool with `action: "read_db"` / `"write_db"` plus a `db_op` means the `SpatialArtifactData` tool, taking that `db_op` ("get", "list", "query", "set", "update", "str_replace", "delete", "batch") as its `action` and leaving every other field as is; the `SpatialArtifact` tool's `action: "verify"` / `action: "preview"` are the `SpatialArtifactCheck` tool's.
