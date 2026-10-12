// the capabilities that reach past the page: files and room. runtime.js imports this on first use and
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
        return Object.freeze({ list, read, download });
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

    return { files, room, confirm, settle, isObj, post, checked, userActive };
};
