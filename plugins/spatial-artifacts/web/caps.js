// the capabilities that reach past the page: files, mcp, room and sample. runtime.js imports this on first use and
// hands it its helpers; every call that acts as the viewer is asked in the viewer first and checked again by the daemon.
// never throws into the page: every verb rejects with { code, message } in the original's codes

export const boot = (ctx) => {
    const { call, fail, traced, toParent, onShell, consentFor, stringify, userActive } = ctx;
    const settle = (fn) => Promise.resolve().then(fn);
    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const post = (path, data, init = {}) =>
        call(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: stringify(data ?? {}),
            ...init,
        });
    const checked = (r) => {
        if (r && r.error) {
            throw fail(
                r.error.code,
                r.error.message,
                r.error.retryAfterMs !== undefined ? { retryAfterMs: r.error.retryAfterMs } : {},
            );
        }
        return r;
    };

    // one confirmation at a time in the viewer, for an action the viewer approves each time (a download, a write tool, a send)
    let confirmSeq = 0;
    const confirms = new Map();
    onShell('confirm-result', (m) => {
        const ok = confirms.get(m.id);
        if (ok) {
            confirms.delete(m.id);
            ok(m);
        }
    });
    const confirm = (kind, detail) =>
        new Promise((ok) => {
            if (!ctx.framed) {
                return ok({ result: 'unavailable' });
            }
            const id = ++confirmSeq;
            confirms.set(id, ok);
            toParent({ type: 'confirm', id, kind, ...detail });
        });

    // ---- files -----------------------------------------------------------

    const files = (() => {
        const gate = async () => {
            const st = await consentFor('files');
            if (st === 'granted') {
                return;
            }
            if (st === 'denied') {
                throw fail('not_granted', 'the viewer chose not to allow access to project files');
            }
            throw fail('rate_limited', 'the permission prompt ended without a decision', { retryAfterMs: 2000 });
        };
        const list = (options = {}) =>
            traced(
                'files.list',
                settle(async () => {
                    if (!isObj(options)) {
                        throw fail('bad_request', 'options must be an object');
                    }
                    await gate();
                    return checked(
                        await post('/_frame/api/files/list', {
                            path: options.path,
                            recursive: options.recursive === true,
                            cursor: options.cursor,
                        }),
                    );
                }),
            );
        const read = (path, options = {}) =>
            traced(
                'files.read',
                settle(async () => {
                    if (typeof path !== 'string') {
                        throw fail('bad_request', 'path must be a string');
                    }
                    if (!isObj(options)) {
                        throw fail('bad_request', 'options must be an object');
                    }
                    await gate();
                    const r = await ctx
                        .fetch('/_frame/api/files/read', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: stringify({ path, offset: options.offset, length: options.length }),
                        })
                        .catch((e) => {
                            throw fail('unavailable', String(e && e.message));
                        });
                    if ((r.headers.get('content-type') || '').includes('json')) {
                        checked(await r.json());
                    }
                    if (!r.ok) {
                        throw fail('unavailable', `HTTP ${r.status}`);
                    }
                    return {
                        bytes: new Uint8Array(await r.arrayBuffer()),
                        size: Number(r.headers.get('x-size')),
                        revision: r.headers.get('x-revision') || '',
                    };
                }),
            );
        let saving = false;
        const download = (path) =>
            traced(
                'files.download',
                settle(async () => {
                    if (typeof path !== 'string' || !path) {
                        throw fail('bad_request', 'path must be a string');
                    }
                    await gate();
                    checked(await post('/_frame/api/files/stat', { path }));
                    if (saving) {
                        throw fail('rate_limited', 'a save prompt is already open');
                    }
                    saving = true;
                    try {
                        const r = await confirm('file-download', { path });
                        if (r.result === 'allow') {
                            return { status: 'saved' };
                        }
                        if (r.result === 'error') {
                            throw fail(r.code || 'unavailable', r.message || 'the file could not be offered');
                        }
                        if (r.result === 'busy') {
                            throw fail('rate_limited', 'another prompt is open', { retryAfterMs: 2000 });
                        }
                        throw fail('declined', 'the viewer did not save the file');
                    } finally {
                        saving = false;
                    }
                }),
            );
        const TEXT_MAX = 12 * 1024;
        const asSampleTools = () =>
            settle(() => [
                {
                    name: 'list_project_files',
                    description:
                        'Lists files and folders in the project. Input: optional `path` (a folder, from an earlier listing) and `recursive`. Returns entries {path, isDirectory, size}.',
                    inputSchema: {
                        type: 'object',
                        properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
                    },
                    execute: async (input) => {
                        const r = await list({
                            path: input && input.path !== undefined ? String(input.path) : undefined,
                            recursive: !!(input && input.recursive),
                        });
                        return {
                            entries: r.entries
                                .slice(0, 200)
                                .map((e) => ({ path: e.path, isDirectory: e.isDirectory, size: e.size })),
                            more: r.entries.length > 200 || !!r.cursor,
                        };
                    },
                },
                {
                    name: 'read_project_file',
                    description:
                        'Reads a text file in the project, up to about 12 KB from `offset` (default 0). Returns {text, size, truncated}.',
                    inputSchema: {
                        type: 'object',
                        properties: { path: { type: 'string' }, offset: { type: 'integer' } },
                        required: ['path'],
                    },
                    execute: async (input) => {
                        const offset = Math.max(0, Number(input && input.offset) || 0);
                        const r = await read(String(input && input.path), { offset, length: TEXT_MAX });
                        return {
                            text: new TextDecoder().decode(r.bytes),
                            size: r.size,
                            truncated: offset + r.bytes.length < r.size,
                        };
                    },
                },
            ]);
        return Object.freeze({ list, read, download, asSampleTools });
    })();

    // ---- room ------------------------------------------------------------

    const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
    const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
    const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
    const jsonBytes = (v) => new TextEncoder().encode(stringify(v ?? null)).length;
    const rejectArg = (msg) => Promise.reject(fail('invalid_argument', msg));

    const room = (() => {
        let peer = null;
        let up = false;
        let es = null;
        let retry = 0;
        let dropReported = false;
        const conn = new Set();
        // per room ('' is the lobby): the peers there and the listeners
        const R = new Map();
        const stateOf = (name) => {
            if (!R.has(name)) {
                R.set(name, {
                    peers: new Map(),
                    snapshot: Object.freeze([]),
                    topics: new Map(),
                    watchers: new Set(),
                    pending: null,
                    mine: {},
                    sendTimer: 0,
                    left: false,
                });
            }
            return R.get(name);
        };
        const frozenPeer = (p, prev) => {
            const presence = Object.freeze({ ...(p.presence || {}) });
            if (prev && stringify(prev.presence) === stringify(presence)) {
                return prev;
            }
            return Object.freeze({
                peer: p.peer,
                by: p.by ?? null,
                isMe: true,
                sameTab: p.peer === peer,
                kind: 'viewer',
                guest: false,
                presence,
                updatedAt: Date.now(),
            });
        };
        // onPeers: at most once a frame, the snapshot and the net change since the last delivery
        const queue = (name, kind, x) => {
            const st = stateOf(name);
            st.pending ??= { joined: new Map(), left: new Map(), updated: new Map() };
            const pend = st.pending;
            if (kind === 'joined') {
                if (pend.left.has(x.peer)) {
                    pend.left.delete(x.peer);
                } else {
                    pend.joined.set(x.peer, x);
                }
            } else if (kind === 'left') {
                if (pend.joined.has(x.peer)) {
                    pend.joined.delete(x.peer);
                } else {
                    pend.left.set(x.peer, x);
                }
            } else if (!pend.joined.has(x.peer)) {
                pend.updated.set(x.peer, x);
            } else {
                pend.joined.set(x.peer, x);
            }
            requestAnimationFrame(() => flush(name));
        };
        const flush = (name) => {
            const st = stateOf(name);
            const pend = st.pending;
            if (!pend) {
                return;
            }
            st.pending = null;
            st.snapshot = Object.freeze([...st.peers.values()]);
            const change = Object.freeze({
                peers: st.snapshot,
                joined: Object.freeze([...pend.joined.values()]),
                left: Object.freeze([...pend.left.values()]),
                updated: Object.freeze([...pend.updated.values()]),
            });
            if (!change.joined.length && !change.left.length && !change.updated.length) {
                return;
            }
            for (const w of st.watchers) {
                guarded(w.fn)(change);
            }
        };
        const guarded =
            (fn) =>
            (...a) => {
                try {
                    fn(...a);
                } catch (e) {
                    ctx.record({
                        kind: 'error',
                        level: 'error',
                        text: `room listener threw: ${e && e.message}`,
                        source: 'room',
                    });
                }
            };
        const upsert = (name, p) => {
            const st = stateOf(name);
            const prev = st.peers.get(p.peer);
            const next = frozenPeer(p, prev);
            st.peers.set(p.peer, next);
            if (!prev) {
                queue(name, 'joined', next);
            } else if (prev !== next) {
                queue(name, 'updated', next);
            }
        };
        const setUp = (v) => {
            if (up === v) {
                return;
            }
            up = v;
            for (const fn of conn) {
                guarded(fn)(v);
            }
        };
        const open = () => {
            if (!ctx.ES) {
                return;
            }
            es = new ctx.ES(`/_frame/room/connect${peer ? `?peer=${peer}` : ''}`);
            es.addEventListener('hello', (e) => {
                const m = JSON.parse(e.data);
                peer = m.peer;
                retry = 0;
                const lobby = stateOf('');
                for (const old of [...lobby.peers.keys()]) {
                    if (!m.peers.some((p) => p.peer === old)) {
                        lobby.peers.delete(old);
                        queue('', 'left', { peer: old });
                    }
                }
                for (const p of m.peers) {
                    upsert('', p);
                }
                setUp(true);
                // re-assert presence and rooms after a reconnect
                if (Object.keys(lobby.mine).length) {
                    sendPresence('');
                }
                for (const [name, st] of R) {
                    if (name && !st.left) {
                        post('/_frame/room/join', { peer, name }).then(
                            (r) => r.peers && r.peers.forEach((p) => upsert(name, p)),
                            () => undefined,
                        );
                    }
                }
            });
            for (const ev of ['joined', 'presence']) {
                es.addEventListener(ev, (e) => {
                    const m = JSON.parse(e.data);
                    upsert(m.room, m);
                });
            }
            es.addEventListener('left', (e) => {
                const m = JSON.parse(e.data);
                const st = stateOf(m.room);
                const prev = st.peers.get(m.peer);
                if (prev) {
                    st.peers.delete(m.peer);
                    queue(m.room, 'left', prev);
                }
            });
            es.addEventListener('msg', (e) => {
                const m = JSON.parse(e.data);
                const ls = stateOf(m.room).topics.get(m.topic);
                if (!ls) {
                    return;
                }
                const msg = Object.freeze({
                    topic: m.topic,
                    data: m.data,
                    peer: m.peer,
                    by: m.by ?? null,
                    isMe: true,
                    sameTab: m.peer === peer,
                    kind: 'viewer',
                    guest: false,
                });
                for (const fn of ls) {
                    guarded(fn)(msg);
                }
            });
            es.addEventListener('error', () => {
                setUp(false);
                es.close();
                setTimeout(open, Math.min(10000, 500 * 2 ** retry++));
            });
        };
        let opened = false;
        const ensure = () => {
            if (!opened) {
                opened = true;
                open();
            }
        };

        const sendPresence = (name) => {
            const st = stateOf(name);
            if (st.sendTimer) {
                return;
            }
            st.sendTimer = setTimeout(() => {
                st.sendTimer = 0;
                if (up && peer) {
                    post('/_frame/room/presence', { peer, room: name || undefined, presence: st.mine }).catch(
                        () => undefined,
                    );
                }
            }, 33);
        };

        const scoped = (name) => {
            const st = stateOf(name);
            const live = () => !st.left;
            const emit = (topic, data) => {
                ensure();
                if (!live()) {
                    return rejectArg('you left this room');
                }
                if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) {
                    return rejectArg('topic must match ^[a-z][a-z0-9_.-]{0,47}$ (no colon)');
                }
                try {
                    if (data !== undefined && jsonBytes(data) > 4096) {
                        return rejectArg('data is over 4096 bytes of JSON');
                    }
                } catch {
                    return rejectArg('data must be plain JSON');
                }
                if (!up || !peer) {
                    return Promise.resolve();
                }
                return post('/_frame/room/emit', { peer, room: name || undefined, topic, data }).then(
                    (r) => {
                        checked(r);
                        if (r.dropped && !dropReported) {
                            dropReported = true;
                            ctx.record({
                                kind: 'capability',
                                level: 'warn',
                                text: 'room: emits past about 40 a second were dropped; put high-rate state in presence',
                                source: 'room',
                            });
                        }
                    },
                    () => undefined,
                );
            };
            const on = (topic, handler, onError) => {
                if (typeof handler !== 'function') {
                    throw new TypeError('room.on: handler must be a function');
                }
                ensure();
                if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) {
                    if (typeof onError === 'function') {
                        queueMicrotask(() =>
                            onError({ code: 'invalid_argument', message: 'topic must match ^[a-z][a-z0-9_.-]{0,47}$' }),
                        );
                    }
                    return () => undefined;
                }
                const fn = (m) => handler(m);
                const set = st.topics.get(topic) ?? st.topics.set(topic, new Set()).get(topic);
                set.add(fn);
                return () => set.delete(fn);
            };
            const presence = (patch) =>
                settle(() => {
                    ensure();
                    if (!live()) {
                        throw fail('invalid_argument', 'you left this room');
                    }
                    if (!isObj(patch)) {
                        throw fail('invalid_argument', 'presence takes a plain object patch');
                    }
                    const next = { ...st.mine };
                    for (const [k, v] of Object.entries(patch)) {
                        if (!KEY_RE.test(k)) {
                            throw fail('invalid_argument', `key "${k.slice(0, 40)}" is not a plain identifier`);
                        }
                        if (v === null) {
                            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- presence is keyed by field
                            delete next[k];
                        } else {
                            next[k] = v;
                        }
                    }
                    let n;
                    try {
                        n = jsonBytes(next);
                    } catch {
                        throw fail('invalid_argument', 'presence must be plain JSON');
                    }
                    if (n > 4096) {
                        throw fail('invalid_argument', 'your merged presence would be over 4096 bytes of JSON');
                    }
                    st.mine = next;
                    if (peer) {
                        upsert(name, { peer, by: st.peers.get(peer)?.by ?? null, presence: next });
                    }
                    sendPresence(name);
                });
            const peers = () => (ensure(), stateOf(name).snapshot);
            const onPeers = (handler, _onError) => {
                if (typeof handler !== 'function') {
                    throw new TypeError('room.onPeers: handler must be a function');
                }
                ensure();
                const w = { fn: handler };
                st.watchers.add(w);
                // the first delivery presents the room so far as joined
                queueMicrotask(() => {
                    if (!st.watchers.has(w)) {
                        return;
                    }
                    const snap = Object.freeze([...st.peers.values()]);
                    guarded(handler)(
                        Object.freeze({
                            peers: snap,
                            joined: snap,
                            left: Object.freeze([]),
                            updated: Object.freeze([]),
                        }),
                    );
                });
                return () => st.watchers.delete(w);
            };
            const connected = () => up && live();
            const onConnection = (handler, _onError) => {
                if (typeof handler !== 'function') {
                    throw new TypeError('room.onConnection: handler must be a function');
                }
                ensure();
                const fn = (v) => handler(v && live());
                conn.add(fn);
                queueMicrotask(() => conn.has(fn) && guarded(handler)(connected()));
                return () => conn.delete(fn);
            };
            return { emit, on, presence, peers, onPeers, connected, onConnection };
        };

        const lobby = scoped('');
        const joined = new Map();
        const join = (name) =>
            settle(async () => {
                ensure();
                if (typeof name !== 'string' || !ROOM_RE.test(name)) {
                    throw fail('invalid_argument', 'name must match ^[a-z0-9][a-z0-9_.-]{0,47}$');
                }
                if (joined.has(name)) {
                    return joined.get(name);
                }
                for (let i = 0; !up && i < 100; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                }
                if (!up) {
                    throw fail('upstream_error', 'no answer within 10 seconds');
                }
                const r = checked(await post('/_frame/room/join', { peer, name }));
                const st = stateOf(name);
                st.left = false;
                for (const p of r.peers) {
                    upsert(name, p);
                }
                const handle = Object.freeze({
                    name,
                    ...scoped(name),
                    leave: () =>
                        settle(async () => {
                            if (st.left) {
                                return;
                            }
                            st.left = true;
                            joined.delete(name);
                            st.watchers.clear();
                            st.topics.clear();
                            R.delete(name);
                            await post('/_frame/room/leave', { peer, name }).catch(() => undefined);
                        }),
                });
                joined.set(name, handle);
                return handle;
            });

        // to the viewer's own Claude: the session linked to this artifact, after the viewer confirms in the viewer
        let statusEs = null;
        const statusWatch = new Map();
        const watchStatus = (id, fn) => {
            statusWatch.set(id, fn);
            if (statusEs || !ctx.ES) {
                return;
            }
            statusEs = new ctx.ES('/_frame/events');
            statusEs.addEventListener('to-claude', (e) => {
                const m = JSON.parse(e.data);
                const f = statusWatch.get(m.id);
                if (f) {
                    statusWatch.delete(m.id);
                    f({ state: m.state });
                }
            });
        };
        const canSendToClaudeSession = () =>
            call('/_frame/room/can-send').then(
                (r) => r.state,
                () => 'off',
            );
        const sendToClaudeSession = (data, options = {}) => {
            // the gesture is proven from the call itself, before anything is awaited
            const gesture = userActive();
            return settle(async () => {
                if (!isObj(data) || !Object.keys(data).length) {
                    throw fail('invalid_argument', 'data must be a non-empty plain object');
                }
                let n;
                try {
                    n = jsonBytes(data);
                } catch {
                    throw fail('invalid_argument', 'data must be plain JSON');
                }
                if (n > 4096) {
                    throw fail('invalid_argument', 'data is over 4096 bytes of JSON');
                }
                if (!isObj(options)) {
                    throw fail('invalid_argument', 'options must be a plain object');
                }
                if (!gesture) {
                    throw fail(
                        'claude_unavailable',
                        "call it from the viewer's own click or key press, before awaiting anything",
                    );
                }
                if (options.deliver !== 'send') {
                    throw fail(
                        'claude_unavailable',
                        'the local viewer has no Claude conversation beside the page to stage into; pass {deliver: "send"}',
                    );
                }
                if ((await canSendToClaudeSession()) !== 'available_if_summoned') {
                    throw fail('claude_unavailable', 'no Claude session is linked to this artifact');
                }
                const r = await confirm('to-claude', { data, presence: stateOf('').mine });
                if (r.result === 'error') {
                    throw fail(r.code || 'upstream_error', r.message || 'the send failed');
                }
                if (r.result === 'busy') {
                    throw fail('rate_limited', 'another prompt is open');
                }
                if (r.result !== 'allow') {
                    throw fail('claude_unavailable', 'the viewer did not send it; nothing was sent');
                }
                const onStatus = typeof options.onStatus === 'function' ? guarded(options.onStatus) : null;
                if (onStatus) {
                    queueMicrotask(() => onStatus({ state: 'working' }));
                    watchStatus(r.sendId, (st) => onStatus({ ...st, shell: 'spatial-artifacts' }));
                }
                return { to: 'session', id: r.sendId };
            });
        };

        return Object.freeze({ ...lobby, join, sendToClaudeSession, canSendToClaudeSession });
    })();

    // ---- sample ----------------------------------------------------------

    const sample = (() => {
        const LIMITS = Object.freeze({
            maxPromptBytes: 262144,
            images: Object.freeze({
                maxCount: 5,
                maxInputBytes: 20 * 1024 * 1024,
                mediaTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
            }),
            tools: Object.freeze({ maxCount: 16 }),
        });
        const TIERS = ['default', 'complex', 'quick'];
        const EMIT_MS = 120;
        const RESULT_MAX = 32768;
        const TOOL_MS = 150000;
        // failures are plain objects, never Errors: { code, message, text? }
        const err = (code, message, text) => ({ code, message, ...(typeof text === 'string' && text && { text }) });
        let declined = false;

        // downsizes to about 1.2 megapixels, keeps an animation's first frame and drops metadata, as the original does
        const prepImage = async (blob) => {
            if (!(blob instanceof Blob)) {
                throw err('invalid_request', 'images must be Blobs or Files');
            }
            if (!LIMITS.images.mediaTypes.includes(blob.type)) {
                throw err('image_rejected', `${blob.type || 'unknown type'} is not JPEG, PNG, WebP or GIF`);
            }
            if (blob.size > LIMITS.images.maxInputBytes) {
                throw err('image_rejected', 'an image is over 20 MB');
            }
            let bmp;
            try {
                bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
            } catch {
                throw err('image_rejected', 'an image could not be decoded');
            }
            if (bmp.width > 10000 || bmp.height > 10000 || bmp.width * bmp.height > 64e6) {
                throw err('image_rejected', 'an image is over 10,000 px a side or 64 megapixels');
            }
            const k = Math.min(1, Math.sqrt(1.2e6 / (bmp.width * bmp.height)));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(bmp.width * k));
            c.height = Math.max(1, Math.round(bmp.height * k));
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
            const url = c.toDataURL(type, 0.9);
            return { type, b64: url.slice(url.indexOf(',') + 1) };
        };

        const ask = (verb, input, options) => {
            // read everything at call time; the request leaves on the next microtask
            if (options !== undefined && !isObj(options)) {
                return Promise.reject(
                    err(
                        'invalid_request',
                        options instanceof AbortController
                            ? 'options must be a plain object; pass ctl.signal as {signal}'
                            : 'options must be a plain object',
                    ),
                );
            }
            const o = options || {};
            const turns = Array.isArray(input)
                ? input.map((t) => (isObj(t) ? { role: t.role, content: t.content } : t))
                : input;
            if (typeof turns !== 'string' && !Array.isArray(turns)) {
                return Promise.reject(
                    err(
                        'invalid_request',
                        isObj(input) && 'prompt' in input
                            ? 'pass the prompt first: sample(prompt, options) — the {prompt} object form is gone'
                            : 'input must be a prompt string or a list of turns',
                    ),
                );
            }
            if (o.signal !== undefined && !(o.signal instanceof AbortSignal)) {
                return Promise.reject(
                    err(
                        'invalid_request',
                        o.signal instanceof AbortController
                            ? 'pass ctl.signal, not the controller'
                            : 'signal must be an AbortSignal',
                    ),
                );
            }
            if (o.onText !== undefined && typeof o.onText !== 'function') {
                return Promise.reject(err('invalid_request', 'onText must be a function'));
            }
            if (o.modelTier !== undefined && !TIERS.includes(o.modelTier)) {
                return Promise.reject(err('invalid_request', 'modelTier must be "default", "complex" or "quick"'));
            }
            const c = o.cache;
            if (!(
                c === undefined ||
                c === true ||
                c === false ||
                (isObj(c) &&
                    Object.keys(c).every((k) => k === 'gcTime' || k === 'refresh') &&
                    (c.gcTime === undefined || (typeof c.gcTime === 'number' && c.gcTime > 0)))
            )) {
                return Promise.reject(
                    err('invalid_request', 'cache must be true, false or {gcTime?, refresh?} with gcTime > 0'),
                );
            }
            const tools = o.tools === undefined ? [] : o.tools;
            if (!Array.isArray(tools)) {
                return Promise.reject(err('invalid_request', 'tools must be an array'));
            }
            for (const [i, t] of tools.entries()) {
                if (
                    !isObj(t) ||
                    typeof t.execute !== 'function' ||
                    typeof t.name !== 'string' ||
                    typeof t.description !== 'string'
                ) {
                    return Promise.reject(
                        err('invalid_request', `tools[${i}] needs name, description and execute(input, {signal})`),
                    );
                }
            }
            if (tools.length && c !== undefined && c !== false) {
                return Promise.reject(err('invalid_request', 'cache cannot be combined with tools; omit it'));
            }
            const images = o.images === undefined ? [] : o.images instanceof Blob ? [o.images] : [...o.images];
            if (images.length > LIMITS.images.maxCount) {
                return Promise.reject(err('image_rejected', `at most ${LIMITS.images.maxCount} images per call`));
            }
            const toolDefs = tools.map((t) => ({
                name: t.name,
                description: t.description,
                ...(t.inputSchema !== undefined && { input_schema: t.inputSchema }),
            }));
            const run = Object.fromEntries(tools.map((t) => [t.name, t.execute]));
            const signal = o.signal;
            const onText = o.onText;

            return new Promise((ok, no) => {
                let text = '';
                let shown = '';
                let settled = false;
                let timer = 0;
                const ctl = new AbortController();
                const toolCtls = new Set();
                const emit = () => {
                    timer = 0;
                    if (settled || !onText || text === shown || !text.trim()) {
                        return;
                    }
                    const delta = text.slice(shown.length);
                    shown = text;
                    try {
                        const r = onText({ text, delta });
                        if (r && typeof r.catch === 'function') {
                            r.catch((e) => console.error('sample onText threw', e));
                        }
                    } catch (e) {
                        console.error('sample onText threw', e);
                    }
                };
                const finish = (fn, v) => {
                    if (settled) {
                        return;
                    }
                    clearTimeout(timer);
                    if (fn === ok) {
                        emit();
                    }
                    settled = true;
                    for (const t of toolCtls) {
                        t.abort();
                    }
                    ctl.abort();
                    fn(v);
                };
                const cancel = () => finish(no, err('cancelled', 'the call was cancelled', text));
                if (signal) {
                    if (signal.aborted) {
                        return cancel();
                    }
                    signal.addEventListener('abort', cancel, { once: true });
                }
                queueMicrotask(async () => {
                    try {
                        if (settled) {
                            return;
                        }
                        if (declined) {
                            return finish(
                                no,
                                err('not_granted', 'the viewer has not allowed this artifact to use Claude'),
                            );
                        }
                        const st = await consentFor('sample');
                        if (settled) {
                            return;
                        }
                        if (st === 'denied') {
                            declined = true;
                        }
                        if (st !== 'granted') {
                            return finish(
                                no,
                                err('not_granted', 'the viewer has not allowed this artifact to use Claude'),
                            );
                        }
                        const imgs = [];
                        for (const b of images) {
                            imgs.push(await prepImage(b));
                        }
                        if (settled) {
                            return;
                        }
                        const r = await ctx.fetch('/_frame/api/sample', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: stringify({
                                verb,
                                input: turns,
                                tier: o.modelTier,
                                images: imgs,
                                tools: toolDefs.length ? toolDefs : undefined,
                                cache: c,
                            }),
                            signal: ctl.signal,
                        });
                        if (!r.ok || !r.body) {
                            return finish(
                                no,
                                err(r.status === 403 ? 'not_declared' : 'upstream_error', `HTTP ${r.status}`),
                            );
                        }
                        const reader = r.body.getReader();
                        const dec = new TextDecoder();
                        let buf = '';
                        for (;;) {
                            const { value, done } = await reader.read();
                            if (done) {
                                break;
                            }
                            buf += dec.decode(value, { stream: true });
                            let i;
                            while ((i = buf.indexOf('\n')) >= 0) {
                                const ev = JSON.parse(buf.slice(0, i));
                                buf = buf.slice(i + 1);
                                if (ev.type === 'text') {
                                    text += ev.delta;
                                    if (!timer) {
                                        timer = setTimeout(emit, EMIT_MS);
                                    }
                                } else if (ev.type === 'tools') {
                                    runTools(ev);
                                } else if (ev.type === 'done') {
                                    return finish(
                                        ok,
                                        verb === 'json'
                                            ? ev.value
                                            : {
                                                  text: ev.text,
                                                  truncated: !!ev.truncated,
                                                  modelTierApplied: ev.tier || o.modelTier || 'default',
                                              },
                                    );
                                } else if (ev.type === 'error') {
                                    return finish(
                                        no,
                                        err(ev.code, ev.message, ev.code === 'refused' ? undefined : (ev.text ?? text)),
                                    );
                                }
                            }
                        }
                        finish(no, err('upstream_error', 'the answer stopped before it finished', text));
                    } catch (e) {
                        if (settled) {
                            return;
                        }
                        finish(
                            no,
                            e && typeof e.code === 'string' && !(e instanceof DOMException)
                                ? e
                                : err('upstream_error', String(e && e.message), text),
                        );
                    }
                });

                // Claude called the page's tools: run them here, concurrently, and hand the results back
                const runTools = async (ev) => {
                    const results = await Promise.all(
                        ev.calls.map(async (k) => {
                            const tc = new AbortController();
                            toolCtls.add(tc);
                            const t = setTimeout(() => tc.abort(), TOOL_MS);
                            try {
                                const fn = run[k.name];
                                if (!fn) {
                                    throw new Error(`no tool named ${k.name}`);
                                }
                                const v = await fn(isObj(k.input) ? k.input : {}, { signal: tc.signal });
                                const s = typeof v === 'string' ? v : stringify(v === undefined ? null : v);
                                if (s.length > RESULT_MAX) {
                                    throw new Error(`the result is over ${RESULT_MAX} bytes; return less`);
                                }
                                return { id: k.id, content: s };
                            } catch (e) {
                                return {
                                    id: k.id,
                                    content: `Error: ${e && e.message ? e.message : String(e)}`,
                                    is_error: true,
                                };
                            } finally {
                                clearTimeout(t);
                                toolCtls.delete(tc);
                            }
                        }),
                    );
                    if (!settled) {
                        post('/_frame/api/sample/results', { callId: ev.callId, results }).catch(() => undefined);
                    }
                };
            });
        };

        const fn = (input, options) => ask('text', input, options);
        fn.json = (input, options) => ask('json', input, options);
        fn.limits = () => Promise.resolve(LIMITS);
        return Object.freeze(fn);
    })();

    // ---- mcp -------------------------------------------------------------

    const mcp = (() => {
        // rejections are McpError-shaped plain objects
        const E = (code, message, extra = {}) => ({ code, message, ...extra });
        const GC_DEFAULT = 300000;
        const STALE_MAX = 300000;
        const GC_MAX = 86400000;
        const POLL_FLOOR = 30000;
        const WATCH_MAX = 64;
        const RESERVED = new Set(['then', 'toJSON', ...Object.getOwnPropertyNames(Object.prototype)]);
        const stable = (v) =>
            Array.isArray(v)
                ? `[${v.map(stable).join(',')}]`
                : v && typeof v === 'object'
                  ? `{${Object.keys(v)
                        .sort()
                        .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
                        .join(',')}}`
                  : JSON.stringify(v ?? null);
        const identity = (server, tool, input) => `${server}\0${tool}\0${stable(input === undefined ? null : input)}`;
        const plainJson = (v) => {
            if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') {
                return true;
            }
            if (typeof v === 'number') {
                return Number.isFinite(v);
            }
            if (Array.isArray(v)) {
                return v.every(plainJson);
            }
            if (isObj(v) && Object.getPrototypeOf(v) === Object.prototype) {
                return '$file' in v ? 'file' : Object.values(v).every((x) => plainJson(x) === true);
            }
            return false;
        };

        const lists = new Map();
        const toolsOf = (server) => {
            if (!lists.has(server)) {
                lists.set(
                    server,
                    post('/_frame/api/mcp/list', { server }).then(
                        (r) => r.servers?.[0]?.tools ?? null,
                        () => null,
                    ),
                );
            }
            return lists.get(server);
        };
        const readOnlyOf = async (server, tool) =>
            (await toolsOf(server))?.find((t) => t.name === tool)?.annotations?.readOnlyHint;

        const gate = async (server) => {
            const st = await consentFor(`mcp:${server}`);
            if (st === 'granted') {
                return lists.delete(server);
            }
            if (st === 'denied') {
                throw E('not_in_manifest', `the viewer did not allow ${server} for this page`, { server });
            }
            throw E('upstream_error', `the viewer did not decide about ${server} just now`, {
                server,
                retryable: true,
                retryAfterMs: 3000,
            });
        };

        const exec = async (server, tool, input) => {
            let r = await post('/_frame/api/mcp/call', { server, tool, input });
            if (r.error && r.error.code === 'confirm_required') {
                const c = await confirm('mcp-call', { server, tool, input });
                if (c.result === 'busy') {
                    throw E('upstream_error', 'another prompt is open', {
                        server,
                        retryable: true,
                        retryAfterMs: 3000,
                    });
                }
                if (c.result !== 'allow' || !c.token) {
                    throw E('cancelled', 'the viewer declined to run this tool; it never ran', { server });
                }
                r = await post('/_frame/api/mcp/call', { server, tool, input, approval: c.token });
            }
            if (r.error) {
                throw E(r.error.code, r.error.message, {
                    ...(r.error.server && { server: r.error.server }),
                    ...(r.error.retryable && { retryable: true }),
                    ...(r.error.result !== undefined && { result: r.error.result }),
                });
            }
            return r;
        };

        // results of cached reads, per call identity; watches hear every newer result for theirs
        const cache = new Map();
        const watches = new Map();
        const deliver = (key, ev) => {
            for (const w of watches.get(key) ?? []) {
                try {
                    w.handler(ev);
                } catch (e) {
                    ctx.record({
                        kind: 'error',
                        level: 'error',
                        text: `mcp watch handler threw: ${e && e.message}`,
                        source: 'mcp',
                    });
                }
            }
        };
        const policy = (ro, opt) => {
            if (opt === false || ro === false) {
                return null;
            }
            if (isObj(opt)) {
                return {
                    stale: Math.min(STALE_MAX, Math.max(0, Number(opt.staleTime) || 0)),
                    gc: Math.min(GC_MAX, opt.gcTime === undefined ? GC_DEFAULT : Number(opt.gcTime)),
                    refresh: opt.refresh === true,
                };
            }
            return ro === true ? { stale: 0, gc: GC_DEFAULT, refresh: false } : null;
        };
        const withCache = (r, at, revalidating) => (isObj(r) ? { ...r, cache: { storedAt: at, revalidating } } : r);

        const run = async (server, tool, input, opt, fromWatch = false) => {
            if (typeof server !== 'string' || typeof tool !== 'string') {
                throw E('bad_request', 'server and tool must be strings');
            }
            const pj = plainJson(input);
            if (pj === 'file') {
                throw E(
                    'capability_disabled',
                    'file arguments are not available in the local viewer; send the bytes inline as base64',
                    { server },
                );
            }
            if (pj !== true) {
                throw E('bad_request', 'input must be plain JSON (no Map, Set, Date, typed arrays or BigInt)', {
                    server,
                });
            }
            await gate(server);
            const key = identity(server, tool, input);
            const p = policy(await readOnlyOf(server, tool), opt);
            const hit = p && cache.get(key);
            if (hit && !p.refresh && Date.now() - hit.at < p.stale && Date.now() - hit.at < hit.gc) {
                return withCache(hit.result, hit.at, false);
            }
            const result = await exec(server, tool, input);
            if (p && p.gc > 0) {
                cache.set(key, { result, at: Date.now(), gc: p.gc });
                if (!fromWatch) {
                    deliver(key, { type: 'data', result });
                }
            }
            return result;
        };

        const callTool = (server, tool, input, options = {}) => {
            if (!isObj(options)) {
                return Promise.reject(E('bad_request', 'options must be an object'));
            }
            const signal = options.signal;
            const p = settle(() => run(server, tool, input, options.cache));
            if (!(signal instanceof AbortSignal)) {
                return p;
            }
            if (signal.aborted) {
                return Promise.reject(E('cancelled', 'the call was aborted; the tool may still have run', { server }));
            }
            return Promise.race([
                p,
                new Promise((_, no) =>
                    signal.addEventListener(
                        'abort',
                        () => no(E('cancelled', 'the call was aborted; the tool may still have run', { server })),
                        { once: true },
                    ),
                ),
            ]);
        };

        let watchCount = 0;
        const watchTool = (server, tool, input, handler, options = {}) => {
            if (typeof handler !== 'function') {
                throw new TypeError('mcp.watchTool: handler must be a function');
            }
            const key = identity(server, tool, input);
            const w = { handler, live: true };
            let timer = 0;
            const stop = () => {
                if (!w.live) {
                    return;
                }
                w.live = false;
                watchCount--;
                clearInterval(timer);
                removeEventListener('visibilitychange', onVis);
                watches.get(key)?.delete(w);
            };
            const fire = (ev) => w.live && guardedCall(handler, ev);
            const refetch = () =>
                run(server, tool, input, { ...(isObj(options.cache) ? options.cache : {}), refresh: true }, true).then(
                    (result) => {
                        if (!w.live) {
                            return;
                        }
                        deliver(key, { type: 'data', result });
                    },
                    (error) => fire({ type: 'error', error }),
                );
            const onVis = () => !document.hidden && refetch();
            queueMicrotask(async () => {
                if (!w.live) {
                    return;
                }
                if (watchCount >= WATCH_MAX) {
                    return fire({
                        type: 'error',
                        error: E('bad_request', `at most ${WATCH_MAX} watches per view; unsubscribe unused ones`),
                    });
                }
                watchCount++;
                if (!watches.has(key)) {
                    watches.set(key, new Set());
                }
                watches.get(key).add(w);
                const ro = await readOnlyOf(server, tool).catch(() => undefined);
                if (ro === false) {
                    return (
                        fire({
                            type: 'error',
                            error: E('bad_request', `${tool} is not read-only; watch reads only`, { server }),
                        }),
                        stop()
                    );
                }
                const opt = isObj(options.cache) ? options.cache : {};
                const stale = Math.min(STALE_MAX, Math.max(0, Number(opt.staleTime) || 0));
                const hit = cache.get(key);
                if (hit && Date.now() - hit.at < hit.gc) {
                    const fresh = Date.now() - hit.at < stale;
                    fire({ type: 'data', result: withCache(hit.result, hit.at, !fresh) });
                    if (!fresh) {
                        refetch();
                    }
                } else {
                    refetch();
                }
                const every = Number(options.refetchInterval);
                if (every > 0) {
                    timer = setInterval(() => !document.hidden && refetch(), Math.max(POLL_FLOOR, every));
                }
                addEventListener('visibilitychange', onVis);
            });
            return stop;
        };
        const guardedCall = (fn, ev) => {
            try {
                fn(ev);
            } catch (e) {
                ctx.record({
                    kind: 'error',
                    level: 'error',
                    text: `mcp watch handler threw: ${e && e.message}`,
                    source: 'mcp',
                });
            }
        };

        const invalidate = (server, tool, input) =>
            settle(() => {
                if (input !== undefined && (server === undefined || tool === undefined)) {
                    throw E('bad_request', 'input requires server and tool');
                }
                const exact = input !== undefined && identity(server, tool, input === null ? null : input);
                const hits = [...cache.keys()].filter((k) => {
                    const [s, t] = k.split('\0');
                    return exact
                        ? k === exact ||
                              (input !== null && stable(input) === '{}' && k === identity(server, tool, null))
                        : (server === undefined || s === server) && (tool === undefined || t === tool);
                });
                for (const k of hits) {
                    cache.delete(k);
                }
                // matching watches re-execute and deliver
                for (const [k, set] of watches) {
                    const [s, t] = k.split('\0');
                    if (
                        exact
                            ? k === exact
                            : (server === undefined || s === server) && (tool === undefined || t === tool)
                    ) {
                        if (set.size) {
                            const [, , rest] = k.split('\0');
                            const inp = JSON.parse(rest);
                            run(s, t, inp, { refresh: true }, true).then(
                                (result) => deliver(k, { type: 'data', result }),
                                (error) => deliver(k, { type: 'error', error }),
                            );
                        }
                    }
                }
            });

        const listTools = (server) =>
            settle(async () => {
                if (server !== undefined && typeof server !== 'string') {
                    throw E('bad_request', 'server must be a string');
                }
                const r = checked(await post('/_frame/api/mcp/list', server === undefined ? {} : { server }));
                return { servers: r.servers };
            });

        const server = (name) =>
            settle(async () => {
                const r = await listTools(name);
                const info = r.servers.find((x) => x.server === name);
                if (!info || !info.tools.length) {
                    throw E('server_not_connected', `no server named ${name} is reachable from this view`, {
                        server: name,
                    });
                }
                const h = Object.create(null);
                for (const t of info.tools) {
                    if (/^[A-Za-z0-9_.-]+$/.test(t.name) && !RESERVED.has(t.name)) {
                        h[t.name] = (input, options) =>
                            callTool(name, t.name, input, options).then((res) =>
                                res && res.payload !== undefined ? res.payload : res,
                            );
                    }
                }
                return Object.freeze(h);
            });

        const describeTool = (server, tool) =>
            settle(async () => {
                const r = await post('/_frame/api/mcp/describe', { server, tool });
                if (r.error) {
                    throw E(r.error.code, r.error.message, { server });
                }
                return r;
            });

        return Object.freeze({ callTool, watchTool, invalidate, listTools, server, describeTool });
    })();

    return { files, room, sample, mcp, confirm, settle, isObj, post, checked, userActive };
};
