// on-disk state. only the daemon imports this, so there is a single writer.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';

import {
    ASSET_TYPES,
    CLAUDE_WORK_MS,
    COMMENT_ATTACH_MAX,
    COMMENT_IMAGE_MAX_BYTES,
    COMMENT_IMAGE_TYPES,
    COMMENT_MAX_BYTES,
    DIAG_MAX_BYTES,
    DIAG_MAX_ENTRIES,
    HOME,
    MAX_ASSET_BYTES,
    MAX_ASSET_FILES,
    MAX_ASSET_STORE_BYTES,
    MAX_SVG_ASSET_BYTES,
    MAX_VERSION_BYTES,
    MAX_VERSION_FILES,
    UUID_RE,
    VER_RE,
} from './constants.ts';

export type FileEntry = { path: string; contentType: string; size: number; sha256: string };
export type Version = {
    ver: string;
    seq: number;
    at: string;
    label?: string | undefined;
    by: 'claude' | 'page';
    files: FileEntry[];

    // the local file the page was published from, so a later session republishing it finds this artifact
    source?: string;
};
export type Meta = {
    id: string;
    title: string;
    description?: string | undefined;
    icon?: string | undefined;
    capabilities: Record<string, unknown>;
    contract: string;
    createdAt: string;
    updatedAt: string;
    ver: string;
    seq: number;
    versions: Version[];
    pinned?: boolean;
};
// delivered_at: a notice (monitor, codex watcher or prompt hook) told a session about it
// via 'page': the person wrote it through the artifact page's own controls (the comments capability), not the viewer
export type Comment = {
    id: string;
    author: 'user' | 'claude';
    text: string;
    created_at: string;
    to_claude_at?: string;
    delivered_at?: string;
    via?: 'page';
    images?: { type: string }[];
};
export type Region = { x0: number; y0: number; x1: number; y1: number };
export type Anchor = {
    path?: string;
    span?: { quote: string };
    label?: string;
    detail?: string;
    snippet?: string;
    file?: string;
    region?: Region;
    inside?: string[];
    at?: { x: number; y: number };
    image?: { type: string };
    also?: { path: string; label?: string; snippet?: string; image?: { type: string } }[];
};
export type Thread = {
    id: string;
    created_at: string;
    ver?: string;
    resolved_at?: string;
    resolved_by?: 'claude' | 'user';
    claude_activated_at?: string;

    // when Claude last read the thread with a request of its still unanswered
    claude_seen_at?: string;
    anchor?: Anchor | undefined;
    comments: Comment[];
};
export type Asset = { id: string; name: string; contentType: string; size: number; sha256: string; createdAt: string };

export const ROOT = join(HOME, 'artifacts');
const now = () => new Date().toISOString();

/** a limit every caller hits, the page as much as the agent; the daemon answers with its status */
export const refuse = (status: number, message: string): never => {
    throw Object.assign(new Error(message), { status });
};
export const attempt = <T>(f: () => T): [unknown, T?] => {
    try {
        return [undefined, f()];
    } catch (e) {
        return [e];
    }
};

export const writeAtomic = (file: string, data: string | Buffer) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
};

const readJson = <T>(file: string, fallback: T): T =>
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const writeJson = (file: string, v: unknown) => writeAtomic(file, JSON.stringify(v, null, 1));

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const dir = (id: string) => {
    if (!UUID_RE.test(id)) {
        throw new Error('bad artifact id');
    }
    return join(ROOT, id);
};

/** resolves a published path inside a version dir; undefined when it escapes */
export const inside = (base: string, rel: string) => {
    const p = normalize(join(base, rel));
    return p.startsWith(base + sep) ? p : undefined;
};

export const exists = (id: string) => UUID_RE.test(id) && existsSync(join(ROOT, id, 'meta.json'));
export const meta = (id: string): Meta => readJson(join(dir(id), 'meta.json'), null as unknown as Meta);
const saveMeta = (m: Meta) => writeJson(join(dir(m.id), 'meta.json'), m);

export const list = (): Meta[] =>
    existsSync(ROOT)
        ? readdirSync(ROOT)
              .filter(exists)
              .map(meta)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : [];

export const versionDir = (id: string, ver: string) => {
    if (!VER_RE.test(ver)) {
        throw new Error('bad version');
    }
    return join(dir(id), 'v', ver);
};

export const page = (id: string, ver?: string) => {
    const m = meta(id);
    return readFileSync(join(versionDir(id, ver ?? m.ver), 'index.html'), 'utf8');
};

