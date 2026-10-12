// frame runtime: first script of every artifact page on http://<uuid>.localhost:<port>.
// theme, diagnostics, window.claude capabilities, live updates, comment mode. never throws into the page.
(() => {
    const boot = () => {
        const MAX_ENTRIES = 200;
        const MAX_TEXT = 2000;
        const FLUSH_MS = 500;
        const KEEPALIVE_BYTES = 60000;
        const QUOTE_BYTES = 512;
        const DRAG_SLOP = 4;
        // a press that draws less than this, either way, is a wobbly click, not an area
        const AREA_MIN = 12;
        // a drawn area quotes at most this many covered elements, scanning at most SCAN_MAX
        const INSIDE_MAX = 16;

        // a comment holds at most this many more anchors, added with Shift+click
        const ALSO_MAX = 8;

        // a drawn area's capture from a page picker, as a data: url; the daemon caps the decoded bytes at 1 MB
        const IMAGE_MAX_CHARS = 1400000;
        const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,/;
        const SCAN_MAX = 4096;
        const ACCENT = '#c96442';
        // the daemon's DB_QUERY_MAX
        const ORDERED_LIMIT = 1000;

        const script = document.currentScript;
        const ds = (script && script.dataset) || {};
        let ver = ds.ver || '';
        const shell = ds.shell || '';
        const caps = (ds.caps || '').split(',').filter(Boolean);
        const root = document.documentElement;
        const framed = window.parent !== window;

        // the page may replace these later; keep the originals
        const fetch_ = window.fetch.bind(window);
        const ES = window.EventSource;
        const stringify = JSON.stringify;
        const con = {};
        for (const k of ['log', 'info', 'warn', 'error']) {
            con[k] = console[k];
        }
        const confirm_ = window.confirm.bind(window);

        const guard =
            (fn) =>
            (...a) => {
                try {
                    return fn(...a);
                } catch {
                    // page errors must not break the runtime
                }
            };

        const toParent = (msg) => {
            if (framed && shell) {
                guard(() => window.parent.postMessage({ da: 1, ...msg }, shell))();
            }
        };

        // theme

        const setTheme = (t) => {
            if (t === 'dark' || t === 'light') {
                root.dataset.theme = t;
            } else {
                delete root.dataset.theme;
            }
        };
        guard(() => {
            const q = new URLSearchParams(location.search);
            if (!q.has('theme')) {
                return;
            }
            setTheme(q.get('theme'));
            q.delete('theme');
            const s = q.toString();
            history.replaceState(history.state, '', location.pathname + (s ? `?${s}` : '') + location.hash);
        })();

        // fullscreen: a page asks with a `claude:fullscreen` event, detail { on }. the shell takes the whole frame full screen,
        // so its comment box stays visible; a page opened on its own takes its root. `data-fullscreen` on the root and a
        // `claude:fullscreen-change` event, detail { on }, report the state

        const setFull = (on) => {
            if (on) {
                root.dataset.fullscreen = '';
            } else {
                delete root.dataset.fullscreen;
            }
            guard(() => document.dispatchEvent(new CustomEvent('claude:fullscreen-change', { detail: { on } })))();
        };
        document.addEventListener(
            'claude:fullscreen',
            guard((e) => {
                const on = e.detail?.on === true;
                if (framed) {
                    return toParent({ type: 'fullscreen', on });
                }
                // safari before 16.4 has only the prefixed api, and an iphone has none: the page then just fills the window
                const req = root.requestFullscreen ?? root.webkitRequestFullscreen;
                const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
                if (on && req) {
                    Promise.resolve(req.call(root)).catch(() => setFull(true));
                } else if (on) {
                    setFull(true);
                } else if (document.fullscreenElement ?? document.webkitFullscreenElement) {
                    Promise.resolve(exit.call(document)).catch(() => undefined);
                } else {
                    setFull(false);
                }
            }),
        );
        if (!framed) {
            for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
                document.addEventListener(ev, () =>
                    setFull(!!(document.fullscreenElement ?? document.webkitFullscreenElement)),
                );
            }
        }

        // diagnostics

        const queue = [];
        let recorded = 0;
        let posted = false;
        let timer;

        const show = (v) => {
            if (typeof v === 'string') {
                return v;
            }
            if (v instanceof Error) {
                return v.stack || `${v.name}: ${v.message}`;
            }
            if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
                return String(v);
            }
            try {
                return stringify(v) ?? String(v);
            } catch {
                return String(v);
            }
        };

        const post = (entries, keepalive) =>
            fetch_('/_frame/api/diag', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: stringify({ ver, entries }),
                keepalive,
            }).catch(() => undefined);

        const flush = (keepalive) => {
            clearTimeout(timer);
            timer = undefined;
            if (posted && !queue.length) {
                return;
            }
            posted = true;
            let entries = queue.splice(0, 100);
            if (keepalive) {
                // keepalive bodies are capped at 64 KB in flight
                let n = 0;
                entries = entries.filter((e) => (n += stringify(e).length) < KEEPALIVE_BYTES);
            }
            post(entries, keepalive);
            if (queue.length && !keepalive) {
                timer = setTimeout(flush, FLUSH_MS);
            }
        };

        const record = guard((e) => {
            if (recorded >= MAX_ENTRIES) {
                return;
            }
            recorded++;
            queue.push({ ts: new Date().toISOString(), ...e, text: String(e.text).slice(0, MAX_TEXT) });
            if (!timer) {
                timer = setTimeout(flush, FLUSH_MS);
            }
        });

        for (const level of Object.keys(con)) {
            console[level] = function (...a) {
                guard(() => record({ kind: 'console', level, text: a.map(show).join(' ') }))();
                return con[level].apply(this, a);
            };
        }

        addEventListener(
            'error',
            guard((e) => {
                if (e instanceof ErrorEvent) {
                    const stack = e.error && e.error.stack;
                    const text = stack && !stack.includes(e.message) ? `${e.message}\n${stack}` : stack || e.message;
                    return record({
                        kind: 'error',
                        level: 'error',
                        text,
                        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
                    });
                }
                const t = e.target;
                if (!t || t === window || !t.tagName) {
                    return;
                }
                const url = t.currentSrc || t.src || t.href || '';
                record({
                    kind: 'resource',
                    level: 'error',
                    text: `failed to load <${t.localName}> ${url}`,
                    source: url,
                });
            }),
            true,
        );
        addEventListener(
            'unhandledrejection',
            guard((e) => record({ kind: 'rejection', level: 'error', text: `unhandled rejection: ${show(e.reason)}` })),
        );
        addEventListener(
            'securitypolicyviolation',
            guard((e) =>
                record({
                    kind: 'csp',
                    level: 'error',
                    text: `blocked ${e.blockedURI || '(inline)'} by ${e.violatedDirective}`,
                    source: e.sourceFile ? `${e.sourceFile}:${e.lineNumber}:${e.columnNumber}` : undefined,
                }),
            ),
            true,
        );

        // one post per load, even with no entries, marks "a viewer loaded this version"
        addEventListener('load', () => setTimeout(() => !posted && flush(), 0));
        addEventListener('pagehide', () => flush(true));

        // capabilities

        const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

        const call = async (path, init) => {
            const r = await fetch_(path, init).catch((e) => {
                throw fail('unavailable', String(e && e.message));
            });
            const type = r.headers.get('content-type') || '';
            const b = type.includes('json') ? await r.json() : await r.text();
            if (r.ok) {
                return b;
            }
            const tooLarge = r.status === 413 || (typeof b === 'string' && /too large/i.test(b));
            const code =
                r.status === 409
                    ? 'conflict'
                    : r.status === 403
                      ? 'not_declared'
                      : r.status === 404
                        ? 'not_found'
                        : tooLarge
                          ? 'too_large'
                          : r.status === 400 || r.status === 415
                            ? 'invalid_argument'
                            : 'internal';
            throw fail(
                code,
                typeof b === 'string' ? b : (b.error && b.error.message) || b.error || stringify(b),
                typeof b === 'object' ? { details: b } : {},
            );
        };

        // capability-call failures land in diagnostics and still reject to the caller
        const traced = (label, p) =>
            p.catch((e) => {
                record({
                    kind: 'capability',
                    level: 'error',
                    text: `${label} failed: ${e.code ? `[${e.code}] ` : ''}${e.message}`,
                    source: label.split('.')[0],
                });
                throw e;
            });

        const postJson = (path, data) =>
            call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stringify(data) });

        const seen = new Map();
        const dbReq = (label, verb, args) =>
            traced(
                label,
                postJson('/_frame/api/db', { verb, args }).then((r) => {
                    if (r && r.error) {
                        throw fail(r.error.code, r.error.message, { current: r.error.current, index: r.index });
                    }
                    return r;
                }),
            );

        const split = (path) => {
            const p = String(path);
            const i = p.lastIndexOf('/');
            if (i <= 0 || i === p.length - 1) {
                throw fail('invalid_argument', `"${p}" is not a document path: use "<collection>/<id>"`);
            }
            return [p.slice(0, i), p.slice(i + 1)];
        };

        const docSnap = (path, id, d) => {
            seen.set(path, d ? d.version : 0);
            return {
                id,
                path,
                exists: !!d,
                version: d ? d.version : undefined,
                updatedAt: d && d.updatedAt,
                data: () => (d ? d.data : undefined),
            };
        };

        // one local person: every data/users/<uid> is data/users/me
        const norm = (p) => p.replace(/^data\/users\/u_[A-Za-z0-9_]{22}(?=\/|$)/, 'data/users/me');

        const subs = new Set();
        const subscribe = (key, isDoc, get, cb, onErr) => {
            const s = {
                key: norm(key),
                isDoc,
                run: () =>
                    get().then(
                        (v) => subs.has(s) && guard(cb)(v),
                        (e) => subs.has(s) && onErr && guard(onErr)(e),
                    ),
            };
            subs.add(s);
            s.run();
            return () => subs.delete(s);
        };
        const onDb = (paths) => {
            const ps = (paths || []).map(norm);
            for (const s of subs) {
                if (ps.some((p) => (s.isDoc ? p === s.key : p.slice(0, p.lastIndexOf('/')) === s.key))) {
                    s.run();
                }
            }
        };

        const docRef = (path) => {
            const [collection, id] = split(path);
            const get = () =>
                dbReq(`db.doc(${path}).get`, 'get', { collection, doc_id: id }).then((r) =>
                    docSnap(path, id, r.docs[0]),
                );
            const write = (op, data) => {
                const args = { collection, doc_id: id };
                if (data !== undefined) {
                    args.data = data;
                }
                if (seen.has(path)) {
                    args.if_version = seen.get(path);
                }
                return dbReq(`db.doc(${path}).${op}`, op, args).then((r) => {
                    seen.set(path, r.version ?? 0);
                    return { path, version: r.version };
                });
            };
            return {
                id,
                path,
                get,
                set: (data) => write('set', data),
                update: (data) => write('update', data),
                delete: () => write('delete'),
                onSnapshot: (cb, onErr) => subscribe(path, true, get, cb, onErr),
            };
        };

        const queryRef = (collection, q) => {
            const get = async () => {
                const docs = [];
                let cursor;
                for (let i = 0; i < 100; i++) {
                    const query = { ...q };
                    if (cursor) {
                        query.cursor = cursor;
                    }
                    // ordered results come back in one page, so ask for the most the daemon allows
                    if (q.order_by && !q.limit) {
                        query.limit = ORDERED_LIMIT;
                    }
                    const r = await dbReq(`db.collection(${collection}).get`, 'query', { collection, query });
                    for (const d of r.docs) {
                        docs.push(docSnap(`${collection}/${d.id}`, d.id, d));
                    }
                    cursor = r.next_cursor;
                    if (!cursor || (q.limit && docs.length >= q.limit)) {
                        break;
                    }
                }
                return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
            };
            return {
                id: collection.slice(collection.lastIndexOf('/') + 1),
                path: collection,
                doc: (id) => docRef(`${collection}/${id}`),
                where: (field, op, value) =>
                    queryRef(collection, { ...q, where: [...(q.where || []), [field, op, value]] }),
                orderBy: (field, direction = 'asc') => queryRef(collection, { ...q, order_by: { field, direction } }),
                limit: (n) =>
                    queryRef(collection, { ...q, limit: Math.max(1, Math.min(ORDERED_LIMIT, Math.floor(n) || 1)) }),
                get,
                onSnapshot: (cb, onErr) => subscribe(collection, false, get, cb, onErr),
            };
        };

        const toWrite = (w) => {
            const [collection, doc_id] = split(w.path);
            const out = { op: w.op, collection, doc_id };
            if (w.data !== undefined) {
                out.data = w.data;
            }
            if (seen.has(w.path)) {
                out.if_version = seen.get(w.path);
            }
            return out;
        };

        const db = Object.freeze({
            doc: docRef,
            collection: (name) => queryRef(String(name), {}),
            batch: (writes) =>
                Promise.resolve()
                    .then(() => (writes || []).map(toWrite))
                    .then((ws) =>
                        dbReq('db.batch', 'batch', { writes: ws }).then((r) => {
                            (writes || []).forEach((w, i) =>
                                seen.set(w.path, (r.results[i] && r.results[i].version) ?? 0),
                            );
                            return r.results;
                        }),
                    ),
        });

        const me = () => traced('user.me', call('/_frame/api/user'));
        // one local person, who owns the artifact and can do everything on it
        const user = Object.freeze({
            me,
            id: () => me().then((u) => u.id),
            isOwner: () => true,
            canEdit: () => true,
            can: () => true,
            profiles: (ids) =>
                me().then((u) =>
                    Object.fromEntries(
                        (Array.isArray(ids) ? ids : []).map((x) => [
                            x,
                            x === u.id ? { id: u.id, name: u.name, guest: false } : { id: x, name: '', guest: false },
                        ]),
                    ),
                ),
        });

        const assets = Object.freeze({
            upload: (file, name) =>
                traced(
                    'assets.upload',
                    call('/_frame/api/assets', {
                        method: 'POST',
                        headers: {
                            'content-type': (file && file.type) || 'application/octet-stream',
                            'x-name': encodeURIComponent(name || (file && file.name) || 'upload'),
                        },
                        body: file,
                    }),
                ),
            list: () => traced('assets.list', call('/_frame/api/assets')),
            url: (id) => `/_blob/${encodeURIComponent(id)}`,
        });

        let base = ver;
        const ownSaves = new Set();
        const artifact = Object.freeze({
            publish: (html) => {
                const save = Math.random().toString(36).slice(2);
                ownSaves.add(save);
                toParent({ type: 'saving', save });
                return traced(
                    'artifact.publish',
                    postJson('/_frame/api/publish', { html: String(html), baseVersion: base, save }).then((r) => {
                        ver = r.ver;
                        base = ver;
                        return { ver: r.ver, seq: r.seq };
                    }),
                );
            },
        });

        // downloads: the viewer confirms every save in the shell (or, on a page opened on its own, in a dialog)
        const SAVE_EXTS = [
            'gif',
            'png',
            'jpg',
            'jpeg',
            'webp',
            'mp4',
            'webm',
            'txt',
            'json',
            'md',
            'docx',
            'pptx',
            'epub',
            'csv',
            'ttf',
            'html',
            'svg',
            'pdf',
            'xlsx',
            'zip',
        ];
        const SAVE_TYPES = {
            gif: 'image/gif',
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            mp4: 'video/mp4',
            webm: 'video/webm',
            txt: 'text/plain',
            json: 'application/json',
            md: 'text/markdown',
            csv: 'text/csv',
            html: 'text/html',
            svg: 'image/svg+xml',
            pdf: 'application/pdf',
            zip: 'application/zip',
            ttf: 'font/ttf',
            epub: 'application/epub+zip',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
        const SAVE_WAIT_MS = 120000;
        let saving = null;
        const saves = new Map();
        let saveSeq = 0;
        const cleanName = (n) =>
            String(n)
                .replace(/[\p{Cc}\p{Cf}]/gu, '')
                .replace(/\s+/g, ' ')
                .replace(/[\\/]/g, '_')
                .trim();
        const downloads = Object.freeze({
            save: (req) =>
                traced(
                    'downloads.save',
                    new Promise((ok, no) => {
                        const r = req && typeof req === 'object' ? req : {};
                        if (typeof r.filename !== 'string' || !r.filename || r.filename.length > 512) {
                            return no(fail('bad_request', 'filename must be a string of 1-512 characters'));
                        }
                        if (r.request !== undefined) {
                            return no(
                                fail(
                                    'request_unknown',
                                    'no export request is open for this page: the local viewer never issues them',
                                ),
                            );
                        }
                        let name = cleanName(r.filename);
                        while (new TextEncoder().encode(name).length > 240) {
                            name = name.slice(0, -1);
                        }
                        const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase();
                        if (!ext || !SAVE_EXTS.includes(ext)) {
                            return no(
                                fail(
                                    'rejected_extension',
                                    `.${ext || '(none)'} is not a downloadable type; allowed: ${SAVE_EXTS.join(' ')}`,
                                ),
                            );
                        }
                        const d = r.data;
                        let blob;
                        if (typeof d === 'string') {
                            blob = new Blob([d], { type: SAVE_TYPES[ext] });
                        } else if (d instanceof Blob) {
                            blob = new Blob([d], { type: SAVE_TYPES[ext] });
                        } else if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) {
                            blob = new Blob([d instanceof ArrayBuffer ? d : d.slice ? d.slice() : d], {
                                type: SAVE_TYPES[ext],
                            });
                        }
                        if (!blob || !blob.size) {
                            return no(
                                fail(
                                    'bad_request',
                                    'data must be a non-empty string, Blob, ArrayBuffer or typed array',
                                ),
                            );
                        }
                        if (saving) {
                            return no(fail('rate_limited', 'a save prompt is already open'));
                        }
                        if (!framed) {
                            // a page opened on its own asks itself, with the dialog the runtime otherwise blocks
                            if (!confirm_(`Save "${name}" (${blob.size} bytes) from this artifact?`)) {
                                return no(fail('declined', 'the viewer declined the save'));
                            }
                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(blob);
                            a.download = name;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                            return ok({ status: 'saved' });
                        }
                        const id = ++saveSeq;
                        saving = id;
                        const done = (x, err) => {
                            saves.delete(id);
                            if (saving === id) {
                                saving = null;
                            }
                            clearTimeout(t);
                            if (err) {
                                no(err);
                            } else {
                                ok(x);
                            }
                        };
                        const t = setTimeout(
                            () => done(null, fail('declined', 'the save prompt expired')),
                            SAVE_WAIT_MS,
                        );
                        saves.set(id, done);
                        toParent({ type: 'download', id, filename: name, blob });
                    }),
                ),
        });

        // consent: what a page may do as the viewer (comment, read project files, ask Claude, call an mcp server) is asked
        // in the viewer, one batched dialog at a time; the daemon stores each grant and checks it on every call. a "no" lasts
        // this page load; a page opened on its own has no viewer to ask, so it gets only what was granted before
        let grantSet = null;
        const loadGrants = () =>
            grantSet
                ? Promise.resolve(grantSet)
                : call('/_frame/api/grants').then(
                      (r) => (grantSet = new Set(r.granted)),
                      () => (grantSet = new Set()),
                  );
        const deniedNow = new Set();
        let cfgP = null;
        const capsCfg = () =>
            (cfgP ??= call('/_frame/api/caps').then(
                (r) => r.capabilities || {},
                () => ({}),
            ));
        const consentNames = () =>
            capsCfg().then((c) => [
                ...(c.comments && c.comments.composer_only !== true ? ['comments'] : []),
                ...(c.files ? ['files'] : []),
            ]);
        let consentSeq = 0;
        const consents = new Map();
        const askConsent = (names) =>
            new Promise((ok) => {
                if (!framed || !names.length) {
                    return ok({});
                }
                const id = ++consentSeq;
                consents.set(id, ok);
                toParent({ type: 'consent', id, names });
            });
        const onConsentResult = (m) => {
            const ok = consents.get(m.id);
            if (!ok) {
                return;
            }
            consents.delete(m.id);
            const st = m.states && typeof m.states === 'object' ? m.states : {};
            for (const [n, v] of Object.entries(st)) {
                if (v === 'granted') {
                    (grantSet ??= new Set()).add(n);
                } else if (v === 'denied') {
                    deniedNow.add(n);
                }
            }
            ok(st);
        };
        // 'granted', 'denied' (the viewer said no), 'dismissed' (closed without answering), or 'busy' (another prompt is open)
        const consentFor = async (name) => {
            const g = await loadGrants();
            if (g.has(name)) {
                return 'granted';
            }
            if (deniedNow.has(name)) {
                return 'denied';
            }
            if (!framed) {
                return 'denied';
            }
            return (await askConsent([name]))[name] || 'dismissed';
        };

        // permissions are built in: a declared capability that needs no consent is usable at once (downloads confirms each save)
        const ALL_CAPS = ['artifact', 'assets', 'comments', 'db', 'downloads', 'files', 'room', 'self', 'user'];
        const one = (n, g) => (g.has(n) ? 'granted' : deniedNow.has(n) ? 'denied' : framed ? 'prompt' : 'unavailable');
        const stateOf = async (name) => {
            const n = String(name);
            const ask = await consentNames();
            const g = await loadGrants();
            if (!ALL_CAPS.includes(n) || !declared(n)) {
                return 'unavailable';
            }
            return ask.includes(n) ? one(n, g) : 'granted';
        };
        const stateMap = async (names) => {
            const list = names ? names.map(String) : ALL_CAPS.filter(declared);
            const entries = await Promise.all(list.map(async (n) => [n, await stateOf(n)]));
            return Object.fromEntries(names ? entries : entries.filter(([, v]) => v !== 'unavailable'));
        };
        let managing = null;
        const permissions = Object.freeze({
            state: (name) =>
                (name === undefined ? stateMap() : stateOf(name)).catch(() =>
                    name === undefined ? {} : 'unavailable',
                ),
            request: (names) =>
                (async () => {
                    const list = Array.isArray(names) ? names.map(String) : undefined;
                    const before = await stateMap(list);
                    const ask = Object.keys(before).filter((n) => before[n] === 'prompt');
                    if (ask.length) {
                        await askConsent(ask);
                    }
                    return stateMap(list);
                })().catch(() => ({})),
            manage: () => {
                if (!framed) {
                    return Promise.reject(
                        fail('unavailable', 'a page opened on its own has no Permissions panel; open it in the viewer'),
                    );
                }
                if (managing) {
                    return Promise.reject(fail('unavailable', 'the Permissions panel is already open'));
                }
                return new Promise((ok, no) => {
                    managing = (m) => {
                        managing = null;
                        if (m.refused) {
                            return no(
                                fail('unavailable', 'the Permissions panel did not open: another dialog is open'),
                            );
                        }
                        grantSet = null;
                        ok();
                    };
                    toParent({ type: 'manage' });
                });
            },
        });

        // `self` is the former name of `artifact`; either declaration serves both
        const declared = (name) =>
            caps.includes(name) ||
            ((name === 'artifact' || name === 'self') && (caps.includes('artifact') || caps.includes('self')));

        // comments, files and room live in caps.js, loaded when first used; comments needs comment mode's
        // internals, so its namespace is built further down and reached through capComments
        const LAZY = ['files', 'room'];
        let capsMod = null;
        const lazy = (name) =>
            (capsMod ??= import('/_frame/caps.js').then((m) =>
                m.boot({
                    call,
                    postJson,
                    fail,
                    traced,
                    record,
                    toParent,
                    onShell,
                    framed,
                    ver,
                    capsCfg,
                    consentFor,
                    loadGrants,
                    stringify,
                    fetch: fetch_,
                    ES,
                    userActive,
                }),
            )).then((x) => x[name] ?? null);
        const CAPS = { db, user, assets, artifact, self: artifact, downloads };
        const use = (name) =>
            Promise.resolve().then(async () => {
                if (name === 'permissions') {
                    return permissions;
                }
                if (declared(name) && name === 'comments') {
                    return capComments();
                }
                if (declared(name) && LAZY.includes(name)) {
                    return lazy(name);
                }
                if (declared(name) && CAPS[name]) {
                    return CAPS[name];
                }
                record({
                    kind: 'capability',
                    level: 'warn',
                    text: `claude.use("${String(name)}") resolved null: ${ALL_CAPS.includes(name) ? 'the page does not declare it' : 'no such capability'} (declared: ${caps.join(', ') || 'none'})`,
                    source: String(name),
                });
                return null;
            });

        // messages from the shell that a capability waits on, by type
        const shellHandlers = new Map();
        const onShell = (type, fn) => shellHandlers.set(type, fn);
        // a call made from the viewer's own click or key press (the browser's user activation)
        const userActive = () => !!(navigator.userActivation ? navigator.userActivation.isActive : true);

        // a page can resolve what is under the cursor inside one element (a 3d canvas) in comment mode:
        // pick(el, fn) with fn(clientX, clientY, { clicks }) -> { rect: {left, top, width, height}, label, snippet, image? } | null | false
        // (image: a data: url of what was clicked, as seen);
        // a hit without `rect` is highlighted by the page itself, so no box is drawn over it; null falls back to
        // the element, and false means nothing there takes a comment (no highlight, a click does nothing). to keep what a
        // comment is on highlighted, the element gets a cancelable `claude:focus` event, detail { snippet, inside }
        // or null to clear; a page that highlights it calls preventDefault(), and no box is drawn. document gets a
        // `claude:comment-mode` event, detail { on }, whenever comment mode turns on or off
        const pickers = new WeakMap();
        const pick = (el, fn) => {
            if (el instanceof Element && typeof fn === 'function') {
                pickers.set(el, fn);
            }
        };

        // and what a drawn area covers inside it: pickRect(el, fn) with fn({left, top, width, height}) in client px
        // -> { label, snippet, inside: [snippet, ...], image?: data: url of the area as drawn } | null, or a promise of it
        const areaPickers = new WeakMap();
        const pickRect = (el, fn) => {
            if (el instanceof Element && typeof fn === 'function') {
                areaPickers.set(el, fn);
            }
        };

        // hot: what a page hands its next version when a republish reaches this open view. snapshot(fn) registers fn, called
        // just before the reload, whose JSON-able result becomes the next version's hot.data; ready(start) calls start(data)
        const HOT_KEY = '__claude_hot';
        let hotData;
        guard(() => {
            const raw = sessionStorage.getItem(HOT_KEY);
            sessionStorage.removeItem(HOT_KEY);
            if (raw) {
                hotData = JSON.parse(raw);
            }
        })();
        let hotSnap = null;
        const hot = Object.freeze({
            data: hotData,
            snapshot: (fn) => {
                if (typeof fn === 'function') {
                    hotSnap = fn;
                }
            },
            ready: (start) => Promise.resolve().then(() => start(hotData ?? {})),
        });
        const saveHot = () => {
            if (!hotSnap) {
                return;
            }
            try {
                sessionStorage.setItem(HOT_KEY, stringify(hotSnap()));
            } catch (e) {
                record({
                    kind: 'error',
                    level: 'error',
                    text: `hot.snapshot failed, so this view starts fresh: ${show(e)}`,
                    source: 'hot',
                });
            }
        };

        window.claude = Object.freeze({ use, pick, pickRect, hot });

        // dialogs are blocked in the published viewer too; make them deterministic
        guard(() => {
            window.alert = () => undefined;
            window.confirm = () => false;
            window.prompt = () => null;
            window.print = () => undefined;
        })();

        // preflight: a version's reserved preflight.js runs in each open view of the one before, before that view reloads to it.
        // its default export gets { from, to } (version ids) and may return a promise; it has PREFLIGHT_MS
        const PREFLIGHT_MS = 3000;
        const preflight = (to) =>
            fetch_(`/v/${to}/preflight.js`, { method: 'HEAD' })
                .then((r) =>
                    !r.ok
                        ? undefined
                        : import(`/v/${to}/preflight.js`).then((m) =>
                              Promise.race([
                                  Promise.resolve(
                                      typeof m.default === 'function'
                                          ? m.default(Object.freeze({ from: ver, to }))
                                          : undefined,
                                  ),
                                  new Promise((r) => setTimeout(r, PREFLIGHT_MS)),
                              ]),
                          ),
                )
                .catch((e) =>
                    record({
                        kind: 'error',
                        level: 'error',
                        text: `preflight.js of version ${to} failed: ${show(e)}`,
                        source: 'preflight',
                    }),
                );

        // a republish reloads an open view at its next quiet moment: no button held, no input for QUIET_MS, or the tab hidden;
        // after QUIET_MAX_MS it reloads anyway. then the new version's preflight runs here and the page's hot snapshot is kept
        const QUIET_MS = 1500;
        const QUIET_MAX_MS = 30000;
        let lastInput = 0;
        let held = 0;
        const touched = () => (lastInput = Date.now());
        for (const ev of ['keydown', 'input', 'wheel']) {
            addEventListener(ev, touched, true);
        }
        addEventListener('pointerdown', () => (held++, (lastInput = Date.now())), true);
        const lifted = () => ((held = Math.max(0, held - 1)), (lastInput = Date.now()));
        for (const ev of ['pointerup', 'pointercancel']) {
            addEventListener(ev, lifted, true);
        }
        addEventListener('blur', () => (held = 0));
        const quiet = () =>
            new Promise((ok) => {
                const t0 = Date.now();
                const tick = () =>
                    document.hidden || (!held && Date.now() - lastInput >= QUIET_MS) || Date.now() - t0 >= QUIET_MAX_MS
                        ? ok()
                        : setTimeout(tick, 250);
                tick();
            });
        const beforeReload = (to) =>
            quiet()
                .then(() => preflight(to))
                .then(saveHot);

        // live updates

        guard(() => {
            if (!ES) {
                return;
            }
            const es = new ES('/_frame/events');
            let opened = false;
            es.addEventListener('open', () => {
                // after a reconnect, catch up on anything missed
                if (opened) {
                    for (const s of subs) {
                        s.run();
                    }
                }
                opened = true;
            });
            es.addEventListener(
                'version',
                guard((e) => {
                    // the viewer follows versions itself and runs preflight through us before it reloads the frame;
                    // a page's own save keeps it running
                    const d = JSON.parse(e.data);
                    if (ownSaves.delete(d.save)) {
                        ver = d.ver;
                        base = ver;
                    } else if (!framed && d.ver && d.ver !== ver) {
                        beforeReload(d.ver).then(() => location.replace(`/v/${d.ver}/${location.hash}`));
                    }
                }),
            );
            es.addEventListener(
                'db',
                guard((e) => onDb(JSON.parse(e.data).paths)),
            );
            es.addEventListener(
                'grants',
                guard((e) => (grantSet = new Set(JSON.parse(e.data).names))),
            );
        })();

        // comment mode, focus highlight and pins, drawn in a closed shadow root

        let mode = false;
        let pins = [];
        let focusEl = null;
        let focusTimer;
        let hoverEl = null;
        let hoverRect = null;
        let focusRect = null;
        let focusRegion = null;
        let pageFocus = null;
        let drag = null;
        let swallow = false;
        let hoverSeq = 0;

        // while a comment box is open in the shell, hover highlighting waits until it closes
        let drafting = false;

        // the open comment's anchors, the first one its own; and the page elements outlined besides the focus
        let picked = [];
        let extraEls = [];

        // where the draft's comment box goes: a point as fractions of its anchor element's box, so it follows scroll
        let draftAt = null;
        let lastAt = '';
        let host = null;
        let ui = null;
        let tick;
        const pinNodes = new Map();
        const cursor = guard(() => new CSSStyleSheet())();
        guard(() => cursor.replaceSync('*,*::before,*::after{cursor:crosshair!important}'))();

        const ensureHost = () => {
            if (host) {
                return;
            }
            host = document.createElement('claude-overlay');
            host.style.cssText =
                'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block';
            const sr = host.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = `
                .box{position:fixed;display:none;pointer-events:none;border-radius:4px;box-sizing:border-box;transition:all .08s ease-out}
                .hover{border:2px solid ${ACCENT};background:rgba(201,100,66,.08)}
                .focus{border:2px solid ${ACCENT};box-shadow:0 0 0 4px rgba(201,100,66,.25);background:rgba(201,100,66,.06)}
                .area{border:2px dashed ${ACCENT};background:rgba(201,100,66,.1);transition:none}
                .pin{position:fixed;pointer-events:auto;cursor:pointer;min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;
                    border-radius:11px 11px 11px 3px;background:${ACCENT};color:#fff;font:600 11px/22px -apple-system,BlinkMacSystemFont,sans-serif;
                    text-align:center;border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);transform:translate(-4px,-100%)}
                .pin:hover{filter:brightness(1.1)}`;
            const hover = document.createElement('div');
            hover.className = 'box hover';
            const focus = document.createElement('div');
            focus.className = 'box focus';
            const area = document.createElement('div');
            area.className = 'box area';
            const layer = document.createElement('div');
            const extra = document.createElement('div');
            sr.append(style, hover, focus, area, extra, layer);
            ui = { hover, focus, area, extra, layer };
            root.append(host);
            tick = setInterval(guard(layout), 500);
        };

        const dropHost = () => {
            if (!host || mode || pins.length || focusEl || draftAt || extraEls.length) {
                return;
            }
            clearInterval(tick);
            host.remove();
            host = null;
            ui = null;
            pinNodes.clear();
        };

        const place = (box, el) => {
            const r = el && (el.nodeType ? el.isConnected && el.getBoundingClientRect() : el);
            if (!r || (!r.width && !r.height)) {
                return (box.style.display = 'none');
            }
            Object.assign(box.style, {
                display: 'block',
                left: `${r.left - 2}px`,
                top: `${r.top - 2}px`,
                width: `${r.width + 4}px`,
                height: `${r.height + 4}px`,
            });
        };

        const find = (path) => guard(() => document.querySelector(path))() || null;

        // a region is an area's corners as fractions of its element's box
        const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
        const validRegion = (g) =>
            g && unit(g.x0) && unit(g.y0) && unit(g.x1) && unit(g.y1) && g.x0 < g.x1 && g.y0 < g.y1 ? g : null;
        const validAt = (a) => (a && unit(a.x) && unit(a.y) ? { x: a.x, y: a.y } : null);
        const regionRect = (el, g) => {
            const b = el.getBoundingClientRect();
            const [left, top, right, bottom] = [
                b.left + g.x0 * b.width,
                b.top + g.y0 * b.height,
                b.left + g.x1 * b.width,
                b.top + g.y1 * b.height,
            ];
            return { left, top, right, bottom, width: right - left, height: bottom - top };
        };

        const layout = () => {
            if (!ui) {
                return;
            }
            place(ui.hover, mode && !drag?.rect && (hoverRect ?? hoverEl));
            place(ui.focus, focusEl && focusRegion ? regionRect(focusEl, focusRegion) : (focusRect ?? focusEl));
            place(ui.area, drag?.rect);
            while (ui.extra.children.length < extraEls.length) {
                ui.extra.append(Object.assign(document.createElement('div'), { className: 'box focus' }));
            }
            [...ui.extra.children].forEach((b, i) => (i < extraEls.length ? place(b, extraEls[i]) : b.remove()));
            const at = new Map();
            const keep = new Set();
            const overlay = host;
            for (const p of pins) {
                const doc = custom?.placed.get(p.tid);
                const el = custom && !doc ? null : find(p.path);
                const r = el && (p.region ? regionRect(el, p.region) : el.getBoundingClientRect());
                let b = pinNodes.get(p.tid);
                if (!b) {
                    b = document.createElement('div');
                    b.className = 'pin';
                    b.title = 'Open comment';
                    b.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        toParent({ type: 'pin', tid: p.tid });
                    });
                    pinNodes.set(p.tid, b);
                    ui.layer.append(b);
                }
                keep.add(p.tid);
                b.textContent = String(p.n);
                const pt = doc ? { x: doc.x - scrollX, y: doc.y - scrollY } : el && pointOf(el, p);
                if (pt || pt === null) {
                    // a point the page draws: hidden off screen or under something else, such as another scene
                    // taken full screen; pins on the same spot fan out as they do on an element. the overlay is skipped:
                    // as the camera moves, the spot lands under this pin's last-frame box and would hide it every other frame
                    const hit = pt && document.elementsFromPoint(pt.x, pt.y).find((e) => e !== overlay);
                    const off =
                        !pt ||
                        pt.y < 0 ||
                        pt.y > innerHeight ||
                        pt.x < 0 ||
                        pt.x > innerWidth ||
                        (hit && !el.contains(hit) && !hit.contains(el));
                    if (off) {
                        b.style.display = 'none';
                        continue;
                    }
                    const spot = `${Math.round(pt.x / 12)},${Math.round(pt.y / 12)}`;
                    const n = at.get(spot) || 0;
                    at.set(spot, n + 1);
                    Object.assign(b.style, { display: 'block', left: `${pt.x + n * 26}px`, top: `${pt.y}px` });
                    continue;
                }
                if (!r || (!r.width && !r.height) || r.bottom < 0 || r.top > innerHeight) {
                    b.style.display = 'none';
                    continue;
                }
                const n = at.get(el) || 0;
                at.set(el, n + 1);
                Object.assign(b.style, {
                    display: 'block',
                    left: `${Math.max(4, Math.min(innerWidth - 30, r.right - 18 + n * 26))}px`,
                    top: `${Math.max(26, r.top + 4)}px`,
                });
            }
            for (const [tid, b] of pinNodes) {
                if (!keep.has(tid)) {
                    b.remove();
                    pinNodes.delete(tid);
                }
            }
            const d = atOf();
            const k = d && `${d.x},${d.y},${d.shown}`;
            if (d && k !== lastAt) {
                toParent({ type: 'at', at: d });
            }
            lastAt = k || '';
        };

        const atOf = () => {
            if (draftAt?.doc) {
                const [x, y] = [Math.round(draftAt.doc.x - scrollX), Math.round(draftAt.doc.y - scrollY)];
                return { x, y, shown: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight };
            }
            const el = draftAt?.el;
            const pt = el?.isConnected && pointOf(el, draftAt);
            if (!pt) {
                return el?.isConnected ? { x: 0, y: 0, shown: false } : null;
            }
            const [x, y] = [Math.round(pt.x), Math.round(pt.y)];
            return { x, y, shown: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight };
        };

        // where a comment sits: a page that draws its own scene answers claude:pin on its element with client
        // px (or hidden: true when the spot is off screen); otherwise the click, as fractions of the element's box
        const pointOf = (el, p) => {
            if (pickers.has(el) || areaPickers.has(el)) {
                const ev = new CustomEvent('claude:pin', {
                    detail: { snippet: p.snippet || '', inside: p.inside || [], x: null, y: null, hidden: false },
                });
                guard(() => el.dispatchEvent(ev))();
                const d = ev.detail;
                if (d.hidden === true) {
                    return null;
                }
                if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
                    return { x: d.x, y: d.y };
                }
            }
            if (!p.at) {
                return undefined;
            }
            const b = el.getBoundingClientRect();
            return { x: b.left + p.at.x * b.width, y: b.top + p.at.y * b.height };
        };

        let raf = 0;
        const schedule = () => {
            if (ui && !raf) {
                raf = requestAnimationFrame(() => ((raf = 0), guard(layout)()));
            }
        };
        addEventListener('scroll', schedule, { capture: true, passive: true });

        // a page whose content moves without scrolling (a 3d camera) asks for pins to follow; laid out at once,
        // so they move in the same frame the page draws
        document.addEventListener('claude:layout', guard(layout));
        addEventListener('resize', schedule, { passive: true });

        const setMode = (on) => {
            const was = mode;
            mode = !!on;
            hoverEl = null;
            hoverRect = null;
            drag = null;
            if (mode !== was) {
                guard(() => document.dispatchEvent(new CustomEvent('claude:comment-mode', { detail: { on: mode } })))();
            }
            if (mode !== was && custom) {
                guard(custom.cb.mode)(mode);
                if (!mode) {
                    custom.list = [];
                }
            }
            if (cursor) {
                const rest = document.adoptedStyleSheets.filter((s) => s !== cursor);
                document.adoptedStyleSheets = mode ? [...rest, cursor] : rest;
            }
            if (mode) {
                ensureHost();
            }
            schedule();
            dropHost();
        };

        // a picker element that draws the focus itself; true when it took it
        const focusPage = (el, detail) => {
            if (pageFocus && pageFocus !== el) {
                pageFocus.dispatchEvent(new CustomEvent('claude:focus', { detail: null }));
            }
            pageFocus = null;
            if (!el || !detail || !(pickers.has(el) || areaPickers.has(el))) {
                return false;
            }
            if (el.dispatchEvent(new CustomEvent('claude:focus', { detail, cancelable: true }))) {
                return false;
            }
            pageFocus = el;
            return true;
        };
        const detailOf = (a) => ({
            snippet: typeof a?.snippet === 'string' ? a.snippet : '',
            inside: Array.isArray(a?.inside) ? a.inside.filter((v) => typeof v === 'string').slice(0, INSIDE_MAX) : [],
        });

        const setFocus = (path, scroll, region, detail) => {
            clearTimeout(focusTimer);
            draftAt = null;
            picked = [];
            focusEl = path ? find(path) : null;
            focusRect = null;
            focusRegion = validRegion(region);

            // a thread's extra anchors: a page draws its own among them, the rest get boxes
            const also = (Array.isArray(detail?.also) ? detail.also : [])
                .map((a) => ({ el: find(a?.path), snippet: typeof a?.snippet === 'string' ? a.snippet : '' }))
                .filter((a) => a.el);
            extraEls = also.filter((a) => a.el !== focusEl).map((a) => a.el);
            const inside = [
                ...(detailOf(detail).inside || []),
                ...also.filter((a) => a.el === focusEl).map((a) => a.snippet),
            ];
            const byPage = guard(focusPage)(
                focusEl,
                focusEl && { snippet: detailOf(detail).snippet, inside: inside.slice(0, INSIDE_MAX + ALSO_MAX) },
            );
            if (focusEl) {
                ensureHost();
                if (scroll) {
                    focusEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
                if (byPage) {
                    focusEl = null;
                }
                focusTimer = setTimeout(
                    () => ((focusEl = null), (extraEls = []), guard(focusPage)(null), schedule(), dropHost()),
                    4000,
                );
            }
            schedule();
            dropHost();
        };

        const clipBytes = (s, n) => {
            const b = new TextEncoder().encode(s);
            return b.length <= n ? s : new TextDecoder().decode(b.slice(0, n)).replace(/�+$/, '');
        };
        const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();

        const cssPath = (el) => {
            const parts = [];
            for (let e = el; e && e.nodeType === 1 && parts.length < 10; e = e.parentElement) {
                if (e === root) {
                    parts.unshift('html');
                    break;
                }
                if (e.id) {
                    const s = `#${CSS.escape(e.id)}`;
                    if (document.querySelectorAll(s).length === 1) {
                        parts.unshift(s);
                        break;
                    }
                }
                const did = e.getAttribute('data-id');
                if (did) {
                    const s = `[data-id="${CSS.escape(did)}"]`;
                    if (document.querySelectorAll(s).length === 1) {
                        parts.unshift(s);
                        break;
                    }
                }
                const tag = CSS.escape(e.localName);
                let i = 1;
                let dup = false;
                for (let s = e.previousElementSibling; s; s = s.previousElementSibling) {
                    if (s.localName === e.localName) {
                        i++;
                    }
                }
                for (let s = e.nextElementSibling; s && !dup; s = s.nextElementSibling) {
                    dup = s.localName === e.localName;
                }
                parts.unshift(i > 1 || dup ? `${tag}:nth-of-type(${i})` : tag);
            }
            return parts.join(' > ');
        };

        const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role=heading]';
        const labelOf = (el) => {
            const hs = document.querySelectorAll(HEADINGS);
            for (let i = hs.length - 1; i >= 0; i--) {
                const h = hs[i];
                if (h === el || h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    const t = squash(h.textContent);
                    if (t) {
                        return t.slice(0, 128);
                    }
                }
            }
            return undefined;
        };

        const snippetOf = (el) => {
            const open = el.cloneNode(false).outerHTML.replace(/<\/[^>]+>$/, '');
            return `${open}${squash(el.textContent)}`.slice(0, 200);
        };

        const anchorOf = (target) => {
            let el = target;
            let quote;
            const sel = getSelection();
            if (sel && !sel.isCollapsed && sel.rangeCount) {
                const c = sel.getRangeAt(0).commonAncestorContainer;
                const ce = c.nodeType === 1 ? c : c.parentElement;
                if (ce && (el.contains(ce) || ce.contains(el))) {
                    el = ce;
                    quote = clipBytes(squash(sel.toString()), QUOTE_BYTES) || undefined;
                }
            }
            if (el === document.body || el === root) {
                el = target;
            }
            const a = { path: cssPath(el), snippet: snippetOf(el) };
            const label = labelOf(el);
            if (label) {
                a.label = label;
            }
            if (quote) {
                a.span = { quote };
            }
            return { el, anchor: a };
        };

        const inside = (e) => host && e.composedPath && e.composedPath().includes(host);

        const pickerOf = (el, map = pickers) => {
            for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
                if (map.has(n)) {
                    return [n, map.get(n)];
                }
            }
            return [];
        };
        const finite = (n) => typeof n === 'number' && Number.isFinite(n);
        const rectOf = (r) => {
            const b = r && r.rect;
            return b && [b.left, b.top, b.width, b.height].every(finite)
                ? { left: b.left, top: b.top, width: b.width, height: b.height }
                : null;
        };
        const text = (v, max) => (typeof v === 'string' && v ? clipBytes(squash(v), max) : undefined);
        // how.clicks: 0 for a hover, else the click count, so a double-click can mean something narrower
        const resolve = (fn, x, y, clicks = 0) => Promise.resolve(guard(fn)(x, y, { clicks })).catch(() => null);

        addEventListener(
            'mousemove',
            guard((e) => {
                if (!mode || custom || drafting || inside(e) || drag?.rect) {
                    return;
                }
                const [pel, fn] = pickerOf(e.target);
                if (fn) {
                    const seq = ++hoverSeq;
                    resolve(fn, e.clientX, e.clientY).then((r) => {
                        if (seq !== hoverSeq) {
                            return;
                        }

                        // a hit without a rect is the page's to highlight; null outlines the element, false nothing
                        hoverRect = rectOf(r);
                        hoverEl = r === false || (r && !hoverRect) ? null : pel;
                        schedule();
                    });
                    return;
                }
                hoverSeq++;
                hoverRect = null;
                if (e.target !== hoverEl && e.target.nodeType === 1) {
                    hoverEl = e.target;
                    schedule();
                }
            }),
            { capture: true, passive: true },
        );
        addEventListener(
            'mouseout',
            (e) => {
                if (e.relatedTarget) {
                    return;
                }
                hoverEl = null;
                hoverRect = null;
                schedule();
            },
            { passive: true },
        );

        // comment mode: a drag that starts on text selects it for a quote; one anywhere else draws an area

        const onText = (x, y) => {
            const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
            const p = !r && document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
            const n = r ? r.startContainer : p && p.offsetNode;
            if (!n || n.nodeType !== 3 || !n.textContent.trim()) {
                return false;
            }
            const t = document.createRange();
            t.selectNodeContents(n);
            return [...t.getClientRects()].some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
        };
        const covers = (b, r) =>
            b.left <= r.left + 1 && b.top <= r.top + 1 && b.right >= r.right - 1 && b.bottom >= r.bottom - 1;
        const overlap = (b, r) =>
            Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left)) *
            Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
        const regionOf = (el, r) => {
            const b = el.getBoundingClientRect();
            const f = (v, o, n) => Math.round(Math.min(1, Math.max(0, n ? (v - o) / n : 0)) * 1000) / 1000;
            return validRegion({
                x0: f(r.left, b.left, b.width),
                y0: f(r.top, b.top, b.height),
                x1: f(r.right, b.left, b.width),
                y1: f(r.bottom, b.top, b.height),
            });
        };

        // the outermost elements at least half inside the area, in page order
        const coveredBy = (el, r) => {
            const out = [];
            let n = 0;
            for (const c of el.querySelectorAll('*')) {
                if (++n > SCAN_MAX || out.length >= INSIDE_MAX) {
                    break;
                }
                if (c === host || out.some((o) => o.contains(c))) {
                    continue;
                }
                const b = c.getBoundingClientRect();
                if (b.width * b.height && overlap(b, r) >= (b.width * b.height) / 2) {
                    out.push(c);
                }
            }
            return out;
        };

        // the open comment gains anchors after its first (toggle: a second Shift+click takes one out); all stay outlined
        const extend = (items, toggle = false) => {
            for (const it of items) {
                const i = picked.findIndex(
                    (x) => x.anchor.path === it.anchor.path && x.anchor.snippet === it.anchor.snippet,
                );
                if (i > 0 && toggle) {
                    picked = picked.filter((_, k) => k !== i);
                } else if (i < 0 && picked.length <= ALSO_MAX) {
                    picked.push(it);
                }
            }
            const [first, ...rest] = picked;
            const own = rest.filter((x) => x.el === first.el && (pickers.has(x.el) || areaPickers.has(x.el)));
            extraEls = rest.filter((x) => !own.includes(x)).map((x) => x.el);
            if (own.length || pageFocus === first.el) {
                guard(focusPage)(first.el, {
                    snippet: first.anchor.snippet,
                    inside: [...(first.anchor.inside || []), ...own.map((x) => x.anchor.snippet)],
                });
            }
            ensureHost();
            schedule();
            toParent({ type: 'anchor', anchor: first.anchor, also: rest.map((x) => x.anchor), at: atOf() });
        };

        // `pt` is where the comment box opens: the click, or an area's bottom-left corner
        const mark = (el, region, anchor, rect, pt, add) => {
            // Shift+click adds to the open comment, or takes out what it already holds
            if (add && picked.length) {
                return extend([{ el, anchor }], true);
            }
            picked = [{ el, anchor }];
            extraEls = [];
            const byPage = guard(focusPage)(el, detailOf(anchor));
            focusEl = byPage ? null : el;
            focusRect = byPage ? null : rect;
            focusRegion = region;
            clearTimeout(focusTimer);
            const b = el.getBoundingClientRect();
            const f = (v, o, n) => (n ? Math.min(1, Math.max(0, (v - o) / n)) : 0);
            // an area's box opens at its corner, not at the scene point its pin uses
            draftAt = {
                el,
                at: { x: f(pt.x, b.left, b.width), y: f(pt.y, b.top, b.height) },
                snippet: region ? '' : anchor.snippet,
                inside: region ? [] : anchor.inside,
            };
            anchor.at = { x: Math.round(draftAt.at.x * 1000) / 1000, y: Math.round(draftAt.at.y * 1000) / 1000 };
            const at = atOf();
            lastAt = at ? `${at.x},${at.y},${at.shown}` : '';
            ensureHost();
            schedule();
            toParent({ type: 'anchor', anchor, at });
        };

        // Shift+drag adds what the area covers to the open comment instead of starting a new one
        const drawn = (r, x, y, add) => {
            const [pel, fn] = pickerOf(document.elementFromPoint(x, y), areaPickers);
            if (pel) {
                const b = pel.getBoundingClientRect();
                const [left, top] = [Math.max(r.left, b.left), Math.max(r.top, b.top)];
                const [right, bottom] = [Math.min(r.right, b.right), Math.min(r.bottom, b.bottom)];
                const c = { left, top, right, bottom, width: right - left, height: bottom - top };
                const region = c.width > 0 && c.height > 0 && regionOf(pel, c);
                if (!region) {
                    return;
                }
                return Promise.resolve(guard(fn)({ left, top, width: c.width, height: c.height }))
                    .catch(() => null)
                    .then((res) => {
                        const a = {
                            path: cssPath(pel),
                            snippet: text(res && res.snippet, 200) || snippetOf(pel),
                            region,
                        };
                        const label = text(res && res.label, 128) || labelOf(pel);
                        const ins = (Array.isArray(res && res.inside) ? res.inside : [])
                            .map((v) => text(v, 200))
                            .filter(Boolean)
                            .slice(0, INSIDE_MAX);
                        const img = res && res.image;
                        if (label) {
                            a.label = label;
                        }
                        if (ins.length) {
                            a.inside = ins;
                        }
                        if (typeof img === 'string' && img.length <= IMAGE_MAX_CHARS && IMAGE_RE.test(img)) {
                            a.image = img;
                        }
                        // added objects share the area's capture: it rides on the first of them
                        if (add && picked.length) {
                            return extend(
                                ins.map((snippet, i) => ({
                                    el: pel,
                                    anchor: { path: a.path, snippet, ...(i === 0 && a.image && { image: a.image }) },
                                })),
                            );
                        }
                        mark(pel, region, a, null, { x: left, y: bottom });
                    });
            }
            let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            while (el && el !== root && !covers(el.getBoundingClientRect(), r)) {
                el = el.parentElement;
            }
            el = el || root;
            const region = regionOf(el, r);
            if (!region) {
                return;
            }
            const a = { path: cssPath(el), snippet: snippetOf(el), region };
            const label = labelOf(el);
            const covered = coveredBy(el, r);
            if (add && picked.length) {
                return extend(
                    covered.map((c) => ({
                        el: c,
                        anchor: JSON.parse(
                            JSON.stringify({ path: cssPath(c), snippet: snippetOf(c), label: labelOf(c) }),
                        ),
                    })),
                );
            }
            if (label) {
                a.label = label;
            }
            if (covered.length) {
                a.inside = covered.map(snippetOf);
            }
            mark(el, region, a, null, { x: r.left, y: r.bottom });
        };

        addEventListener(
            'pointerdown',
            guard((e) => {
                if (!mode || custom || inside(e) || e.button !== 0) {
                    return;
                }
                // with Shift held, text is picked like any element rather than selected
                if (
                    !e.shiftKey &&
                    !pickerOf(e.target)[0] &&
                    !pickerOf(e.target, areaPickers)[0] &&
                    onText(e.clientX, e.clientY)
                ) {
                    return;
                }

                // the page never sees presses in comment mode: no camera orbit, no button press. that also keeps the
                // browser from focusing the page, so it takes focus itself and its keys (a 3d camera's W/A/S/D) still work
                guard(() => window.focus())();
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (e.pointerType === 'touch') {
                    return;
                }
                drag = { x: e.clientX, y: e.clientY, rect: null };
            }),
            true,
        );
        addEventListener(
            'pointermove',
            guard((e) => {
                if (!drag || (!drag.rect && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP)) {
                    return;
                }

                // capture only once it is a drag, so the release lands here even outside the page; a plain
                // click stays uncaptured, or the browser would retarget it to <html>
                if (!drag.rect) {
                    guard(() => root.setPointerCapture(e.pointerId))();
                }
                const [left, top, right, bottom] = [
                    Math.min(drag.x, e.clientX),
                    Math.min(drag.y, e.clientY),
                    Math.max(drag.x, e.clientX),
                    Math.max(drag.y, e.clientY),
                ];
                drag.rect = { left, top, right, bottom, width: right - left, height: bottom - top };
                schedule();
            }),
            { capture: true, passive: true },
        );
        addEventListener(
            'pointerup',
            guard((e) => {
                const d = drag;
                drag = null;
                schedule();
                if (!d || !d.rect) {
                    return;
                }

                // the click that follows a drag lands on <html> (the capture), so the drag answers for it
                swallow = true;
                setTimeout(() => (swallow = false), 0);
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (d.rect.width >= AREA_MIN && d.rect.height >= AREA_MIN) {
                    drawn(d.rect, d.x, d.y, e.shiftKey);
                } else {
                    point(document.elementFromPoint(d.x, d.y), d.x, d.y, 1, e.shiftKey);
                }
            }),
            true,
        );
        addEventListener('pointercancel', () => ((drag = null), schedule()), true);

        const point = (target, x, y, clicks, add) => {
            if (!target) {
                return;
            }
            const [pel, fn] = pickerOf(target);
            if (fn) {
                resolve(fn, x, y, clicks).then((r) => {
                    if (r === false) {
                        return;
                    }
                    const a = { path: cssPath(pel), snippet: text(r && r.snippet, 200) || snippetOf(pel) };
                    const label = text(r && r.label, 128) || labelOf(pel);
                    const img = r && r.image;
                    if (label) {
                        a.label = label;
                    }
                    if (typeof img === 'string' && img.length <= IMAGE_MAX_CHARS && IMAGE_RE.test(img)) {
                        a.image = img;
                    }
                    mark(pel, null, a, rectOf(r), { x, y }, add);
                });
                return;
            }
            const { el, anchor } = anchorOf(target);
            mark(el, null, anchor, null, { x, y }, add);
        };

        addEventListener(
            'click',
            guard((e) => {
                if (!mode || custom || inside(e)) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (swallow) {
                    return (swallow = false);
                }
                point(e.target, e.clientX, e.clientY, e.detail || 1, e.shiftKey);
            }),
            true,
        );

        addEventListener(
            'keydown',
            guard((e) => {
                if (e.key !== 'Escape' || !mode) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();

                // the shell decides: close an open draft, or leave comment mode
                toParent({ type: 'dismiss' });
            }),
            true,
        );

        // C toggles comment mode, unless the page took the key or it was typed into a field
        addEventListener(
            'keydown',
            guard((e) => {
                if (
                    e.defaultPrevented ||
                    e.repeat ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.altKey ||
                    e.key.toLowerCase() !== 'c'
                ) {
                    return;
                }
                const t = e.composedPath()[0];
                if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
                    return;
                }
                toParent({ type: 'mode', on: !mode });
            }),
        );

        // the comments capability: the page opens the shell's composer, or writes threads as the viewer once they allow it

        let custom = null;
        let lastThreads = [];
        let draftTyped = false;
        const composeChecks = new Map();
        let composeSeq = 0;
        let lastCompose = 0;
        const COMPOSE_GAP_MS = 300;
        const minted = new Set();

        // asks the shell whether a composer may open: never over one holding the viewer's typed text
        const composeCheck = () =>
            new Promise((ok) => {
                const id = ++composeSeq;
                const t = setTimeout(() => (composeChecks.delete(id), ok({ ok: false })), 2000);
                composeChecks.set(id, (m) => (clearTimeout(t), composeChecks.delete(id), ok(m)));
                toParent({ type: 'compose-check', id });
            });
        const composeGate = async () => {
            if (Date.now() - lastCompose < COMPOSE_GAP_MS) {
                throw fail('rate_limited', 'opening the composer too often');
            }
            lastCompose = Date.now();
            if (!document.hasFocus() && !userActive()) {
                return false;
            }
            return (await composeCheck()).ok === true;
        };
        const centerOf = (el) => {
            const b = el.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        };
        const uncommentable = (el) => !!(el.closest && el.closest('[data-uncommentable]'));
        const plain = (t, name) => {
            if (typeof t !== 'string' || !t.trim()) {
                throw fail('invalid', `${name} is empty`);
            }
            if (new TextEncoder().encode(t).length > 4096) {
                throw fail('invalid', `${name} is over 4 KiB as UTF-8`);
            }
            // eslint-disable-next-line no-control-regex -- rejects control characters
            if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) {
                throw fail('invalid', `${name} carries control characters other than newlines and tabs`);
            }
            return t;
        };
        const commentsCall = (label, method, path, data) =>
            traced(
                `comments.${label}`,
                call(
                    `/_frame/api/comments${path}`,
                    method === 'GET'
                        ? undefined
                        : { method, headers: { 'content-type': 'application/json' }, body: stringify(data ?? {}) },
                ).then((r) => {
                    if (r && r.error) {
                        throw fail(r.error.code, r.error.message);
                    }
                    return r;
                }),
            );
        const withConsent = async (fn) => {
            const st = await consentFor('comments');
            if (st === 'denied') {
                throw fail('forbidden', 'the viewer chose not to let this page comment as them');
            }
            if (st !== 'granted') {
                throw fail('consent_required', 'the viewer has not allowed this page to comment as them');
            }
            return fn();
        };
        const pageAnchor = (a) => {
            if (
                !a ||
                typeof a !== 'object' ||
                typeof a.path !== 'string' ||
                !a.path ||
                ![a.x, a.y].every((n) => typeof n === 'number' && n >= 0 && n <= 1)
            ) {
                throw fail('invalid', 'anchor must come from anchorFor()');
            }
            const out = { path: a.path, at: { x: a.x, y: a.y } };
            const el = find(a.path);
            if (el) {
                Object.assign(out, { snippet: snippetOf(el), ...(labelOf(el) && { label: labelOf(el) }) });
            }
            return out;
        };
        const threadId = (t) => {
            if (typeof t !== 'string' || !/^[0-9a-f-]{36}$/.test(t)) {
                throw fail('invalid', 'malformed threadId');
            }
            return t;
        };
        const settle = (fn) => Promise.resolve().then(fn);

        const makeComments = (cfg) => {
            const composerOnly = cfg.composer_only === true;
            const writes = (fn) =>
                composerOnly
                    ? Promise.reject(
                          fail(
                              'not_granted',
                              'the artifact declares comments composer_only, which grants no write verbs',
                          ),
                      )
                    : settle(fn);
            const openAt = (el, anchor, pt) => {
                if (!mode) {
                    toParent({ type: 'mode', on: true });
                }
                mark(el, null, anchor, null, pt, false);
            };
            return Object.freeze({
                openComposer: (target) =>
                    settle(async () => {
                        const t = target && typeof target === 'object' ? target : {};
                        if (t.element instanceof Element && t.element.isConnected) {
                            if (uncommentable(t.element) || !(await composeGate())) {
                                return { opened: false };
                            }
                            openAt(t.element, anchorOf(t.element).anchor, centerOf(t.element));
                            return { opened: true };
                        }
                        if (t.range instanceof Range && t.range.commonAncestorContainer.isConnected) {
                            const c = t.range.commonAncestorContainer;
                            const el = c.nodeType === 1 ? c : c.parentElement;
                            if (!el || uncommentable(el) || !(await composeGate())) {
                                return { opened: false };
                            }
                            const a = { path: cssPath(el), snippet: snippetOf(el) };
                            const label = labelOf(el);
                            if (label) {
                                a.label = label;
                            }
                            const q = squash(t.range.toString());
                            if (q && new TextEncoder().encode(q).length <= QUOTE_BYTES) {
                                a.span = { quote: q };
                            }
                            const r = t.range.getBoundingClientRect();
                            openAt(el, a, r.width || r.height ? { x: r.left, y: r.bottom } : centerOf(el));
                            return { opened: true };
                        }
                        throw fail('invalid', 'target must be {element} or {range}, attached to the document');
                    }),
                anchorFor: (el) =>
                    settle(() => {
                        if (!(el instanceof Element) || !el.isConnected) {
                            throw fail('invalid', 'not an element attached to the document');
                        }
                        return Object.freeze({ path: cssPath(el), x: 0.5, y: 0.5 });
                    }),
                create: (o) =>
                    writes(() => {
                        const anchor = pageAnchor(o && o.anchor);
                        const text = plain(o && o.text, 'text');
                        return withConsent(() => commentsCall('create', 'POST', '', { anchor, text }));
                    }),
                reply: (tid, t) =>
                    writes(
                        () => (
                            threadId(tid),
                            plain(t, 'text'),
                            withConsent(() =>
                                commentsCall('reply', 'POST', `/${tid}/reply`, { text: t }).then((r) => ({
                                    commentId: r.commentId,
                                })),
                            )
                        ),
                    ),
                sendToClaude: (target) =>
                    writes(() => {
                        // only from the viewer's own recent gesture, checked before anything is written
                        if (!userActive()) {
                            throw fail(
                                'claude_unavailable',
                                "sendToClaude must be called from the viewer's own click or key press",
                            );
                        }
                        const o = target && typeof target === 'object' ? target : {};
                        const text = plain(o.text, 'text');
                        if ('anchor' in o === 'threadId' in o) {
                            throw fail('invalid', 'pass exactly one of anchor or threadId');
                        }
                        return withConsent(() =>
                            o.threadId !== undefined
                                ? commentsCall('sendToClaude', 'POST', `/${threadId(o.threadId)}/reply`, {
                                      text,
                                      toClaude: true,
                                  })
                                : commentsCall('sendToClaude', 'POST', '', {
                                      anchor: pageAnchor(o.anchor),
                                      text,
                                      toClaude: true,
                                  }),
                        );
                    }),
                canSendToClaude: () =>
                    composerOnly
                        ? Promise.resolve('off')
                        : commentsCall('canSendToClaude', 'GET', '/can-send').then(
                              (r) => r.state,
                              () => 'off',
                          ),
                resolve: (tid, resolved) =>
                    writes(
                        () => (
                            threadId(tid),
                            withConsent(() =>
                                commentsCall('resolve', 'POST', `/${tid}/resolve`, {
                                    resolved: resolved !== false,
                                }).then(() => undefined),
                            )
                        ),
                    ),
                delete: (tid) =>
                    writes(
                        () => (
                            threadId(tid),
                            withConsent(() => commentsCall('delete', 'DELETE', `/${tid}`).then(() => undefined))
                        ),
                    ),
                customAnchors: (cb) =>
                    settle(() => {
                        if (cfg.customAnchors !== true) {
                            throw fail(
                                'not_granted',
                                'the artifact\'s comments declaration does not carry "customAnchors": true',
                            );
                        }
                        if (custom) {
                            throw fail('invalid', 'customAnchors is already registered; release() it first');
                        }
                        if (!cb || !['mode', 'threads', 'reveal'].every((k) => typeof cb[k] === 'function')) {
                            throw fail('invalid', 'customAnchors needs mode, threads and reveal callbacks');
                        }
                        const me = { cb, placed: new Map(), list: [], reported: false, released: false };
                        custom = me;
                        hoverEl = null;
                        hoverRect = null;
                        schedule();
                        const live = () => custom === me;
                        const docPoint = (at) => {
                            if (at instanceof Element) {
                                if (!at.isConnected) {
                                    throw fail('invalid', 'at is an element not attached to the document');
                                }
                                const c = centerOf(at);
                                return { x: c.x + scrollX, y: c.y + scrollY };
                            }
                            if (at && [at.x, at.y].every((n) => typeof n === 'number' && Number.isFinite(n))) {
                                return { x: at.x, y: at.y };
                            }
                            throw fail('invalid', 'at must be an Element or a {x, y} document point');
                        };
                        const clip = (v, name) => {
                            if (v === undefined || v === '') {
                                return undefined;
                            }
                            if (typeof v !== 'string' || v.length > 1024) {
                                throw fail('invalid', `${name} must be plain text of at most 1024 characters`);
                            }
                            return squash(v.replace(/[\p{Cc}\p{Cf}]/gu, '')) || undefined;
                        };
                        setTimeout(() => {
                            if (!live()) {
                                return;
                            }
                            guard(cb.mode)(mode);
                            if (cb.composing) {
                                guard(cb.composing)(drafting);
                            }
                            if (mode) {
                                me.list = lastThreads;
                                guard(cb.threads)(lastThreads);
                            }
                        });
                        return Object.freeze({
                            compose: (anchor, at, opts = {}) =>
                                settle(async () => {
                                    if (!live()) {
                                        throw fail('invalid', 'released');
                                    }
                                    if (
                                        typeof anchor !== 'string' ||
                                        !anchor ||
                                        new TextEncoder().encode(anchor).length > 128 ||
                                        /[\p{Cc}\p{Cf}]/u.test(anchor)
                                    ) {
                                        if (!minted.has(anchor)) {
                                            throw fail(
                                                'invalid',
                                                'anchor must be 1-128 bytes with no control or invisible characters, or a domAnchor path',
                                            );
                                        }
                                    }
                                    if (composerOnly && !minted.has(anchor)) {
                                        throw fail('invalid', 'under composer_only only domAnchor paths are kept');
                                    }
                                    if (at instanceof Element && uncommentable(at)) {
                                        return { opened: false };
                                    }
                                    const pt = docPoint(at);
                                    const label = clip(opts.label, 'label');
                                    const detail = clip(opts.detail, 'detail');
                                    if (drafting && (!draftTyped || opts.area !== true)) {
                                        // acts as the viewer's click: an open box closes (one with typed text stays, unless an area moves it)
                                        if (!draftTyped) {
                                            toParent({ type: 'dismiss' });
                                        }
                                        return { opened: false };
                                    }
                                    if (!(await composeGate()) && !(drafting && opts.area === true)) {
                                        return { opened: false };
                                    }
                                    if (!mode) {
                                        toParent({ type: 'mode', on: true });
                                    }
                                    draftAt = { doc: pt };
                                    focusEl = null;
                                    picked = [];
                                    ensureHost();
                                    schedule();
                                    toParent({
                                        type: 'anchor',
                                        anchor: {
                                            path: anchor,
                                            ...(label && { label }),
                                            ...(detail && { snippet: detail.slice(0, 200) }),
                                        },
                                        at: atOf(),
                                    });
                                    return { opened: true };
                                }),
                            open: (id, at) =>
                                settle(() => {
                                    if (!live()) {
                                        throw fail('invalid', 'released');
                                    }
                                    if (typeof id !== 'string') {
                                        throw fail('invalid', 'malformed id');
                                    }
                                    docPoint(at);
                                    if (me.list.some((t) => t.id === id)) {
                                        toParent({ type: 'pin', tid: id });
                                    }
                                }),
                            placed: (map) => {
                                if (!live()) {
                                    return;
                                }
                                me.placed = new Map(
                                    Object.entries(map && typeof map === 'object' ? map : {})
                                        .filter(([, v]) => v && Number.isFinite(v.x) && Number.isFinite(v.y))
                                        .map(([k, v]) => [k, { x: v.x, y: v.y }]),
                                );
                                me.reported = true;
                                if (pins.length) {
                                    ensureHost();
                                }
                                schedule();
                            },
                            domAnchor: (el, ev) => {
                                if (!(el instanceof Element) || !el.isConnected) {
                                    throw new TypeError('domAnchor: the element is not in the document');
                                }
                                const path = cssPath(el);
                                minted.add(path);
                                const c = centerOf(el);
                                const x = ev && Number.isFinite(ev.clientX) ? ev.clientX : c.x;
                                const y = ev && Number.isFinite(ev.clientY) ? ev.clientY : c.y;
                                return [path, { x: x + scrollX, y: y + scrollY }];
                            },
                            exitMode: () => live() && mode && !draftTyped && toParent({ type: 'mode', on: false }),
                            release: () => {
                                if (!live()) {
                                    return;
                                }
                                custom = null;
                                schedule();
                            },
                            get areas() {
                                return live() && mode && !(drafting && draftTyped);
                            },
                        });
                    }),
            });
        };
        let commentsNs = null;
        const capComments = () =>
            framed
                ? (commentsNs ??= capsCfg().then((c) =>
                      makeComments(c.comments && typeof c.comments === 'object' ? c.comments : {}),
                  ))
                : Promise.resolve(null);

        // messages from the shell

        addEventListener(
            'message',
            guard((e) => {
                if (!framed || e.source !== window.parent || e.origin !== shell) {
                    return;
                }
                const m = e.data;
                if (!m || m.da !== 1) {
                    return;
                }
                if (m.type === 'theme') {
                    setTheme(m.theme);
                } else if (m.type === 'mode') {
                    setMode(m.on);
                } else if (m.type === 'fullscreen') {
                    setFull(m.on === true);
                } else if (m.type === 'draft') {
                    drafting = m.open === true;
                    hoverSeq++;
                    hoverEl = null;
                    hoverRect = null;
                    schedule();
                    guard(() =>
                        document.dispatchEvent(new CustomEvent('claude:draft', { detail: { open: drafting } })),
                    )();
                    draftTyped = m.typed === true;
                    if (custom?.cb.composing) {
                        guard(custom.cb.composing)(drafting);
                    }
                } else if (m.type === 'before-reload' && typeof m.ver === 'string') {
                    toParent({ type: 'reload-ack', ver: m.ver });
                    beforeReload(m.ver).then(() => toParent({ type: 'reload-ready', ver: m.ver }));
                } else if (m.type === 'consent-result') {
                    onConsentResult(m);
                } else if (m.type === 'manage-closed') {
                    managing?.(m);
                } else if (shellHandlers.has(m.type)) {
                    guard(shellHandlers.get(m.type))(m);
                } else if (m.type === 'download-result') {
                    const done = saves.get(m.id);
                    if (done) {
                        if (m.status === 'saved') {
                            done({ status: 'saved' });
                        } else {
                            done(null, fail(m.code || 'declined', m.message || 'the viewer declined the save'));
                        }
                    }
                } else if (m.type === 'focus') {
                    if (
                        custom &&
                        typeof m.tid === 'string' &&
                        custom.reported &&
                        custom.list.some((t) => t.id === m.tid)
                    ) {
                        guard(custom.cb.reveal)(m.tid);
                    }
                    setFocus(typeof m.path === 'string' ? m.path : null, m.scroll !== false, m.region, m);
                } else if (m.type === 'threads') {
                    const list = (Array.isArray(m.list) ? m.list : [])
                        .filter((t) => t && typeof t.tid === 'string' && typeof t.path === 'string')
                        .slice(0, 256);
                    lastThreads = list.map((t) =>
                        Object.freeze({
                            id: t.tid,
                            anchor: t.path,
                            resolved: t.resolved === true,
                            active: t.active === true,
                        }),
                    );
                    if (custom && mode) {
                        custom.list = lastThreads;
                        guard(custom.cb.threads)(lastThreads);
                    }
                } else if (m.type === 'compose-ok') {
                    composeChecks.get(m.id)?.(m);
                } else if (m.type === 'pins') {
                    pins = Array.isArray(m.pins)
                        ? m.pins
                              .filter((p) => p && typeof p.path === 'string')
                              .slice(0, 200)
                              .map((p) => ({ ...p, region: validRegion(p.region), at: validAt(p.at) }))
                        : [];
                    if (pins.length) {
                        ensureHost();
                    }
                    schedule();
                    dropHost();
                }
            }),
        );

        toParent({ type: 'ready', ver });
    };

    try {
        boot();
    } catch {
        // never let a runtime failure break the page
    }
})();
