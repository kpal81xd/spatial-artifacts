// the local stand-in for claude.ai: serves the viewer shell, each artifact on its own
// <uuid>.localhost origin, and the agent api the mcp server calls. single writer of state.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ANCHOR_ALSO_MAX,
    ASSET_ID_RE,
    CAPABILITIES,
    FILE_TYPES,
    FRAME_CSP,
    GRANT_RE,
    HOME,
    HOST,
    MAX_PAGE_BYTES,
    PERMISSIONS_POLICY,
    PORT,
    PRESENCE_MS,
    PRESENCE_TTL_MS,
    REGION_INSIDE_MAX,
    SCENE_DIR,
    SCENE_FILES,
    SCENE_ROUTE,
    UUID_RE,
    VER_RE,
} from './constants.ts';
import * as db from './db.ts';
import * as F from './files.ts';
import { createHosts } from './mcphost.ts';
import { checkJson, createRooms } from './room.ts';
import * as S from './store.ts';
import { findTitle, injectRuntime, wrapHtml } from './wrap.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MAX_BODY = 128 * 1024 * 1024;

type Req = IncomingMessage & { body?: Buffer };
type Sse = { res: ServerResponse; id: string };

export const startDaemon = (opts: { port?: number; token?: string } = {}) => {
    const token = opts.token ?? randomBytes(24).toString('hex');
    const shellSse = new Set<Sse>();
    const frameSse = new Set<Sse>();
    let port = opts.port ?? PORT;

    const shellOrigin = () => `http://localhost:${port}`;
    const frameOrigin = (id: string) => `http://${id}.localhost:${port}`;
    const urlOf = (id: string) => `${shellOrigin()}/code/artifact/${id}`;

    const emit = (set: Set<Sse>, id: string, event: string, data: unknown) => {
        for (const c of set) {
            if (c.id === id || c.id === '*') {
                c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        }
    };

    // sessions by host pid: the artifacts each published or read, when its mcp server and its comment monitor last checked in
    const hosts = new Map<number, { ids: string[]; at: number; watch?: number }>();
    const shown = new Map<string, string>();
    const rooms = createRooms();
    const hosts_ = createHosts();
    // one-time approvals for an mcp call the viewer confirmed in the shell: token -> what it allows, until it is used or expires
    const approvals = new Map<string, { id: string; what: string; until: number }>();
    const stable = (v: unknown): string =>
        Array.isArray(v)
            ? `[${v.map(stable).join(',')}]`
            : v && typeof v === 'object'
              ? `{${Object.keys(v)
                    .sort()
                    .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
                    .join(',')}}`
              : JSON.stringify(v ?? null);
    const callKey = (server: string, tool: string, input: unknown) =>
        createHash('sha256')
            .update(`${server}\0${tool}\0${stable(input)}`)
            .digest('hex');
    const sendTimes = new Map<string, number>();
    const fresh = (t?: number) => !!t && Date.now() - t < PRESENCE_TTL_MS;
    const presence = (id: string) => {
        let s = 'none';
        for (const x of hosts.values()) {
            if (fresh(x.at) && x.ids.includes(id)) {
                if (fresh(x.watch)) {
                    return 'watching';
                }
                s = 'open';
            }
        }
        return s;
    };

    // tells open viewers when an artifact's presence changes, including sessions that went quiet
    const sweep = () => {
        for (const [k, x] of hosts) {
            if (!fresh(x.at) && !fresh(x.watch)) {
                hosts.delete(k);
            }
        }
        for (const id of new Set([...shown.keys(), ...[...hosts.values()].flatMap((x) => x.ids)])) {
            const s = presence(id);
            if ((shown.get(id) ?? 'none') === s) {
                continue;
            }
            if (s === 'none') {
                shown.delete(id);
            } else {
                shown.set(id, s);
            }
            emit(shellSse, id, 'presence', { state: s });
        }
    };
    const sweeper = setInterval(sweep, PRESENCE_MS);
    sweeper.unref();

    const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
        const buf = Buffer.isBuffer(body)
            ? body
            : typeof body === 'string'
              ? Buffer.from(body)
              : Buffer.from(JSON.stringify(body));
        res.writeHead(status, {
            'content-type':
                typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            ...headers,
        });
        res.end(buf);
    };
    const json = (res: ServerResponse, body: unknown, status = 200) => send(res, status, body);
    const notFound = (res: ServerResponse) => send(res, 404, 'not found');

    const readBody = (req: Req) =>
        new Promise<Buffer>((ok, bad) => {
            const chunks: Buffer[] = [];
            let n = 0;
            req.on('data', (c: Buffer) => {
                n += c.length;
                if (n > MAX_BODY) {
                    bad(Object.assign(new Error('body too large'), { status: 413 }));
                    req.destroy();
                } else {
                    chunks.push(c);
                }
            });
            req.on('end', () => ok(Buffer.concat(chunks)));
            req.on('error', bad);
        });
    const body = async (req: Req) => {
        const b = await readBody(req);
        if (!b.length) {
            return {};
        }
        const [e, v] = S.attempt(() => JSON.parse(b.toString('utf8')));
        return e ? S.refuse(400, 'the body is not JSON') : v;
    };

    const sse = (req: Req, res: ServerResponse, set: Set<Sse>, id: string) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
        });
        res.write(': ok\n\n');
        const c = { res, id };
        set.add(c);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
            clearInterval(ping);
            set.delete(c);
        });
    };

    const serveFile = (res: ServerResponse, file: string, type?: string, headers: Record<string, string> = {}) => {
        if (!existsSync(file) || !statSync(file).isFile()) {
            return notFound(res);
        }
        res.writeHead(200, {
            'content-type': type ?? FILE_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...headers,
        });
        createReadStream(file).pipe(res);
    };

    // only the viewer shell may frame a page; opening it in its own tab still works
    const frameHeaders = () => ({
        'content-security-policy': `${FRAME_CSP}; frame-ancestors ${shellOrigin()}`,
        'permissions-policy': PERMISSIONS_POLICY,
        'referrer-policy': 'no-referrer',
    });

    const tokenOk = (req: Req) => {
        const h = req.headers.authorization ?? '';
        const a = Buffer.from(h.replace(/^Bearer /, ''));
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
    };

    // db verbs shared by the agent api and the page's `db` capability; the agent's writes to existing documents must be pinned
    const dbCall = (id: string, verb: string, a: any, pinned = false) => {
        switch (verb) {
            case 'whoami':
                return { user: S.me() };
            case 'get': {
                const d = db.get(id, a.collection, a.doc_id);
                return { docs: d ? [d] : [] };
            }
            case 'list':
            case 'query':
                return db.query(id, a.collection, a.query ?? {});
            case 'batch': {
                const r = db.batch(id, a.writes ?? [], pinned);
                if (!('error' in r)) {
                    emit(frameSse, id, 'db', { paths: db.changed(a.writes) });
                }
                return r;
            }
            case 'set':
            case 'update':
            case 'delete':
            case 'str_replace': {
                const r = db.write(id, { ...a, op: verb }, pinned);
                if (!('error' in r)) {
                    emit(frameSse, id, 'db', { paths: db.changed({ ...a, op: verb }) });
                }
                return r;
            }
        }
        return { error: { code: 'invalid_argument', message: `unknown verb ${verb}` } };
    };

    // `save` echoes a page's own save id back to it, so the page and its viewer keep running instead of reloading
    const doPublish = (p: S.PublishInput & { baseVersion?: string; force?: boolean; save?: string }) => {
        const prev = p.id ? S.meta(p.id) : undefined;
        if (prev && p.baseVersion && p.baseVersion !== prev.ver && !p.force) {
            const live = prev.versions[prev.versions.length - 1];
            return { status: 409, body: { error: 'conflict', live: { ver: live.ver, seq: live.seq, by: live.by } } };
        }
        const same =
            prev &&
            S.page(prev.id) === p.html &&
            !p.files &&
            p.capabilities === undefined &&
            (p.contract === undefined || p.contract === 'latest' || p.contract === prev.contract) &&
            p.label === undefined &&
            (p.title ?? prev.title) === prev.title &&
            (p.description ?? prev.description) === prev.description &&
            (p.icon ?? prev.icon) === prev.icon;
        if (same) {
            return {
                status: 200,
                body: { id: prev.id, ver: prev.ver, seq: prev.seq, unchanged: true, url: urlOf(prev.id), meta: prev },
            };
        }
        const r = S.publish(p);
        emit(shellSse, r.meta.id, 'version', { ver: r.meta.ver, seq: r.meta.seq, by: p.by ?? 'claude', save: p.save });
        emit(frameSse, r.meta.id, 'version', { ver: r.meta.ver, save: p.save });
        return {
            status: 200,
            body: {
                id: r.meta.id,
                ver: r.meta.ver,
                seq: r.meta.seq,
                created: !prev,
                url: urlOf(r.meta.id),
                frame: `${frameOrigin(r.meta.id)}/v/${r.meta.ver}/`,
                written: r.written,
                removed: r.removed,
                carried: r.carried,
                meta: r.meta,
            },
        };
    };

    const decodeFiles = (files?: Record<string, { b64: string; contentType: string } | null>) =>
        files &&
        Object.fromEntries(
            Object.entries(files).map(([k, v]) => [
                k,
                v && { data: Buffer.from(v.b64, 'base64'), contentType: v.contentType },
            ]),
        );

    // /_agent/*: the mcp server and hooks, bearer token only
    const agent = async (req: Req, res: ServerResponse, parts: string[], q: URLSearchParams) => {
        if (parts[1] === 'health') {
            return json(res, { ok: true, pid: process.pid, port });
        }
        if (!tokenOk(req)) {
            return send(res, 401, 'unauthorized');
        }
        const m = req.method;
        if (parts[1] === 'publish' && m === 'POST') {
            const b = await body(req);
            if (b.id && !S.exists(b.id)) {
                return json(res, { error: 'not_found' }, 404);
            }
            const r = doPublish({ ...b, files: decodeFiles(b.files) });
            return json(res, r.body, r.status);
        }
        if (parts[1] === 'source' && m === 'GET') {
            const r = S.bySource(q.get('path') ?? '');
            return r ? json(res, { ...r, url: urlOf(r.id) }) : json(res, { error: 'not_found' }, 404);
        }
        if (parts[1] === 'artifacts' && m === 'GET') {
            return json(
                res,
                S.list().map((a) => ({ ...summary(a), url: urlOf(a.id) })),
            );
        }
        if (parts[1] === 'presence' && m === 'POST') {
            const b = await body(req);
            const k = Number(b.host);
            if (!Number.isInteger(k) || k <= 1) {
                return send(res, 400, 'host required');
            }
            const ids = (Array.isArray(b.artifacts) ? b.artifacts : []).filter(
                (x: unknown) => typeof x === 'string' && UUID_RE.test(x),
            );

            // merged, so a reloaded mcp server (same host, empty memory) keeps its session's links
            const prev = hosts.get(k);
            hosts.set(k, { ...prev, ids: [...new Set([...(prev?.ids ?? []), ...ids])], at: Date.now() });
            sweep();
            return json(res, { ok: true });
        }
        if (parts[1] === 'pending' && m === 'POST') {
            const b = await body(req);
            const k = Number(b.host);

            // the monitor's poll is its heartbeat; the prompt hook's is not
            if (k > 1 && b.watch) {
                hosts.set(k, { ids: [], at: 0, ...hosts.get(k), watch: Date.now() });
                sweep();
            }

            // a known session hears only of its own artifacts; an unknown caller (no mcp check-in) of all
            const x = hosts.get(k);
            const p = S.pending(x && fresh(x.at) ? x.ids : undefined);
            for (const a of p) {
                if (a.count) {
                    emit(shellSse, a.id, 'comments', {});
                }
                for (const sd of a.sends) {
                    emit(frameSse, a.id, 'to-claude', { id: sd.id, state: 'sent' });
                }
            }
            return json(
                res,
                p.map((a) => ({ ...a, url: urlOf(a.id) })),
            );
        }
        if (parts[1] !== 'a' || !S.exists(parts[2])) {
            return json(res, { error: 'not_found' }, 404);
        }
        const id = parts[2];
        const sub = parts[3];
        if (!sub && m === 'GET') {
            const meta = S.meta(id);
            const ver = q.get('ver') ?? meta.ver;
            if (!meta.versions.some((v) => v.ver === ver)) {
                return json(res, { error: 'no such version' }, 404);
            }
            return json(res, { meta, html: S.page(id, ver), url: urlOf(id), frame: `${frameOrigin(id)}/v/${ver}/` });
        }
        if (!sub && m === 'DELETE') {
            S.remove(id);
            rooms.close(id);
            emit(shellSse, id, 'deleted', {});
            emit(frameSse, id, 'deleted', {});
            return json(res, { deleted: true });
        }
        if (sub === 'file' && m === 'GET') {
            const meta = S.meta(id);
            const ver = q.get('ver') ?? meta.ver;
            const path = q.get('path') ?? '';
            const entry = meta.versions.find((v) => v.ver === ver)?.files.find((f) => f.path === path);
            if (!entry) {
                return json(res, { error: 'not_found' }, 404);
            }
            const data = readFileSync(join(S.versionDir(id, ver), path));
            return json(res, { ...entry, b64: data.toString('base64') });
        }
        if (sub === 'pin' && m === 'POST') {
            const b = await body(req);
            const meta = S.setPinned(id, b.on !== false);
            emit(shellSse, id, 'version', { ver: meta.ver, seq: meta.seq, by: 'claude' });
            return json(res, { pinned: !!meta.pinned });
        }
        if (sub === 'assets' && parts[4] === 'copy' && m === 'POST') {
            const b = await body(req);
            if (typeof b.from !== 'string' || !S.exists(b.from)) {
                return json(res, { error: 'source_not_found' }, 404);
            }
            const ids = (Array.isArray(b.ids) ? b.ids : []).filter(
                (x: unknown) => typeof x === 'string' && ASSET_ID_RE.test(x),
            );
            return json(res, { copied: S.copyAssets(id, b.from, ids) });
        }
        if (sub === 'assets') {
            const aid = parts[4];
            if (!aid && m === 'GET') {
                return json(res, S.assets(id));
            }
            if (!aid && m === 'POST') {
                const b = await body(req);
                return json(res, S.addAsset(id, b.name, b.contentType, Buffer.from(b.b64, 'base64')));
            }
            if (aid && ASSET_ID_RE.test(aid)) {
                const a = S.assets(id).find((x) => x.id === aid);
                if (m === 'GET') {
                    return a
                        ? json(res, { ...a, b64: readFileSync(S.assetPath(id, aid)).toString('base64') })
                        : json(res, { error: 'not_found' }, 404);
                }
                if (m === 'DELETE') {
                    return json(res, { deleted: S.deleteAsset(id, aid) });
                }
            }
        }
        if (sub === 'comments') {
            if (!parts[4] && m === 'GET') {
                S.ack(id);
                if (S.markSeen(id)) {
                    emit(shellSse, id, 'comments', {});
                }
                return json(res, { threads: S.threads(id) });
            }
            const tid = parts[4];
            if (parts[5] === 'image' && m === 'GET') {
                const img = S.threadImage(id, tid, Number(parts[6] ?? 0) || 0);
                return img
                    ? json(res, { type: img.type, b64: readFileSync(img.file).toString('base64') })
                    : json(res, { error: 'not_found' }, 404);
            }
            if (parts[5] === 'attach' && m === 'GET') {
                const img = S.commentAttachment(id, tid, parts[6] ?? '', Number(parts[7]) || 0);
                return img
                    ? json(res, { type: img.type, b64: readFileSync(img.file).toString('base64') })
                    : json(res, { error: 'not_found' }, 404);
            }
            if (parts[5] === 'reply' && m === 'POST') {
                const b = await body(req);
                const r = S.addComment(id, tid, 'claude', b.text);
                if (!r) {
                    return json(res, { error: 'not_found' }, 404);
                }
                emit(shellSse, id, 'comments', {});
                return json(res, { thread_id: tid, comment_id: r.comment.id });
            }
            if (parts[5] === 'resolve' && m === 'POST') {
                const t = S.resolveThread(id, tid, true, 'claude');
                if (!t) {
                    return json(res, { error: 'not_found' }, 404);
                }
                emit(shellSse, id, 'comments', {});
                return json(res, { thread_id: tid, resolved: true });
            }
        }
        if (sub === 'db' && m === 'POST') {
            const b = await body(req);
            return json(res, dbCall(id, b.verb, b.args ?? {}, true));
        }
        if (sub === 'diag' && m === 'GET') {
            const ver = parts[4];
            if (!VER_RE.test(ver ?? '')) {
                return notFound(res);
            }
            const d = S.diag(id, ver);
            return d ? json(res, d) : json(res, { error: 'no_row' }, 404);
        }
        return notFound(res);
    };

    const summary = (a: S.Meta) => {
        const t = S.threads(a.id);
        return {
            id: a.id,
            title: a.title,
            description: a.description,
            icon: a.icon,
            updatedAt: a.updatedAt,
            createdAt: a.createdAt,
            ver: a.ver,
            seq: a.seq,
            files: a.versions.at(-1)?.files.length ?? 0,
            pinned: !!a.pinned,
            openThreads: t.filter((x) => !x.resolved_at).length,
        };
    };

    // anchor text reaches the model, so keep only known, bounded fields
    const cleanAnchor = (raw: any): S.Anchor | undefined => {
        const s = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
        const a = raw && typeof raw === 'object' ? raw : undefined;
        const quote = s(a?.span?.quote, 512);
        const path = s(a?.path, 1024);

        // a drawn area: corners as fractions of the anchored element, x0 < x1 and y0 < y1; a text quote wins
        const g = a?.region;
        const k = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? Math.round(v * 1000) / 1000 : NaN);
        const box = g && typeof g === 'object' && { x0: k(g.x0), y0: k(g.y0), x1: k(g.x1), y1: k(g.y1) };
        const region = path && !quote && box && box.x0 < box.x1 && box.y0 < box.y1 ? box : undefined;
        const inside =
            region && Array.isArray(a.inside)
                ? a.inside
                      .map((v: unknown) => s(v, 200))
                      .filter(Boolean)
                      .slice(0, REGION_INSIDE_MAX)
                : [];

        // more elements Shift+clicked into the same comment
        const also =
            path && Array.isArray(a.also)
                ? a.also
                      .map(
                          (x: any) =>
                              x &&
                              typeof x === 'object' && {
                                  path: s(x.path, 1024),
                                  label: s(x.label, 128),
                                  snippet: s(x.snippet, 200),
                              },
                      )
                      .filter((x: any) => x?.path)
                      .slice(0, ANCHOR_ALSO_MAX)
                      .map((x: object) => JSON.parse(JSON.stringify(x)))
                : [];

        // where the comment was placed, as fractions of the anchored element's box; places its pin
        const at = a?.at && typeof a.at === 'object' && { x: k(a.at.x), y: k(a.at.y) };
        return (
            a && {
                path,
                label: s(a.label, 128),
                snippet: s(a.snippet, 200),
                ...(quote && { span: { quote } }),
                ...(region && { region }),
                ...(inside.length && { inside }),
                ...(also.length && { also }),
                ...(path && at && Number.isFinite(at.x) && Number.isFinite(at.y) && { at }),
            }
        );
    };

    // /api/*: the viewer shell on localhost; writes must come from the shell origin
    const shellApi = async (req: Req, res: ServerResponse, parts: string[]) => {
        const m = req.method;
        if (m !== 'GET' && req.headers.origin !== shellOrigin()) {
            return send(res, 403, 'cross-origin write refused');
        }
        if (parts[1] === 'artifacts' && m === 'GET') {
            return json(res, S.list().map(summary));
        }
        if (parts[1] === 'events') {
            const id = parts[2] ?? '*';
            if (id !== '*' && !S.exists(id)) {
                return notFound(res);
            }
            return sse(req, res, shellSse, id);
        }
        if (parts[1] !== 'a' || !S.exists(parts[2])) {
            return notFound(res);
        }
        const id = parts[2];
        const sub = parts[3];
        if (!sub && m === 'GET') {
            const meta = S.meta(id);
            return json(res, { ...meta, frameOrigin: frameOrigin(id), me: S.me(), presence: presence(id) });
        }
        if (!sub && m === 'DELETE') {
            S.remove(id);
            rooms.close(id);
            emit(shellSse, id, 'deleted', {});
            emit(frameSse, id, 'deleted', {});
            return json(res, { deleted: true });
        }
        if (sub === 'pin' && m === 'POST') {
            const b = await body(req);
            const meta = S.setPinned(id, b.on !== false);
            emit(shellSse, id, 'version', { ver: meta.ver, seq: meta.seq, by: 'claude' });
            return json(res, { pinned: !!meta.pinned });
        }
        // grants change only here: the shell's own origin, after the viewer answered its dialog or used its panel
        if (sub === 'grants') {
            if (m === 'GET') {
                return json(res, { grants: S.grants(id) });
            }
            if (m === 'POST') {
                const b = await body(req);
                if (typeof b.name !== 'string' || !GRANT_RE.test(b.name)) {
                    return send(res, 400, 'bad grant name');
                }
                const g = S.setGrant(id, b.name, b.on !== false);
                emit(frameSse, id, 'grants', { names: Object.keys(g) });
                return json(res, { grants: g });
            }
        }
        // room.sendToClaudeSession: the shell sends it after the viewer confirmed it in its own dialog, so a page cannot skip that
        if (sub === 'to-claude' && m === 'POST') {
            const meta = S.meta(id);
            if (!('room' in meta.capabilities)) {
                return json(res, { error: { code: 'not_granted', message: 'the artifact does not declare room' } });
            }
            const b = await body(req);
            const bad = checkJson(b.data, { max: 4096, depth: 8, entries: 64 });
            if (bad || !b.data || typeof b.data !== 'object' || Array.isArray(b.data) || !Object.keys(b.data).length) {
                return json(res, {
                    error: { code: 'invalid_argument', message: bad ?? 'data must be a non-empty plain object' },
                });
            }
            if (presence(id) === 'none') {
                return json(res, {
                    error: { code: 'claude_unavailable', message: 'no Claude session is linked to this artifact' },
                });
            }
            if (Date.now() - (sendTimes.get(id) ?? 0) < 3000) {
                return json(res, {
                    error: { code: 'rate_limited', message: 'sends are held to a human cadence; try again shortly' },
                });
            }
            sendTimes.set(id, Date.now());
            const pres =
                b.presence && typeof b.presence === 'object' && !checkJson(b.presence)
                    ? (({ cursor, who, ...rest }) => rest)(b.presence)
                    : undefined;
            const x = S.addPageSend(
                id,
                pres && Object.keys(pres).length ? { data: b.data, presence: pres } : { data: b.data },
            );
            return json(res, { id: x.id, to: 'session' });
        }
        // the viewer confirmed one mcp call in the shell: a token good for that exact call, once, for a minute
        if (sub === 'mcp-approve' && m === 'POST') {
            const b = await body(req);
            if (typeof b.server !== 'string' || typeof b.tool !== 'string') {
                return send(res, 400, 'server and tool required');
            }
            const token = randomBytes(16).toString('hex');
            approvals.set(token, { id, what: callKey(b.server, b.tool, b.input), until: Date.now() + 60000 });
            return json(res, { token });
        }
        // a project file the viewer confirmed saving in the shell's own dialog; never handed to the page
        if (sub === 'files' && m === 'GET' && (parts[4] === 'stat' || parts[4] === 'raw')) {
            // only the viewer's own link starts the save; another page (an artifact's own origin included) cannot
            const site = req.headers['sec-fetch-site'];
            if (site !== undefined && site !== 'same-origin') {
                return send(res, 403, 'cross-site file request refused');
            }
            const meta = S.meta(id);
            const root = projectOf(meta);
            if (!root || !S.granted(id, 'files')) {
                return send(res, 403, 'the viewer has not allowed this artifact to read project files');
            }
            const r = F.downloadable(root, new URL(req.url ?? '', 'http://x').searchParams.get('path') ?? '');
            if ('error' in r) {
                return json(res, r);
            }
            if (parts[4] === 'stat') {
                return json(res, { path: r.rel, size: r.size });
            }
            return serveFile(res, r.file, 'application/octet-stream', {
                'content-disposition': `attachment; filename="${encodeURIComponent(r.rel.split('/').at(-1) ?? '')}"`,
            });
        }
        if (sub !== 'comments') {
            return notFound(res);
        }
        const tid = parts[4];
        const changed = (x: unknown) => {
            emit(shellSse, id, 'comments', {});
            return x ? json(res, x) : notFound(res);
        };
        if (!tid && m === 'GET') {
            return json(res, { threads: S.threads(id).map((t) => ({ ...t, claude: S.claudeStatus(t) })), me: S.me() });
        }
        if (tid && parts[5] === 'image' && m === 'GET') {
            const img = S.threadImage(id, tid, Number(parts[6] ?? 0) || 0);
            return img ? serveFile(res, img.file, img.type) : notFound(res);
        }
        if (tid && parts[5] === 'attach' && m === 'GET') {
            const img = S.commentAttachment(id, tid, parts[6] ?? '', Number(parts[7]) || 0);
            return img ? serveFile(res, img.file, img.type) : notFound(res);
        }
        if (!tid && m === 'POST') {
            const b = await body(req);
            if (typeof b.text !== 'string' || !b.text.trim()) {
                return send(res, 400, 'text required');
            }
            const anchor = cleanAnchor(b.anchor);
            const path = anchor?.path;
            const meta = S.meta(id);
            const ver = meta.versions.some((v) => v.ver === b.ver) ? b.ver : meta.ver;
            const r = S.newThread(id, b.text, anchor, ver, undefined, Array.isArray(b.images) ? b.images : undefined);

            // a drawn area or a clicked object can bring a capture of it as the viewer saw it (a 3d scene's canvas)
            const img = path && S.commentImage(b.image);
            if (r && img) {
                S.setThreadImage(id, r.thread.id, img);
            }

            // and each Shift-picked anchor its own, in the order of `also`
            for (const [i, v] of (Array.isArray(b.also_images)
                ? b.also_images.slice(0, anchor?.also?.length ?? 0)
                : []
            ).entries()) {
                const x = S.commentImage(v);
                if (r && x) {
                    S.setThreadImage(id, r.thread.id, x, i + 1);
                }
            }
            if (r && b.toClaude) {
                S.sendToClaude(id, r.thread.id);
            }
            return changed(r && S.threads(id).find((t) => t.id === r.thread.id));
        }
        if (tid && !parts[5] && m === 'POST') {
            const b = await body(req);
            if (typeof b.text !== 'string' || !b.text.trim()) {
                return send(res, 400, 'text required');
            }
            const images = Array.isArray(b.images) ? b.images : undefined;
            return changed(S.addComment(id, tid, 'user', b.text, !!b.toClaude, undefined, images)?.thread);
        }
        if (tid && !parts[5] && m === 'DELETE') {
            S.deleteThread(id, tid);
            return changed({ deleted: true });
        }
        if (parts[5] === 'send' && m === 'POST') {
            return changed(S.sendToClaude(id, tid));
        }
        if (parts[5] === 'resolve' && m === 'POST') {
            const b = await body(req);
            return changed(S.resolveThread(id, tid, b.resolved !== false, 'user'));
        }
        return notFound(res);
    };

    // the comments capability: a page writes threads as the viewer, once the viewer allowed it in the shell. errors come back
    // as { error: { code, message } } in the original's codes; `@claude` in page text never activates a thread
    const pageWrites = new Map<string, number[]>();
    const PAGE_WRITES_PER_MIN = 30;
    // eslint-disable-next-line no-control-regex -- rejects control characters
    const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
    const textErr = (t: unknown) =>
        typeof t !== 'string' || !t.trim()
            ? 'text is empty'
            : Buffer.byteLength(t) > 4096
              ? 'text is over 4 KiB as UTF-8'
              : CONTROL_RE.test(t)
                ? 'text carries control characters other than newlines and tabs'
                : '';
    const frameComments = async (req: Req, res: ServerResponse, id: string, meta: S.Meta, rest: string) => {
        const m = req.method;
        const cfg: any = meta.capabilities['comments'] ?? {};
        const err = (code: string, message: string) => json(res, { error: { code, message } });
        if (rest === '/can-send' && m === 'GET') {
            return json(res, {
                state: cfg.composer_only === true ? 'off' : presence(id) === 'none' ? 'no_session' : 'available',
            });
        }
        if (cfg.composer_only === true) {
            return err('not_granted', 'the artifact declares comments composer_only, which grants no write verbs');
        }
        if (!S.granted(id, 'comments')) {
            return err('consent_required', 'the viewer has not allowed this page to comment as them');
        }
        const now = Date.now();
        const recent = (pageWrites.get(id) ?? []).filter((t) => now - t < 60000);
        if (recent.length >= PAGE_WRITES_PER_MIN) {
            return err('rate_limited', 'writing too often; slow down');
        }
        pageWrites.set(id, [...recent, now]);
        const b = m === 'GET' || m === 'DELETE' ? {} : await body(req);
        const toClaude = b.toClaude === true;
        if (toClaude && presence(id) === 'none') {
            return err('claude_unavailable', 'no Claude session is linked to this artifact; nothing was posted');
        }
        const done = (x: unknown) => (emit(shellSse, id, 'comments', {}), json(res, x));
        if (rest === '' && m === 'POST') {
            const bad = textErr(b.text);
            if (bad) {
                return err('invalid', bad);
            }
            const anchor = cleanAnchor(b.anchor);
            if (!anchor?.path) {
                return err('invalid', 'anchor needs a path');
            }
            const r = S.newThread(id, b.text, anchor, meta.ver, 'page');
            if (!r) {
                return err('not_found', 'no such thread');
            }
            if (toClaude) {
                S.sendToClaude(id, r.thread.id);
            }
            return done({ threadId: r.thread.id, commentId: r.comment.id });
        }
        const [, tid, verb] = rest.split('/');
        if (!tid || !UUID_RE.test(tid)) {
            return err('invalid', 'malformed threadId');
        }
        if (!S.threads(id).some((t) => t.id === tid)) {
            return err('not_found', 'no such thread');
        }
        if (verb === 'reply' && m === 'POST') {
            const bad = textErr(b.text);
            if (bad) {
                return err('invalid', bad);
            }
            const r = S.addComment(id, tid, 'user', b.text, toClaude, 'page');
            if (!r) {
                return err('not_found', 'no such thread');
            }
            return done({ threadId: tid, commentId: r.comment.id });
        }
        if (verb === 'resolve' && m === 'POST') {
            return done((S.resolveThread(id, tid, b.resolved !== false, 'user'), {}));
        }
        if (!verb && m === 'DELETE') {
            return done((S.deleteThread(id, tid), {}));
        }
        return notFound(res);
    };

    // the mcp capability: the page's manifest names `host:<name>` servers and their tools; each server is the viewer's to allow,
    // and a tool not marked read-only runs only with a one-time approval the viewer gave in the shell for that exact call
    const manifestOf = (meta: S.Meta) => {
        const c: any = meta.capabilities['mcp'] ?? {};
        return {
            project: typeof c.project === 'string' ? c.project : '',
            servers: (Array.isArray(c.servers) ? c.servers : []) as { server: string; tools: string[] }[],
        };
    };
    const frameMcp = async (id: string, meta: S.Meta, verb: string, b: any) => {
        const { project, servers } = manifestOf(meta);
        const entry = (srv: unknown) => servers.find((x) => x.server === srv);
        const err = (code: string, message: string, extra: object = {}) => ({ error: { code, message, ...extra } });
        try {
            if (verb === 'list') {
                const out = [];
                for (const x of servers.filter((x) => b.server === undefined || x.server === b.server)) {
                    if (!S.granted(id, `mcp:${x.server}`)) {
                        out.push({
                            server: x.server,
                            authStatus: 'unknown',
                            tools: x.tools.map((name) => ({ name, description: '' })),
                        });
                        continue;
                    }
                    const all = await hosts_.tools(project, x.server).catch(() => undefined);
                    if (!all) {
                        continue;
                    }
                    out.push({
                        server: x.server,
                        authStatus: 'connected',
                        tools: all
                            .filter((t) => x.tools.includes(t.name))
                            .map((t) => ({
                                name: t.name,
                                description: t.description ?? '',
                                ...(t.annotations && {
                                    annotations: {
                                        ...('readOnlyHint' in t.annotations && {
                                            readOnlyHint: t.annotations['readOnlyHint'],
                                        }),
                                        ...('destructiveHint' in t.annotations && {
                                            destructiveHint: t.annotations['destructiveHint'],
                                        }),
                                    },
                                }),
                            })),
                    });
                }
                return { servers: out };
            }
            const x = entry(b.server);
            if (typeof b.server !== 'string' || typeof b.tool !== 'string') {
                return err('bad_request', 'server and tool must be strings');
            }
            if (!x || !x.tools.includes(b.tool)) {
                return err('not_in_manifest', `${b.server} / ${b.tool} is not in this artifact's manifest`, {
                    server: b.server,
                });
            }
            if (!S.granted(id, `mcp:${x.server}`)) {
                return err('not_in_manifest', `the viewer has not allowed ${x.server} for this page`, {
                    server: x.server,
                });
            }
            const tool = (await hosts_.tools(project, x.server)).find((t) => t.name === b.tool);
            if (!tool) {
                return err('not_in_manifest', `${x.server} no longer lists ${b.tool}`, { server: x.server });
            }
            if (verb === 'describe') {
                return {
                    name: tool.name,
                    description: tool.description ?? '',
                    inputSchema: tool.inputSchema ?? { type: 'object' },
                    ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema }),
                    ...(tool.annotations && { annotations: tool.annotations }),
                };
            }
            if (verb !== 'call') {
                return err('bad_request', 'unknown method');
            }
            if (tool.annotations?.['readOnlyHint'] !== true) {
                const a = typeof b.approval === 'string' ? approvals.get(b.approval) : undefined;
                if (!a || a.id !== id || a.until < Date.now() || a.what !== callKey(x.server, b.tool, b.input)) {
                    return err('confirm_required', 'the viewer must confirm this call');
                }
                approvals.delete(b.approval);
            }
            return await hosts_.call(project, x.server, b.tool, b.input);
        } catch (e: any) {
            return err(e?.code ?? 'upstream_error', e?.message ?? String(e), {
                server: b.server,
                ...(e?.retryable && { retryable: true }),
                ...(e?.result !== undefined && { result: e.result }),
            });
        }
    };

    // the files capability: the project folder the artifact declares, read as the viewer once they allowed it
    const projectOf = (meta: S.Meta) => {
        const p = (meta.capabilities['files'] as any)?.project;
        return typeof p === 'string' && p ? p : undefined;
    };
    const fileCalls = new Map<string, number[]>();
    const frameFiles = async (req: Req, res: ServerResponse, id: string, meta: S.Meta, verb: string) => {
        const root = projectOf(meta);
        const b = await body(req);
        if (!root) {
            return json(res, { error: { code: 'unavailable', message: 'the artifact declares no project folder' } });
        }
        if (!S.granted(id, 'files')) {
            return json(res, {
                error: { code: 'not_granted', message: 'the viewer has not allowed this page to read project files' },
            });
        }
        const now = Date.now();
        const recent = (fileCalls.get(id) ?? []).filter((t) => now - t < 10000);
        if (recent.length >= 200) {
            return json(res, {
                error: { code: 'rate_limited', message: 'too many calls', retryAfterMs: 10000 - (now - recent[0]) },
            });
        }
        fileCalls.set(id, [...recent, now]);
        if (verb === 'list') {
            return json(res, F.list(root, b));
        }
        if (verb === 'stat') {
            const r = F.downloadable(root, b.path);
            return json(res, 'error' in r ? r : { size: r.size });
        }
        if (verb === 'read') {
            const r = F.read(root, b.path, b.offset, b.length);
            if ('error' in r) {
                return json(res, r);
            }
            return send(res, 200, r.bytes, {
                'content-type': 'application/octet-stream',
                'x-size': String(r.size),
                'x-revision': r.revision,
            });
        }
        return notFound(res);
    };

    // <uuid>.localhost: the artifact page, its files and assets, and the page runtime api
    const frame = async (req: Req, res: ServerResponse, id: string, path: string) => {
        if (!S.exists(id)) {
            return notFound(res);
        }
        const meta = S.meta(id);
        const m = req.method;
        const caps = Object.keys(meta.capabilities ?? {}).filter((c) => CAPABILITIES.includes(c));
        if (path === '/' || path === '') {
            return send(res, 302, '', { location: `/v/${meta.ver}/` });
        }
        if (path === '/_frame/runtime.js') {
            return serveFile(res, join(WEB, 'runtime.js'), 'text/javascript', frameHeaders());
        }
        if (path === '/_frame/caps.js') {
            return serveFile(res, join(WEB, 'caps.js'), 'text/javascript', frameHeaders());
        }
        if (path.startsWith(SCENE_ROUTE) && SCENE_FILES.includes(path.slice(SCENE_ROUTE.length))) {
            return serveFile(res, join(SCENE_DIR, path.slice(SCENE_ROUTE.length)), 'text/javascript', frameHeaders());
        }
        if (path.startsWith('/_blob/')) {
            const aid = path.slice(7);
            const a = ASSET_ID_RE.test(aid) && S.assets(id).find((x) => x.id === aid);
            return a ? serveFile(res, S.assetPath(id, aid), a.contentType, frameHeaders()) : notFound(res);
        }
        if (path.startsWith('/_frame/')) {
            if (m !== 'GET' && req.headers.origin !== frameOrigin(id)) {
                return send(res, 403, 'cross-origin write refused');
            }
            const need = (c: string) =>
                caps.includes(c) ||
                (c === 'artifact' && caps.includes('self')) ||
                (send(res, 403, `the page does not declare the ${c} capability`), false);
            if (path === '/_frame/events') {
                return sse(req, res, frameSse, id);
            }
            if (path === '/_frame/api/diag' && m === 'POST') {
                const b = await body(req);
                if (Array.isArray(b.entries)) {
                    S.addDiag(id, b.ver, b.entries.slice(0, 100));
                }
                return json(res, { ok: true });
            }
            if (path.startsWith('/_frame/room/') && need('room')) {
                const verb = path.slice('/_frame/room/'.length);
                if (verb === 'connect' && m === 'GET') {
                    return void rooms.connect(
                        id,
                        res,
                        caps.includes('user') ? S.me().id : null,
                        new URL(req.url ?? '', 'http://x').searchParams.get('peer'),
                    );
                }
                if (verb === 'can-send' && m === 'GET') {
                    return json(res, { state: presence(id) === 'none' ? 'no_session' : 'available_if_summoned' });
                }
                if (m !== 'POST') {
                    return notFound(res);
                }
                const b = await body(req);
                if (verb === 'emit') {
                    return json(res, rooms.emit(id, b));
                }
                if (verb === 'presence') {
                    return json(res, rooms.presence(id, b));
                }
                if (verb === 'join') {
                    return json(res, rooms.join(id, b));
                }
                if (verb === 'leave') {
                    return json(res, rooms.leave(id, b));
                }
                return notFound(res);
            }
            if (path.startsWith('/_frame/api/mcp/') && m === 'POST' && need('mcp')) {
                return json(res, await frameMcp(id, meta, path.slice('/_frame/api/mcp/'.length), await body(req)));
            }
            if (path.startsWith('/_frame/api/files/') && m === 'POST' && need('files')) {
                return frameFiles(req, res, id, meta, path.slice('/_frame/api/files/'.length));
            }
            if (path.startsWith('/_frame/api/comments') && need('comments')) {
                return frameComments(req, res, id, meta, path.slice('/_frame/api/comments'.length));
            }
            if (path === '/_frame/api/grants' && m === 'GET') {
                return json(res, { granted: Object.keys(S.grants(id)) });
            }
            // the page's own declaration, less the folders on this machine that files and mcp resolved
            if (path === '/_frame/api/caps' && m === 'GET') {
                return json(res, {
                    capabilities: Object.fromEntries(
                        Object.entries(meta.capabilities ?? {}).map(([k, v]: [string, any]) => [
                            k,
                            v && typeof v === 'object' && 'project' in v ? (({ project, ...rest }) => rest)(v) : v,
                        ]),
                    ),
                });
            }
            if (path === '/_frame/api/user' && need('user')) {
                return json(res, S.me());
            }
            if (path === '/_frame/api/db' && m === 'POST' && need('db')) {
                const b = await body(req);
                if (b.verb === 'whoami' && !caps.includes('user')) {
                    return send(res, 403, 'the page does not declare the user capability');
                }
                return json(res, dbCall(id, b.verb, b.args ?? {}));
            }
            if (path === '/_frame/api/assets' && need('assets')) {
                if (m === 'GET') {
                    return json(
                        res,
                        S.assets(id).map((a) => ({ ...a, url: `/_blob/${a.id}` })),
                    );
                }
                if (m === 'POST') {
                    const data = await readBody(req);
                    const name = decodeURIComponent(String(req.headers['x-name'] ?? 'upload'));
                    const a = S.addAsset(
                        id,
                        name,
                        String(req.headers['content-type'] ?? 'application/octet-stream'),
                        data,
                    );
                    return json(res, { ...a, url: `/_blob/${a.id}` });
                }
            }
            if (path === '/_frame/api/publish' && m === 'POST' && need('artifact')) {
                const b = await body(req);
                // a page that sends its live DOM would otherwise carry the injected runtime tag
                const html = wrapHtml(
                    String(b.html ?? '').replace(/<script src="\/_frame\/runtime\.js"[^>]*><\/script>/g, ''),
                );
                if (Buffer.byteLength(html) > MAX_PAGE_BYTES) {
                    return send(res, 413, 'too large: a page is at most 16MB');
                }
                const save = typeof b.save === 'string' ? b.save.slice(0, 64) : undefined;
                const r = doPublish({
                    id,
                    title: findTitle(html) ?? meta.title,
                    html,
                    by: 'page',
                    baseVersion: b.baseVersion,
                    save,
                });
                return json(res, r.body, r.status);
            }
            return res.headersSent ? undefined : notFound(res);
        }
        const v = path.match(/^\/v\/([0-9a-f]{12})\/(.*)$/);
        if (!v) {
            return notFound(res);
        }
        const [, ver, rest] = v;
        if (!meta.versions.some((x) => x.ver === ver)) {
            return notFound(res);
        }
        const vdir = S.versionDir(id, ver);
        if (rest === '' || rest === 'index.html') {
            const tag = `<script src="/_frame/runtime.js" data-id="${id}" data-ver="${ver}" data-caps="${caps.join(',')}" data-shell="${shellOrigin()}"></script>`;
            return send(res, 200, injectRuntime(readFileSync(join(vdir, 'index.html'), 'utf8'), tag), {
                ...frameHeaders(),
                'content-type': 'text/html; charset=utf-8',
            });
        }
        const file = S.inside(vdir, decodeURIComponent(rest));
        const entry = meta.versions.find((x) => x.ver === ver)?.files.find((f) => f.path === decodeURIComponent(rest));
        return file && entry ? serveFile(res, file, entry.contentType, frameHeaders()) : notFound(res);
    };

    const handle = async (req: Req, res: ServerResponse) => {
        const host = (req.headers.host ?? '').toLowerCase();
        const [name, p] = host.split(':');
        if (p !== String(port)) {
            return send(res, 421, 'wrong host');
        }
        const u = new URL(req.url ?? '/', `http://${host}`);
        const parts = u.pathname.split('/').filter(Boolean);
        const sub = name.endsWith('.localhost') ? name.slice(0, -'.localhost'.length) : undefined;
        if (sub !== undefined) {
            return UUID_RE.test(sub) ? frame(req, res, sub, u.pathname) : send(res, 421, 'wrong host');
        }
        if (name !== 'localhost' && name !== '127.0.0.1') {
            return send(res, 421, 'wrong host');
        }
        if (parts[0] === '_agent') {
            return agent(req, res, parts, u.searchParams);
        }
        if (name === '127.0.0.1' && parts[0] !== '_agent') {
            return send(res, 302, '', { location: `${shellOrigin()}${u.pathname}${u.search}` });
        }
        if (parts[0] === 'api') {
            return shellApi(req, res, parts);
        }
        if (parts[0] === '_static' && parts.length === 2 && /^[a-z]+\.(js|css|svg)$/.test(parts[1])) {
            return serveFile(res, join(WEB, parts[1]));
        }
        if (u.pathname === '/' || u.pathname === '/code' || u.pathname === '/code/') {
            return send(res, 302, '', { location: '/code/artifacts' });
        }
        if (
            u.pathname === '/code/artifacts' ||
            (parts[0] === 'code' && parts[1] === 'artifact' && UUID_RE.test(parts[2] ?? ''))
        ) {
            return serveFile(res, join(WEB, 'viewer.html'), 'text/html; charset=utf-8', {
                'content-security-policy': `default-src 'self'; frame-src http://*.localhost:${port}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
                'x-frame-options': 'DENY',
            });
        }
        return notFound(res);
    };

    const server = createServer((req, res) => {
        handle(req as Req, res).catch((e) => {
            if (!res.headersSent) {
                send(res, e?.status ?? 500, String(e?.message ?? e));
            } else {
                res.end();
            }
        });
    });

    return new Promise<{ port: number; token: string; close: () => Promise<void> }>((ok, bad) => {
        server.once('error', bad);
        server.listen(port, HOST, () => {
            port = (server.address() as { port: number }).port;
            ok({
                port,
                token,
                close: () =>
                    new Promise((r) => {
                        clearInterval(sweeper);
                        hosts_.closeAll();
                        for (const c of [...shellSse, ...frameSse]) {
                            c.res.end();
                        }
                        server.close(() => r());
                    }),
            });
        });
    });
};

// run as a process: `node daemon.ts` writes server.json for clients to find it
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { writeAtomic } = S;
    const { port, token } = await startDaemon();
    const { chmodSync } = await import('node:fs');
    const file = join(HOME, 'server.json');
    writeAtomic(file, JSON.stringify({ pid: process.pid, port, token }));
    chmodSync(file, 0o600);
    console.log(`spatial-artifacts daemon on http://localhost:${port}`);
}