export type PublishInput = {
    id?: string;
    title: string;
    description?: string;
    icon?: string;
    label?: string;
    html: string;
    files?: Record<string, { data: Buffer; contentType: string } | null>;
    capabilities?: Record<string, unknown>;
    contract?: string;
    by?: 'claude' | 'page';
    source?: string;
};

/** mints a new version: the page plus carried, replaced and removed files */
export const publish = (p: PublishInput) => {
    const id = p.id ?? randomUUID();
    const prev = p.id ? meta(id) : undefined;
    const next = new Map(prev?.versions[prev.versions.length - 1].files.map((f) => [f.path, f.size]) ?? []);
    for (const [path, f] of Object.entries(p.files ?? {})) {
        if (f) {
            next.set(path, f.data.length);
        } else {
            next.delete(path);
        }
    }
    const bytes = [...next.values()].reduce((n, x) => n + x, Buffer.byteLength(p.html));
    if (next.size > MAX_VERSION_FILES) {
        refuse(
            413,
            `a version holds at most ${MAX_VERSION_FILES} files besides the page; this one would hold ${next.size}`,
        );
    }
    if (bytes > MAX_VERSION_BYTES) {
        refuse(
            413,
            `a version holds at most ${MAX_VERSION_BYTES / 1024 / 1024}MB in all; this one would hold ${(bytes / 1024 / 1024).toFixed(1)}MB`,
        );
    }
    const ver = randomBytes(6).toString('hex');
    const vdir = versionDir(id, ver);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, 'index.html'), p.html);

    const written: FileEntry[] = [];
    const removed: string[] = [];
    const files = new Map<string, FileEntry>();
    if (prev) {
        const pdir = versionDir(id, prev.ver);
        for (const f of prev.versions[prev.versions.length - 1].files) {
            if (p.files && f.path in p.files) {
                continue;
            }
            const to = inside(vdir, f.path);
            if (!to) {
                throw new Error(`files: ${f.path} escapes the artifact`);
            }
            mkdirSync(dirname(to), { recursive: true });
            const from = join(pdir, f.path);

            // version files are never rewritten, so sharing one inode is safe; copy where links fail
            if (attempt(() => linkSync(from, to))[0]) {
                copyFileSync(from, to);
            }
            files.set(f.path, f);
        }
    }
    for (const [path, f] of Object.entries(p.files ?? {})) {
        if (f === null) {
            removed.push(path);
            continue;
        }
        const to = inside(vdir, path);
        if (!to) {
            throw new Error(`files: ${path} escapes the artifact`);
        }
        mkdirSync(dirname(to), { recursive: true });

        // rename, never write through: `to` may be a hard link carried from the previous version
        writeAtomic(to, f.data);
        const e = { path, contentType: f.contentType, size: f.data.length, sha256: sha256(f.data) };
        files.set(path, e);
        written.push(e);
    }

    const at = now();
    const carried = p.capabilities === undefined;
    const m: Meta = {
        id,
        title: p.title,
        description: p.description ?? prev?.description,
        icon: p.icon ?? prev?.icon,
        capabilities: p.capabilities ?? prev?.capabilities ?? {},
        contract: p.contract === 'latest' || !p.contract ? (prev?.contract ?? '1.0.0') : p.contract,
        createdAt: prev?.createdAt ?? at,
        updatedAt: at,
        ver,
        seq: (prev?.seq ?? 0) + 1,
        ...(prev?.pinned && { pinned: true }),
        versions: [
            ...(prev?.versions ?? []),
            {
                ver,
                seq: (prev?.seq ?? 0) + 1,
                at,
                label: p.label,
                by: p.by ?? 'claude',
                files: [...files.values()],
                ...(p.source && { source: p.source }),
            },
        ],
    };
    saveMeta(m);
    return { meta: m, written, removed, carried };
};

/** the artifact a file was last published to, and whether its live version is still that publish */
export const bySource = (source: string) => {
    const m = list().find((x) => x.versions.some((v) => v.source === source));
    const live = m?.versions.at(-1);
    return m && live && { id: m.id, ver: m.ver, seq: m.seq, own: live.by === 'claude' && live.source === source };
};

export const remove = (id: string) => rmSync(dir(id), { recursive: true, force: true });

/** pins or unpins an artifact in the gallery; the version is untouched */
export const setPinned = (id: string, on: boolean) => {
    const m = meta(id);
    if (on) {
        m.pinned = true;
    } else {
        delete m.pinned;
    }
    saveMeta(m);
    return m;
};

// comments

const commentsFile = (id: string) => join(dir(id), 'comments.json');
export const threads = (id: string): Thread[] => readJson(commentsFile(id), []);
export const saveThreads = (id: string, t: Thread[]) => writeJson(commentsFile(id), t);

