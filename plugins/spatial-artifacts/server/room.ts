// the room capability: everyone with an artifact open right now, one peer per open document (tab). moments on topics and
// presence objects are relayed and never stored; named rooms group peers inside the lobby. the one local person owns every
// artifact, so every topic is open to them; the budget and size bounds are the original's
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
export const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const DATA_MAX = 4096;
const ROOMS_MAX = 16;
const RATE_PER_S = 40;
const BURST = 80;
const LOBBY = '';

type Peer = {
    peer: string;
    by: string | null;
    res: ServerResponse;
    rooms: Set<string>;
    presence: Map<string, Record<string, unknown>>;
    tokens: number;
    at: number;
};
type Err = { code: string; message: string };

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null));
const FORBIDDEN_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype).concat('prototype'));

/** checks a presence or sendToClaudeSession object: identifier keys, plain JSON, bounded depth, size and string content */
export const checkJson = (
    v: unknown,
    opts: { depth?: number; max?: number; entries?: number } = {},
): string | undefined => {
    const depth = opts.depth ?? 8;
    const walk = (x: unknown, d: number): string | undefined => {
        if (d > depth) {
            return `nesting is deeper than ${depth}`;
        }
        if (x === null || typeof x === 'boolean') {
            return;
        }
        if (typeof x === 'number') {
            return Number.isFinite(x) ? undefined : 'numbers must be finite';
        }
        if (typeof x === 'string') {
            if (x.length > 1024) {
                return 'a string is over 1 KiB';
            }
            // eslint-disable-next-line no-control-regex -- rejects control characters
            if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-]/.test(x)) {
                return 'a string carries control or private-use characters';
            }
            return;
        }
        if (Array.isArray(x)) {
            if (opts.entries && x.length > opts.entries) {
                return `an array has more than ${opts.entries} entries`;
            }
            for (const y of x) {
                const e = walk(y, d + 1);
                if (e) {
                    return e;
                }
            }
            return;
        }
        if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
            const keys = Object.keys(x as object);
            if (opts.entries && keys.length > opts.entries) {
                return `an object has more than ${opts.entries} keys`;
            }
            for (const k of keys) {
                if (!KEY_RE.test(k) || FORBIDDEN_KEYS.has(k)) {
                    return `key "${k.slice(0, 40)}" is not a plain identifier`;
                }
                const e = walk((x as Record<string, unknown>)[k], d + 1);
                if (e) {
                    return e;
                }
            }
            return;
        }
        return 'only plain JSON values are allowed';
    };
    const e = walk(v, 1);
    if (e) {
        return e;
    }
    return bytes(v) > (opts.max ?? DATA_MAX) ? `over ${opts.max ?? DATA_MAX} bytes of JSON` : undefined;
};

