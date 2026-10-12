import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { HOME, UUID_RE } from '../constants.ts';

export type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type Result = { content: Block[]; isError?: boolean };

export const text = (t: string, isError = false): Result => ({
    content: [{ type: 'text', text: t }],
    ...(isError && { isError }),
});

/** an input problem the model can fix; the tool returns it as an error result */
export class InputError extends Error {}

// explicitly typed so a `bad(...)` statement narrows like a throw
export const bad: (msg: string) => never = (msg) => {
    throw new InputError(msg);
};

// per-process, so per claude session: which artifacts this conversation published or read
export const session = {
    byPath: new Map<string, string>(),
    seen: new Map<string, string>(),
    // artifacts whose comments this session read; with `seen`, the ones it reports to the daemon as linked
    linked: new Set<string>(),
    last: undefined as { id: string; ver: string } | undefined,
    // published paths this session read, listed or published, per artifact, with the sha256 it saw: a publish may replace
    // or remove a live file only when it is here and unchanged, or named in overwrite_unread
    known: new Map<string, Map<string, string>>(),
    previewed: new Set<string>(),
    watchAdvised: false,
};

export const know = (id: string, path: string, sha?: string) => {
    const m = session.known.get(id) ?? new Map<string, string>();
    session.known.set(id, m);
    if (sha) {
        m.set(path, sha);
    } else {
        m.delete(path);
    }
};

export const nonce = () => randomUUID().slice(0, 8);

// codex runs plugin mcp servers from the plugin folder and tells them nothing about the
// workspace, so there the working directory is unknown
const PLUGIN_ROOT = resolve(import.meta.dirname, '..', '..');
const { CLAUDE_PROJECT_DIR } = process.env;
export const NO_CWD = !CLAUDE_PROJECT_DIR && resolve(process.cwd()) === PLUGIN_ROOT;
export const CWD = CLAUDE_PROJECT_DIR ?? process.cwd();
export const abs = (p: string, root?: string) => {
    if (isAbsolute(p)) {
        return resolve(p);
    }
    if (!root && NO_CWD) {
        bad(`${p}: pass an absolute path — this host does not tell the artifact server its working directory`);
    }
    return resolve(root ?? CWD, p);
};

// supporting-file sources must sit under the working directory or a scratch/temp dir
const ALLOWED_ROOTS = [NO_CWD ? homedir() : CWD, tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', HOME].map(
    (p) => resolve(p),
);
export const allowedSource = (p: string) => ALLOWED_ROOTS.some((r) => p === r || p.startsWith(r + sep));

export const idOf = (url: string) => {
    const m =
        url.match(/\/code\/artifact\/([0-9a-f-]{36})/) ??
        url.match(/^https?:\/\/([0-9a-f-]{36})\.localhost/) ??
        url.match(/^([0-9a-f-]{36})$/);
    if (!m || !UUID_RE.test(m[1])) {
        bad(
            `not an artifact URL: ${url} — updating an existing artifact takes its …/code/artifact/<uuid> link, which action: "list" can find; for a brand-new artifact, leave \`url\` out`,
        );
    }
    return m[1];
};

export const readsDir = (id: string) => join(HOME, 'reads', id);

// the comment watch is the plugin's artifact-comments monitor, which claude code starts when spatial-design or
// spatial-3d-design loads: each line the script prints wakes the session. monitors.json repeats it per skill
// name, bare and plugin-qualified, since a trigger matches the name the skill was invoked by. WATCH_CMD is the manual fallback
const env = ['SPATIAL_ARTIFACTS_DIR', 'SPATIAL_ARTIFACTS_PORT']
    .filter((k) => process.env[k])
    .map((k) => `${k}=${JSON.stringify(process.env[k])} `)
    .join('');
export const WATCH_CMD = `${env}node ${JSON.stringify(join(import.meta.dirname, '..', '..', 'scripts', 'watch-comments.ts'))}`;
export const watchHowTo = () =>
    `this plugin's artifact-comments monitor, which Claude Code starts on its own the first time the spatial-design or spatial-3d-design skill loads in a session — load spatial-design if this session has loaded neither. Each line it prints means the user sent comments to Claude: read them with SpatialArtifactComments action "read" and the url it names, make the change, then reply and resolve. Do not start a second Monitor for it; only if the user says comments they sent to Claude are not arriving, call the Monitor tool with command \`${WATCH_CMD}\`, description "artifact comments sent to Claude" and timeout_ms 3600000, and re-arm it the same way whenever it expires. In Codex there is no monitor and nothing to start: the plugin's prompt hook runs a watcher that sends them to this session as queued messages`;

export const fmtBytes = (n: number) =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n} bytes`;

/** wraps content others wrote between nonce-tagged BEGIN/END lines whose note marks it as data, not instructions */
export const fence = (label: string, note: string, body: string) => {
    const n = nonce();
    return `=== BEGIN ${label} ${n} — ${note} ===\n${body}\n=== END ${label} ${n} ===`;
};