export const newThread = (
    id: string,
    text: string,
    anchor: Anchor | undefined,
    ver: string,
    via?: 'page',
    images?: unknown[],
) => {
    if (Buffer.byteLength(text) > COMMENT_MAX_BYTES) {
        refuse(413, `a comment is at most ${COMMENT_MAX_BYTES} bytes`);
    }
    const t: Thread = { id: randomUUID(), created_at: now(), ver, anchor, comments: [] };
    const all = threads(id);
    all.push(t);
    saveThreads(id, all);
    return addComment(id, t.id, 'user', text, false, via, images);
};

const mentionsClaude = (text: string) => /(^|\s)@claude\b/i.test(text);

export const addComment = (
    id: string,
    tid: string,
    author: 'user' | 'claude',
    text: string,
    toClaude = false,
    via?: 'page',
    images?: unknown[],
) => {
    if (Buffer.byteLength(text) > COMMENT_MAX_BYTES) {
        refuse(413, `a comment is at most ${COMMENT_MAX_BYTES} bytes`);
    }
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    if (!t) {
        return undefined;
    }

    // reference images the viewer attached; any that aren't a small png, jpeg or webp are dropped
    const imgs = (images ?? [])
        .map((x) => commentImage(x))
        .filter((x) => !!x)
        .slice(0, COMMENT_ATTACH_MAX);
    const c: Comment = {
        id: randomUUID(),
        author,
        text,
        created_at: now(),
        ...(via && { via }),
        ...(imgs.length ? { images: imgs.map((x) => ({ type: x.type })) } : {}),
    };
    for (const [k, x] of imgs.entries()) {
        writeAtomic(attachFile(id, tid, c.id, k, x.type), x.data);
    }

    // "@claude" in text a page wrote does not bring Claude in; only an explicit send does
    if (author === 'user' && (toClaude || (!via && mentionsClaude(text)))) {
        c.to_claude_at = c.created_at;
        t.claude_activated_at ??= c.created_at;
    }
    t.comments.push(c);
    saveThreads(id, all);
    return { thread: t, comment: c };
};

/** "send to claude": activates the thread and marks its latest user comment */
export const sendToClaude = (id: string, tid: string) => {
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    if (!t) {
        return undefined;
    }
    const at = now();
    t.claude_activated_at ??= at;
    const last = t.comments.findLast((c) => c.author === 'user');
    if (last && !last.to_claude_at) {
        last.to_claude_at = at;
    }
    saveThreads(id, all);
    return t;
};

export const resolveThread = (id: string, tid: string, resolved: boolean, by: 'claude' | 'user') => {
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    if (!t) {
        return undefined;
    }
    if (resolved) {
        t.resolved_at = now();
        t.resolved_by = by;
    } else {
        delete t.resolved_at;
        delete t.resolved_by;
    }
    saveThreads(id, all);
    return t;
};

export const deleteThread = (id: string, tid: string) => {
    if (UUID_RE.test(tid)) {
        rmSync(join(dir(id), 'comment-images', tid), { recursive: true, force: true });
    }
    return saveThreads(
        id,
        threads(id).filter((t) => t.id !== tid),
    );
};

// the bytes' own signature must match the claimed type, since the page supplies both
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
    'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/webp': (b) =>
        b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** decodes a data: url capture of a drawn area; undefined unless it is a small png, jpeg or webp */
export const commentImage = (url: unknown) => {
    const m =
        typeof url === 'string' &&
        url.length <= (COMMENT_IMAGE_MAX_BYTES * 4) / 3 + 64 &&
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!m) {
        return undefined;
    }
    const b = Buffer.from(m[2], 'base64');
    return b.length <= COMMENT_IMAGE_MAX_BYTES && SIGNATURES[m[1]](b) ? { type: m[1], data: b } : undefined;
};

// a thread's captures: n 0 is its anchor's, n >= 1 the one of its nth Shift-picked `also` anchor
const imageTarget = (t: Thread | undefined, n: number) => (n === 0 ? t?.anchor : t?.anchor?.also?.[n - 1]);
const imageFile = (id: string, tid: string, n: number, type: string) =>
    join(dir(id), 'comment-images', tid, `${n ? `also-${n}` : 'area'}.${COMMENT_IMAGE_TYPES[type]}`);

/** stores one of a thread's captures and records its type on the anchor it shows */
export const setThreadImage = (id: string, tid: string, img: { type: string; data: Buffer }, n = 0) => {
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    const a = imageTarget(t, n);
    if (!a || !UUID_RE.test(tid)) {
        return undefined;
    }
    writeAtomic(imageFile(id, tid, n, img.type), img.data);
    a.image = { type: img.type };
    saveThreads(id, all);
    return t;
};