export const createRooms = () => {
    // artifact id -> peer label -> peer
    const all = new Map<string, Map<string, Peer>>();
    const peersOf = (id: string) => {
        let m = all.get(id);
        if (!m) {
            all.set(id, (m = new Map()));
        }
        return m;
    };
    const write = (p: Peer, event: string, data: unknown) =>
        p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const view = (p: Peer, room: string) => ({ peer: p.peer, by: p.by, presence: p.presence.get(room) ?? {} });
    const members = (id: string, room: string) =>
        [...peersOf(id).values()].filter((p) => room === LOBBY || p.rooms.has(room));
    const broadcast = (id: string, room: string, event: string, data: unknown) => {
        for (const p of members(id, room)) {
            write(p, event, { room, ...(data as object) });
        }
    };

    // a reconnecting document asks for its label back, so `peer` stays stable for that document's life
    const connect = (id: string, res: ServerResponse, by: string | null, want?: string | null) => {
        const reuse = want && /^[a-z0-9]{16}$/.test(want) && !peersOf(id).has(want);
        const peer = reuse
            ? want
            : randomBytes(10)
                  .toString('base64url')
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, '')
                  .padEnd(16, 'x')
                  .slice(0, 16);
        const p: Peer = { peer, by, res, rooms: new Set(), presence: new Map(), tokens: BURST, at: Date.now() };
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
        });
        const others = members(id, LOBBY);
        peersOf(id).set(peer, p);
        write(p, 'hello', { peer, peers: [...others, p].map((x) => view(x, LOBBY)) });
        broadcast(id, LOBBY, 'joined', view(p, LOBBY));
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        res.on('close', () => {
            clearInterval(ping);
            peersOf(id).delete(peer);
            for (const r of p.rooms) {
                broadcast(id, r, 'left', { peer });
            }
            broadcast(id, LOBBY, 'left', { peer });
        });
        return peer;
    };

    // a token bucket per peer, shared by emits and presence: about 40 a second, bursts of 80
    const spend = (p: Peer) => {
        const now = Date.now();
        p.tokens = Math.min(BURST, p.tokens + ((now - p.at) / 1000) * RATE_PER_S);
        p.at = now;
        if (p.tokens < 1) {
            return false;
        }
        p.tokens--;
        return true;
    };

    const get = (id: string, peer: unknown, room: unknown): { p: Peer; room: string } | { error: Err } => {
        const p = typeof peer === 'string' ? peersOf(id).get(peer) : undefined;
        if (!p) {
            return { error: { code: 'upstream_error', message: 'not connected to the room' } };
        }
        const r = room === undefined || room === null ? LOBBY : String(room);
        if (r !== LOBBY && !p.rooms.has(r)) {
            return { error: { code: 'invalid_argument', message: `not in room "${r.slice(0, 48)}"` } };
        }
        return { p, room: r };
    };

    const emit = (id: string, b: any): { ok: true; dropped?: boolean } | { error: Err } => {
        const g = get(id, b.peer, b.room);
        if ('error' in g) {
            return g;
        }
        if (typeof b.topic !== 'string' || !TOPIC_RE.test(b.topic)) {
            return { error: { code: 'invalid_argument', message: 'topic must match ^[a-z][a-z0-9_.-]{0,47}$' } };
        }
        if (b.data !== undefined && bytes(b.data) > DATA_MAX) {
            return { error: { code: 'invalid_argument', message: `data is over ${DATA_MAX} bytes of JSON` } };
        }
        if (!spend(g.p)) {
            return { ok: true, dropped: true };
        }
        broadcast(id, g.room, 'msg', { topic: b.topic, data: b.data, peer: g.p.peer, by: g.p.by });
        return { ok: true };
    };

    const presence = (id: string, b: any): { ok: true } | { error: Err } => {
        const g = get(id, b.peer, b.room);
        if ('error' in g) {
            return g;
        }
        const bad = checkJson(b.presence);
        if (bad || !b.presence || typeof b.presence !== 'object' || Array.isArray(b.presence)) {
            return { error: { code: 'invalid_argument', message: `presence: ${bad ?? 'must be an object'}` } };
        }
        if (!spend(g.p)) {
            g.p.tokens = 0;
        }
        g.p.presence.set(g.room, b.presence);
        broadcast(id, g.room, 'presence', view(g.p, g.room));
        return { ok: true };
    };

    const join = (id: string, b: any): { peers: unknown[] } | { error: Err } => {
        const g = get(id, b.peer, undefined);
        if ('error' in g) {
            return g;
        }
        if (typeof b.name !== 'string' || !ROOM_RE.test(b.name)) {
            return { error: { code: 'invalid_argument', message: 'name must match ^[a-z0-9][a-z0-9_.-]{0,47}$' } };
        }
        if (!g.p.rooms.has(b.name)) {
            if (g.p.rooms.size >= ROOMS_MAX) {
                return { error: { code: 'limit_reached', message: `this page is already in ${ROOMS_MAX} rooms` } };
            }
            g.p.rooms.add(b.name);
            broadcast(id, b.name, 'joined', view(g.p, b.name));
        }
        return { peers: members(id, b.name).map((x) => view(x, b.name)) };
    };

    const leave = (id: string, b: any): { ok: true } | { error: Err } => {
        const g = get(id, b.peer, undefined);
        if ('error' in g) {
            return g;
        }
        if (typeof b.name === 'string' && g.p.rooms.delete(b.name)) {
            g.p.presence.delete(b.name);
            broadcast(id, b.name, 'left', { peer: g.p.peer });
        }
        return { ok: true };
    };

    /** ends every connection to an artifact (it was deleted or republished: a new version empties the room) */
    const close = (id: string) => {
        for (const p of peersOf(id).values()) {
            p.res.end();
        }
        all.delete(id);
    };

    return { connect, emit, presence, join, leave, close, count: (id: string) => peersOf(id).size };
};