export const threadImage = (id: string, tid: string, n = 0) => {
    const type = imageTarget(
        threads(id).find((x) => x.id === tid),
        n,
    )?.image?.type;
    if (!type || !UUID_RE.test(tid)) {
        return undefined;
    }
    const file = imageFile(id, tid, n, type);
    return existsSync(file) ? { type, file } : undefined;
};

const attachFile = (id: string, tid: string, cid: string, k: number, type: string) =>
    join(dir(id), 'comment-images', tid, `${cid}-${k}.${COMMENT_IMAGE_TYPES[type]}`);

/** the kth reference image attached to a comment, if it has one */
export const commentAttachment = (id: string, tid: string, cid: string, k: number) => {
    const type = threads(id)
        .find((x) => x.id === tid)
        ?.comments.find((c) => c.id === cid)?.images?.[k]?.type;
    if (!type || !UUID_RE.test(tid) || !UUID_RE.test(cid)) {
        return undefined;
    }
    const file = attachFile(id, tid, cid, k, type);
    return existsSync(file) ? { type, file } : undefined;
};

// the request Claude still owes an answer on: the latest comment sent to it, if nothing answered it since
const openAsk = (t: Thread) => {
    if (t.resolved_at) {
        return undefined;
    }
    const i = t.comments.findLastIndex((c) => !!c.to_claude_at);
    return i >= 0 && !t.comments.slice(i + 1).some((c) => c.author === 'claude') ? t.comments[i] : undefined;
};

/** Claude's progress on a thread: queued until a session hears of it, then working until it answers or CLAUDE_WORK_MS passes */
export const claudeStatus = (t: Thread, at = Date.now()) => {
    const ask = openAsk(t);
    if (!ask) {
        return undefined;
    }
    const seen =
        t.claude_seen_at && ask.to_claude_at && t.claude_seen_at >= ask.to_claude_at ? t.claude_seen_at : undefined;
    const start = [ask.delivered_at, seen].filter(Boolean).sort().pop();
    if (!start) {
        return { status: 'queued' as const };
    }
    const until = Date.parse(start) + CLAUDE_WORK_MS;
    return at < until
        ? { status: 'working' as const, until: new Date(until).toISOString() }
        : { status: 'waiting' as const };
};

/** marks threads with an open request as read by Claude; true when any changed */
export const markSeen = (id: string) => {
    const all = threads(id);
    const at = now();
    const open = all.filter(openAsk);
    for (const t of open) {
        t.claude_seen_at = at;
    }
    if (open.length) {
        saveThreads(id, all);
    }
    return open.length > 0;
};

// what a page handed the viewer's Claude (room.sendToClaudeSession, from the viewer's click and confirmed in the viewer);
// each goes out once with the next notice
export type PageSend = { id: string; at: string; data: unknown; delivered_at?: string };
const sendsFile = (id: string) => join(dir(id), 'to-claude.json');
export const pageSends = (id: string): PageSend[] => readJson(sendsFile(id), []);
export const addPageSend = (id: string, data: unknown) => {
    const x: PageSend = { id: randomUUID(), at: now(), data };
    writeJson(sendsFile(id), [...pageSends(id).slice(-49), x]);
    return x;
};

// comments sent to claude that no notice has mentioned yet, and page sends not yet delivered, on every artifact or only on `ids`
const noticeFile = join(HOME, 'notice.json');
export const pending = (ids?: string[]) => {
    const seen: Record<string, string> = readJson(noticeFile, {});
    const out: { id: string; title: string; count: number; sends: { id: string; data: unknown }[] }[] = [];
    const next = { ...seen };
    for (const m of list().filter((a) => !ids || ids.includes(a.id))) {
        const since = seen[m.id] ?? '';
        let count = 0;
        const all = threads(m.id);
        const at = now();
        for (const t of all) {
            for (const c of t.comments) {
                if (c.to_claude_at && c.to_claude_at > since) {
                    count++;
                    c.delivered_at ??= at;
                }
            }
        }
        if (count) {
            saveThreads(m.id, all);
        }
        const ps = existsSync(sendsFile(m.id)) ? pageSends(m.id) : [];
        const fresh = ps.filter((x) => !x.delivered_at);
        if (fresh.length) {
            for (const x of fresh) {
                x.delivered_at = at;
            }
            writeJson(sendsFile(m.id), ps);
        }
        if (count || fresh.length) {
            out.push({ id: m.id, title: m.title, count, sends: fresh.map((x) => ({ id: x.id, data: x.data })) });
        }
        next[m.id] = at;
    }
    if (out.some((o) => o.count)) {
        writeJson(noticeFile, next);
    }
    return out;
};

/** comments the agent just read need no notice */
export const ack = (id: string) => writeJson(noticeFile, { ...readJson(noticeFile, {}), [id]: now() });

// grants: what the viewer allowed this artifact's page to do as them (comments, files, mcp:<server>).
// written only by the viewer shell after the viewer's own answer; the daemon checks them on every call

const grantsFile = (id: string) => join(dir(id), 'grants.json');
export const grants = (id: string): Record<string, { at: string }> => readJson(grantsFile(id), {});
export const granted = (id: string, name: string) => name in grants(id);
export const setGrant = (id: string, name: string, on: boolean) => {
    const g = grants(id);
    if (on) {
        g[name] = { at: now() };
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- grants are keyed by capability
        delete g[name];
    }
    writeJson(grantsFile(id), g);
    return g;
};

// assets

const assetsFile = (id: string) => join(dir(id), 'assets.json');
export const assets = (id: string): Asset[] => readJson(assetsFile(id), []);
export const assetPath = (id: string, aid: string) => join(dir(id), 'assets', aid);
export const addAsset = (id: string, name: string, contentType: string, data: Buffer) => {
    if (!Object.values(ASSET_TYPES).includes(contentType)) {
        refuse(
            415,
            `${contentType} is not an uploadable asset type (images, video, PDF, fonts, CSS, JS, CSV, Markdown, JSON, plain text)`,
        );
    }
    const max = contentType === 'image/svg+xml' ? MAX_SVG_ASSET_BYTES : MAX_ASSET_BYTES;
    if (data.length > max) {
        refuse(413, `an asset of this type is at most ${max / 1024 / 1024}MB`);
    }
    const all = assets(id);
    if (all.length >= MAX_ASSET_FILES) {
        refuse(413, `the asset store holds at most ${MAX_ASSET_FILES} files`);
    }
    if (all.reduce((n, x) => n + x.size, data.length) > MAX_ASSET_STORE_BYTES) {
        refuse(413, `the asset store holds at most ${MAX_ASSET_STORE_BYTES / 1024 / 1024 / 1024}GB`);
    }
    const a: Asset = {
        id: randomBytes(16).toString('hex'),
        name: String(name).slice(0, 255),
        contentType,
        size: data.length,
        sha256: sha256(data),
        createdAt: now(),
    };
    writeAtomic(assetPath(id, a.id), data);
    writeJson(assetsFile(id), [...all, a]);
    return a;
};
/** copies assets from another artifact's store server side; each copy gets a new id in this one */
export const copyAssets = (id: string, from: string, ids: string[]) => {
    const src = assets(from);
    return ids.map((aid) => {
        const a = src.find((x) => x.id === aid);
        return a
            ? { from: aid, asset: addAsset(id, a.name, a.contentType, readFileSync(assetPath(from, aid))) }
            : { from: aid, error: 'not_found' as const };
    });
};

export const deleteAsset = (id: string, aid: string) => {
    const all = assets(id);
    if (!all.some((a) => a.id === aid)) {
        return false;
    }
    rmSync(assetPath(id, aid), { force: true });
    writeJson(
        assetsFile(id),
        all.filter((a) => a.id !== aid),
    );
    return true;
};

// diagnostics captured by viewers' browsers, per version

const diagFile = (id: string, ver: string) => join(dir(id), 'diag', `${ver}.json`);
export const diag = (id: string, ver: string): { entries: unknown[]; truncated: boolean } | undefined =>
    existsSync(diagFile(id, ver)) ? readJson(diagFile(id, ver), { entries: [], truncated: false }) : undefined;
export const addDiag = (id: string, ver: string, entries: unknown[]) => {
    if (!VER_RE.test(ver)) {
        return;
    }
    const d = diag(id, ver) ?? { entries: [], truncated: false };
    let bytes = JSON.stringify(d.entries).length;
    for (const e of entries) {
        const n = JSON.stringify(e).length;
        if (d.entries.length >= DIAG_MAX_ENTRIES || bytes + n > DIAG_MAX_BYTES) {
            d.truncated = true;
            break;
        }
        d.entries.push(e);
        bytes += n;
    }
    writeJson(diagFile(id, ver), d);
};

// the one local person

export const me = () => {
    const name = process.env['SPATIAL_ARTIFACTS_USER'] ?? userInfo().username;
    const b = createHash('sha256').update(`local:${name}`).digest('base64url').replace(/-/g, '_');
    return { id: `u_${b.slice(0, 22)}`, name };
};

export const size = (file: string) => statSync(file).size;
