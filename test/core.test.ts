import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'da-test-'));
process.env['SPATIAL_ARTIFACTS_DIR'] = HOME;
const { startDaemon } = await import('../plugins/spatial-artifacts/server/daemon.ts');
const { findTitle, unwrap, wrapHtml } = await import('../plugins/spatial-artifacts/server/wrap.ts');
const { claudeStatus } = await import('../plugins/spatial-artifacts/server/store.ts');
const { CLAUDE_WORK_MS } = await import('../plugins/spatial-artifacts/server/constants.ts');

type Res = { status: number; body: any; headers: Record<string, unknown> };
const http = (
    port: number,
    method: string,
    path: string,
    opts: { host?: string; headers?: Record<string, string>; body?: unknown } = {},
) =>
    new Promise<Res>((ok) => {
        const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
        const req = request(
            {
                host: '127.0.0.1',
                port,
                method,
                path,
                headers: {
                    host: opts.host ?? `localhost:${port}`,
                    ...(data && { 'content-type': 'application/json' }),
                    ...opts.headers,
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const t = Buffer.concat(chunks).toString();
                    ok({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: String(res.headers['content-type']).startsWith('application/json') ? JSON.parse(t) : t,
                    });
                });
            },
        );
        req.end(data);
    });

describe('wrap', () => {
    test('wraps a fragment once and re-wrapping does not nest', () => {
        const w = wrapHtml('<title>A</title><p>x</p>');
        assert.ok(w.startsWith('<!doctype html><html><head><meta charset=utf8>'));
        assert.equal(wrapHtml(w), w);
        assert.equal(unwrap(w), '<title>A</title><p>x</p>');
    });
    test("a page's live dom saves without nesting the skeleton, its overlay or rendered diagrams", () => {
        const w = wrapHtml('<title>A</title><pre class="mermaid">graph TD; A--&gt;B</pre><p>x</p>');
        const live = (s: string) =>
            s
                .replace('<!doctype html>', '')
                .replace('<html>', '<html data-theme="dark">')
                .replace(
                    '<meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">',
                    '<meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
                )
                .replace(
                    '<pre class="mermaid">graph TD; A--&gt;B</pre>',
                    '<pre class="mermaid mermaid-diagram" data-src="graph TD; A--&gt;B" data-processed="true"><svg><g></g></svg></pre>',
                )
                .replace('</body></html>', '</body><claude-overlay style="all:initial"></claude-overlay></html>');
        const once = wrapHtml(live(w));
        assert.equal(once, w);
        assert.equal(wrapHtml(live(once)), w);
    });
    test('title scan stops at 8KB and at an svg', () => {
        assert.equal(findTitle('<title> Two  Words </title>'), 'Two Words');
        assert.equal(findTitle(`${' '.repeat(9000)}<title>late</title>`), undefined);
        assert.equal(findTitle('<svg></svg><title>after</title>'), undefined);
    });
    test('injects mermaid only when used', () => {
        assert.ok(wrapHtml('<pre class="mermaid">graph TD; A-->B</pre>').includes('mermaid.min.js'));
        assert.ok(!wrapHtml('<p>plain</p>').includes('frame-runtime'));
    });
});

describe('daemon', () => {
    let d: Awaited<ReturnType<typeof startDaemon>>;
    let id: string;
    let ver: string;
    const agent = (method: string, path: string, body?: unknown) =>
        http(d.port, method, path, { body, headers: { authorization: `Bearer ${d.token}` } });
    const shell = (method: string, path: string, body?: unknown, origin = `http://localhost:${d.port}`) =>
        http(d.port, method, path, { body, headers: { origin } });

    before(async () => {
        d = await startDaemon({ port: 0 });
        const r = await agent('POST', '/_agent/publish', {
            title: 'T',
            html: wrapHtml('<title>T</title><p>hi</p>'),
            capabilities: { db: {} },
            files: { 'css/a.css': { b64: Buffer.from('p{}').toString('base64'), contentType: 'text/css' } },
        });
        assert.equal(r.status, 200);
        ({ id, ver } = r.body);
    });
    after(() => d.close());

    test('rejects foreign hosts, missing tokens and cross-origin writes', async () => {
        assert.equal((await http(d.port, 'GET', '/code/artifacts', { host: `evil:${d.port}` })).status, 421);
        assert.equal((await http(d.port, 'GET', '/_agent/artifacts')).status, 401);
        assert.equal((await shell('POST', `/api/a/${id}/comments`, { text: 'x' }, 'http://evil')).status, 403);
        const f = `${id}.localhost:${d.port}`;
        assert.equal(
            (
                await http(d.port, 'POST', '/_frame/api/db', {
                    host: f,
                    body: { verb: 'get', args: {} },
                    headers: { origin: 'http://evil' },
                })
            ).status,
            403,
        );
    });

    test('serves the page on its own origin with the csp and runtime, and blocks traversal', async () => {
        const host = `${id}.localhost:${d.port}`;
        const p = await http(d.port, 'GET', `/v/${ver}/`, { host });
        assert.equal(p.status, 200);
        assert.match(String(p.headers['content-security-policy']), /connect-src 'self'/);
        assert.match(
            p.body,
            /<head><script src="\/_frame\/runtime\.js" data-id="[^"]+" data-ver="[^"]+" data-caps="db"/,
        );
        assert.equal((await http(d.port, 'GET', `/v/${ver}/css/a.css`, { host })).body, 'p{}');
        assert.equal((await http(d.port, 'GET', `/v/${ver}/..%2f..%2fmeta.json`, { host })).status, 404);
        assert.equal((await http(d.port, 'GET', `/v/${ver}/../../meta.json`, { host })).status, 404);
    });

    test('refuses a publish built on an older version unless forced', async () => {
        const b = await agent('POST', '/_agent/publish', {
            id,
            baseVersion: ver,
            title: 'T',
            html: wrapHtml('<title>T</title><p>v2</p>'),
        });
        assert.equal(b.body.seq, 2);
        const stale = await agent('POST', '/_agent/publish', {
            id,
            baseVersion: ver,
            title: 'T',
            html: wrapHtml('<p>v3</p>'),
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.body.live.seq, 2);
        const forced = await agent('POST', '/_agent/publish', {
            id,
            baseVersion: ver,
            force: true,
            title: 'T',
            html: wrapHtml('<p>v3</p>'),
        });
        assert.equal(forced.body.seq, 3);
        // the css file is carried into every later version
        assert.equal(forced.body.meta.versions.at(-1).files[0].path, 'css/a.css');
    });

    test('carried files are hard links; replaced files are fresh', async () => {
        const b64 = (s: string) => Buffer.from(s).toString('base64');
        const a = await agent('POST', '/_agent/publish', {
            title: 'L',
            html: wrapHtml('<title>L</title><p>1</p>'),
            files: {
                'models/m.glb': { b64: b64('glTF-bytes'), contentType: 'model/gltf-binary' },
                'r.css': { b64: b64('p{}'), contentType: 'text/css' },
            },
        });
        const b = await agent('POST', '/_agent/publish', {
            id: a.body.id,
            baseVersion: a.body.ver,
            title: 'L',
            html: wrapHtml('<title>L</title><p>2</p>'),
            files: { 'r.css': { b64: b64('p{color:red}'), contentType: 'text/css' } },
        });
        const at = (ver: string, p: string) => statSync(join(HOME, 'artifacts', a.body.id, 'v', ver, p));
        assert.equal(at(b.body.ver, 'models/m.glb').ino, at(a.body.ver, 'models/m.glb').ino);
        assert.notEqual(at(b.body.ver, 'r.css').ino, at(a.body.ver, 'r.css').ino);
        assert.equal(
            readFileSync(join(HOME, 'artifacts', a.body.id, 'v', b.body.ver, 'models/m.glb'), 'utf8'),
            'glTF-bytes',
        );
    });

    test('a replaced file never rewrites the previous version, even under a case variant', async () => {
        const b64 = (s: string) => Buffer.from(s).toString('base64');
        const a = await agent('POST', '/_agent/publish', {
            title: 'C',
            html: wrapHtml('<title>C</title>'),
            files: { 'models/Lamp.glb': { b64: b64('v1-bytes'), contentType: 'model/gltf-binary' } },
        });
        await agent('POST', '/_agent/publish', {
            id: a.body.id,
            baseVersion: a.body.ver,
            title: 'C',
            html: wrapHtml('<title>C</title><p>2</p>'),
            files: { 'models/lamp.glb': { b64: b64('v2-bytes'), contentType: 'model/gltf-binary' } },
        });
        assert.equal(
            readFileSync(join(HOME, 'artifacts', a.body.id, 'v', a.body.ver, 'models/Lamp.glb'), 'utf8'),
            'v1-bytes',
        );
    });

    test('page db writes need the declared capability and a same-origin request', async () => {
        const host = `${id}.localhost:${d.port}`;
        const origin = `http://${host}`;
        const w = await http(d.port, 'POST', '/_frame/api/db', {
            host,
            headers: { origin },
            body: { verb: 'set', args: { collection: 'items', doc_id: 'a', data: { n: 1 } } },
        });
        assert.equal(w.body.version, 1);
        assert.equal((await http(d.port, 'GET', '/_frame/api/user', { host })).status, 403);
    });

    test('every page gets the 3d scene runtime from the plugin, and nothing else from its folder', async () => {
        const host = `${id}.localhost:${d.port}`;
        const r = await http(d.port, 'GET', '/_frame/scene/scene-runtime.mjs', { host });
        assert.equal(r.status, 200);
        assert.match(String(r.headers['content-type']), /javascript/);
        assert.match(r.body, /from '\.\/scene-core\.mjs'/);
        assert.equal((await http(d.port, 'GET', '/_frame/scene/scene-core.mjs', { host })).status, 200);
        assert.equal((await http(d.port, 'GET', '/_frame/scene/page.html', { host })).status, 404);
    });

    test('the page cannot read who is viewing without the user capability', async () => {
        const host = `${id}.localhost:${d.port}`;
        const r = await http(d.port, 'POST', '/_frame/api/db', {
            host,
            headers: { origin: `http://${host}` },
            body: { verb: 'whoami' },
        });
        assert.equal(r.status, 403);
    });

    test('page db calls get the same path and edit checks as the agent', async () => {
        const host = `${id}.localhost:${d.port}`;
        const page = (verb: string, args: unknown) =>
            http(d.port, 'POST', '/_frame/api/db', {
                host,
                headers: { origin: `http://${host}` },
                body: { verb, args },
            });
        assert.equal(
            (await page('set', { collection: 'items', doc_id: 'b/c', data: {} })).body.error.code,
            'invalid_argument',
        );
        assert.equal(
            (await page('set', { collection: 'items/x', doc_id: 'c', data: {} })).body.error.code,
            'invalid_argument',
        );
        await page('set', { collection: 'items', doc_id: 's', data: { t: 'abc' } });
        assert.equal(
            (
                await page('str_replace', {
                    collection: 'items',
                    doc_id: 's',
                    field: 't',
                    old_str: '',
                    new_str: '-',
                    replace_all: true,
                })
            ).body.error.code,
            'invalid_argument',
        );
        assert.equal(
            (await page('set', { collection: 'items', doc_id: 'big', data: { t: 'x'.repeat(1024 * 1024) } })).body.error
                .code,
            'too_large',
        );
    });

    test('the agent must pin a write to a document that exists; the page need not', async () => {
        const host = `${id}.localhost:${d.port}`;
        await http(d.port, 'POST', '/_frame/api/db', {
            host,
            headers: { origin: `http://${host}` },
            body: { verb: 'set', args: { collection: 'pins', doc_id: 'a', data: { n: 1 } } },
        });
        const blind = await agent('POST', `/_agent/a/${id}/db`, {
            verb: 'update',
            args: { collection: 'pins', doc_id: 'a', data: { n: 2 } },
        });
        assert.equal(blind.body.error.code, 'version_required');
        const pinned = await agent('POST', `/_agent/a/${id}/db`, {
            verb: 'update',
            args: { collection: 'pins', doc_id: 'a', data: { n: 2 }, if_version: 1 },
        });
        assert.equal(pinned.body.version, 2);
        const fresh = await agent('POST', `/_agent/a/${id}/db`, {
            verb: 'set',
            args: { collection: 'pins', doc_id: 'new', data: { n: 1 } },
        });
        assert.equal(fresh.body.version, 1);
    });

    test('page uploads and saves hit the same limits as the agent', async () => {
        const r = await agent('POST', '/_agent/publish', {
            title: 'A',
            html: wrapHtml('<title>A</title>'),
            capabilities: { assets: {}, artifact: {} },
        });
        const host = `${r.body.id}.localhost:${d.port}`;
        const origin = `http://${host}`;
        const up = (type: string, n: number) =>
            http(d.port, 'POST', '/_frame/api/assets', {
                host,
                headers: { origin, 'content-type': type },
                body: 'x'.repeat(n),
            });
        assert.equal((await up('text/html', 4)).status, 415);
        assert.equal((await up('image/svg+xml', 2 * 1024 * 1024 + 8)).status, 413);
        assert.equal((await up('application/json', 4)).status, 200);
        const save = await http(d.port, 'POST', '/_frame/api/publish', {
            host,
            headers: { origin },
            body: { html: 'x'.repeat(16 * 1024 * 1024 + 1), baseVersion: r.body.ver },
        });
        assert.equal(save.status, 413);
        const t = await http(d.port, 'POST', `/api/a/${r.body.id}/comments`, {
            headers: { origin: `http://localhost:${d.port}` },
            body: { text: 'x'.repeat(20000) },
        });
        assert.equal(t.status, 413);
    });

    test('pin and unpin mark the artifact in the gallery', async () => {
        assert.equal((await agent('POST', `/_agent/a/${id}/pin`, { on: true })).body.pinned, true);
        assert.ok((await shell('GET', '/api/artifacts')).body.find((a: any) => a.id === id).pinned);
        assert.equal((await agent('POST', `/_agent/a/${id}/pin`, { on: false })).body.pinned, false);
    });

    test('comment threads: activation gates the agent flow', async () => {
        const t = await shell('POST', `/api/a/${id}/comments`, { text: 'make it blue', anchor: { path: 'p' } });
        assert.equal(t.status, 200);
        assert.equal(t.body.claude_activated_at, undefined);
        const s = await shell('POST', `/api/a/${id}/comments/${t.body.id}/send`);
        assert.ok(s.body.claude_activated_at);
        assert.ok(s.body.comments[0].to_claude_at);
        const p = await agent('POST', '/_agent/pending');
        assert.equal(p.body[0].count, 1);
        assert.equal((await agent('POST', '/_agent/pending')).body.length, 0);
        const m = await shell('POST', `/api/a/${id}/comments/${t.body.id}`, { text: '@claude also bigger' });
        assert.ok(m.body.comments[1].to_claude_at);
    });

    test('a comment keeps its Shift+clicked extra anchors, bounded', async () => {
        const also = Array.from({ length: 12 }, (_, i) => ({
            path: `li:nth-child(${i + 1})`,
            label: `Item ${i + 1}`,
            snippet: '<li>',
            junk: 'x',
        }));
        const t = await shell('POST', `/api/a/${id}/comments`, {
            text: 'these three',
            anchor: { path: 'ul > li', also: [...also, { label: 'no path' }] },
        });
        assert.equal(t.body.anchor.also.length, 8);
        assert.deepEqual(t.body.anchor.also[0], { path: 'li:nth-child(1)', label: 'Item 1', snippet: '<li>' });
    });

    test('area and click comments keep a checked capture beside the thread, served to the viewer and the agent', async () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );
        const url = `data:image/png;base64,${png.toString('base64')}`;
        const anchor = { path: 'canvas', region: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 } };
        const t = await shell('POST', `/api/a/${id}/comments`, { text: 'shadow looks off', anchor, image: url });
        assert.deepEqual(t.body.anchor.image, { type: 'image/png' });
        const img = await http(d.port, 'GET', `/api/a/${id}/comments/${t.body.id}/image`);
        assert.equal(img.status, 200);
        assert.equal(img.headers['content-type'], 'image/png');
        assert.equal(
            (await agent('GET', `/_agent/a/${id}/comments/${t.body.id}/image`)).body.b64,
            png.toString('base64'),
        );
        const fake = await shell('POST', `/api/a/${id}/comments`, {
            text: 'x',
            anchor,
            image: `data:image/webp;base64,${png.toString('base64')}`,
        });
        assert.equal(fake.body.anchor.image, undefined);
        const click = await shell('POST', `/api/a/${id}/comments`, {
            text: 'x',
            anchor: { path: 'canvas' },
            image: url,
        });
        assert.deepEqual(click.body.anchor.image, { type: 'image/png' });
        const loose = await shell('POST', `/api/a/${id}/comments`, { text: 'x', image: url });
        assert.equal(loose.body.anchor?.image, undefined);
        const multi = await shell('POST', `/api/a/${id}/comments`, {
            text: 'these',
            anchor: {
                path: 'canvas',
                also: [
                    { path: 'canvas', snippet: 'a' },
                    { path: 'canvas', snippet: 'b' },
                ],
            },
            image: url,
            also_images: [null, url],
        });
        assert.deepEqual(
            multi.body.anchor.also.map((x: any) => x.image),
            [undefined, { type: 'image/png' }],
        );
        assert.equal((await http(d.port, 'GET', `/api/a/${id}/comments/${multi.body.id}/image/2`)).status, 200);
        assert.equal((await http(d.port, 'GET', `/api/a/${id}/comments/${multi.body.id}/image/1`)).status, 404);
        assert.equal(
            (await agent('GET', `/_agent/a/${id}/comments/${multi.body.id}/image/2`)).body.b64,
            png.toString('base64'),
        );
        await shell('DELETE', `/api/a/${id}/comments/${t.body.id}`);
        assert.equal((await http(d.port, 'GET', `/api/a/${id}/comments/${t.body.id}/image`)).status, 404);
    });

    test('comments and replies carry up to 4 checked reference images, served to the viewer and the agent', async () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );
        const url = `data:image/png;base64,${png.toString('base64')}`;
        const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`;
        const t = await shell('POST', `/api/a/${id}/comments`, { text: 'like this', images: [url, svg, url] });
        const [c] = t.body.comments;
        assert.deepEqual(c.images, [{ type: 'image/png' }, { type: 'image/png' }]);
        const img = await http(d.port, 'GET', `/api/a/${id}/comments/${t.body.id}/attach/${c.id}/1`);
        assert.equal(img.status, 200);
        assert.equal(img.headers['content-type'], 'image/png');
        assert.equal(
            (await agent('GET', `/_agent/a/${id}/comments/${t.body.id}/attach/${c.id}/0`)).body.b64,
            png.toString('base64'),
        );
        assert.equal((await http(d.port, 'GET', `/api/a/${id}/comments/${t.body.id}/attach/${c.id}/2`)).status, 404);
        const r = await shell('POST', `/api/a/${id}/comments/${t.body.id}`, {
            text: 'and these',
            images: Array(6).fill(url),
        });
        assert.equal(r.body.comments[1].images.length, 4);
        await shell('DELETE', `/api/a/${id}/comments/${t.body.id}`);
        assert.equal((await http(d.port, 'GET', `/api/a/${id}/comments/${t.body.id}/attach/${c.id}/0`)).status, 404);
    });

    test('claude status: queued until delivered, working until answered', async () => {
        const status = async (tid: string) =>
            (await shell('GET', `/api/a/${id}/comments`)).body.threads.find((t: any) => t.id === tid).claude;
        const t = await shell('POST', `/api/a/${id}/comments`, {
            text: 'bigger title',
            anchor: { path: 'h1' },
            toClaude: true,
        });
        assert.equal((await status(t.body.id)).status, 'queued');
        await agent('POST', '/_agent/pending');
        const w = await status(t.body.id);
        assert.equal(w.status, 'working');
        assert.ok(Date.parse(w.until) > Date.now());
        await agent('POST', `/_agent/a/${id}/comments/${t.body.id}/reply`, { text: 'done' });
        assert.equal(await status(t.body.id), undefined);
        await shell('POST', `/api/a/${id}/comments/${t.body.id}`, { text: '@claude and bold' });
        assert.equal((await status(t.body.id)).status, 'queued');
        await agent('GET', `/_agent/a/${id}/comments`);
        assert.equal((await status(t.body.id)).status, 'working');
    });

    test('presence: a linked session is open, watching while its monitor polls, and hears only of its artifacts', async () => {
        const state = async (a: string) => (await shell('GET', `/api/a/${a}`)).body.presence;
        const other = (
            await agent('POST', '/_agent/publish', { title: 'O', html: wrapHtml('<title>O</title><p>o</p>') })
        ).body.id;
        await agent('POST', '/_agent/pending');
        assert.equal(await state(id), 'none');
        assert.equal((await agent('POST', '/_agent/presence', { artifacts: [id] })).status, 400);
        await agent('POST', '/_agent/presence', { host: 4242, artifacts: [id, 'not-a-uuid'] });
        await agent('POST', '/_agent/presence', { host: 4242, artifacts: [] });
        assert.equal(await state(id), 'open');
        assert.equal(await state(other), 'none');
        for (const a of [id, other]) {
            await shell('POST', `/api/a/${a}/comments`, { text: 'bigger', anchor: { path: 'p' }, toClaude: true });
        }
        const mine = await agent('POST', '/_agent/pending', { host: 4242, watch: true });
        assert.deepEqual(
            mine.body.map((p: any) => p.id),
            [id],
        );
        assert.equal(await state(id), 'watching');
        assert.deepEqual(
            (await agent('POST', '/_agent/pending', { host: 999 })).body.map((p: any) => p.id),
            [other],
        );
        await shell('POST', `/api/a/${id}/comments`, { text: 'again', anchor: { path: 'p' }, toClaude: true });
        await agent('GET', `/_agent/a/${id}/comments`);
        assert.equal((await agent('POST', '/_agent/pending', { host: 4242, watch: true })).body.length, 0);
    });

    test('the agent must pin writes to existing documents; the page need not', async () => {
        const db = (verb: string, args: unknown) => agent('POST', `/_agent/a/${id}/db`, { verb, args });
        assert.equal((await db('set', { collection: 'pinned', doc_id: 'a', data: { n: 1 } })).body.version, 1);
        const unpinned = await db('update', { collection: 'pinned', doc_id: 'a', data: { n: 2 } });
        assert.equal(unpinned.body.error.code, 'version_required');
        assert.equal(unpinned.body.error.current, 1);
        assert.equal(
            (await db('update', { collection: 'pinned', doc_id: 'a', data: { n: 2 }, if_version: 1 })).body.version,
            2,
        );
        const b = await db('batch', {
            writes: [
                { op: 'set', collection: 'pinned', doc_id: 'new', data: {} },
                { op: 'delete', collection: 'pinned', doc_id: 'a' },
            ],
        });
        assert.equal(b.body.error.code, 'version_required');
        assert.match(b.body.error.message, /^entry 1:/);
        assert.equal((await db('get', { collection: 'pinned', doc_id: 'new' })).body.docs.length, 0);
        const host = `${id}.localhost:${d.port}`;
        const page = await http(d.port, 'POST', '/_frame/api/db', {
            host,
            headers: { origin: `http://${host}` },
            body: { verb: 'set', args: { collection: 'pinned', doc_id: 'a', data: { n: 3 } } },
        });
        assert.equal(page.body.version, 3);
    });

    test('pinning shows in the gallery and survives a republish', async () => {
        const a = await agent('POST', '/_agent/publish', { title: 'P', html: wrapHtml('<title>P</title>') });
        assert.equal((await agent('POST', `/_agent/a/${a.body.id}/pin`, { on: true })).body.pinned, true);
        const b = await agent('POST', '/_agent/publish', {
            id: a.body.id,
            baseVersion: a.body.ver,
            title: 'P',
            html: wrapHtml('<title>P</title><p>2</p>'),
        });
        assert.equal(b.body.meta.pinned, true);
        assert.equal(
            (await http(d.port, 'GET', '/api/artifacts')).body.find((x: any) => x.id === a.body.id).pinned,
            true,
        );
        assert.equal((await shell('POST', `/api/a/${a.body.id}/pin`, { on: false })).body.pinned, false);
        assert.equal((await shell('POST', `/api/a/${a.body.id}/pin`, { on: true }, 'http://evil')).status, 403);
    });

    test('assets copy between artifacts server side under new ids', async () => {
        const mk = async () =>
            (
                await agent('POST', '/_agent/publish', {
                    title: 'A',
                    html: wrapHtml('<title>A</title>'),
                    capabilities: { assets: {} },
                })
            ).body.id;
        const [src, dst] = [await mk(), await mk()];
        const up = await agent('POST', `/_agent/a/${src}/assets`, {
            name: 'x.png',
            contentType: 'image/png',
            b64: Buffer.from('png').toString('base64'),
        });
        const r = await agent('POST', `/_agent/a/${dst}/assets/copy`, { from: src, ids: [up.body.id, 'f'.repeat(32)] });
        assert.equal(r.body.copied[0].asset.sha256, up.body.sha256);
        assert.notEqual(r.body.copied[0].asset.id, up.body.id);
        assert.equal(r.body.copied[1].error, 'not_found');
        assert.equal((await agent('GET', `/_agent/a/${dst}/assets`)).body.length, 1);
    });

    test('a drawn area keeps a bounded region and what it covers; a bad region is dropped', async () => {
        const inside = Array.from({ length: 20 }, (_, i) => `<li>${'x'.repeat(300)}${i}`);
        const t = await shell('POST', `/api/a/${id}/comments`, {
            text: 'these',
            anchor: { path: 'ul', snippet: '<ul>', region: { x0: 0.12345, y0: 0, x1: 0.5, y1: 1, extra: 1 }, inside },
        });
        assert.deepEqual(t.body.anchor.region, { x0: 0.123, y0: 0, x1: 0.5, y1: 1 });
        assert.equal(t.body.anchor.inside.length, 16);
        assert.equal(t.body.anchor.inside[0].length, 200);
        for (const region of [
            { x0: 0.5, y0: 0, x1: 0.5, y1: 1 },
            { x0: -1, y0: 0, x1: 0.5, y1: 1 },
            { x0: 0, y0: 0, x1: 0.5 },
            'x',
        ]) {
            const b = await shell('POST', `/api/a/${id}/comments`, {
                text: 'bad',
                anchor: { path: 'ul', region, inside },
            });
            assert.equal(b.body.anchor.region, undefined);
            assert.equal(b.body.anchor.inside, undefined);
        }
        const q = await shell('POST', `/api/a/${id}/comments`, {
            text: 'quote wins',
            anchor: { path: 'p', span: { quote: 'hi' }, region: { x0: 0, y0: 0, x1: 1, y1: 1 } },
        });
        assert.equal(q.body.anchor.region, undefined);
    });
});

test('comment monitors run an existing script when an existing skill loads', () => {
    const root = join(import.meta.dirname, '..', 'plugins', 'spatial-artifacts');
    const monitors = JSON.parse(readFileSync(join(root, 'monitors', 'monitors.json'), 'utf8'));
    const skills = ['spatial-design', 'spatial-3d-design'];
    assert.deepEqual(
        new Set(monitors.map((m: any) => m.when)),
        new Set(skills.flatMap((s) => [`on-skill-invoke:${s}`, `on-skill-invoke:spatial-artifacts:${s}`])),
    );
    for (const m of monitors) {
        const script = m.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/)[1];
        assert.ok(existsSync(join(root, script)));
        assert.ok(
            existsSync(join(root, 'skills', m.when.replace(/^on-skill-invoke:(spatial-artifacts:)?/, ''), 'SKILL.md')),
        );
    }
});

test('claude status: waiting once the work window passes, none once resolved', () => {
    const sent = '2026-01-01T00:00:00.000Z';
    const t = {
        id: 't',
        created_at: sent,
        comments: [
            { id: 'c', author: 'user' as const, text: 'x', created_at: sent, to_claude_at: sent, delivered_at: sent },
        ],
    };
    const at = Date.parse(sent);
    assert.equal(claudeStatus(t, at + CLAUDE_WORK_MS - 1)?.status, 'working');
    assert.equal(claudeStatus(t, at + CLAUDE_WORK_MS)?.status, 'waiting');
    assert.equal(claudeStatus({ ...t, resolved_at: sent }, at), undefined);
});

// claude code sets only CLAUDE_PLUGIN_ROOT, and codex sets it too; a bare $PLUGIN_ROOT breaks the hook in claude code
test('comment hook runs an existing script from the plugin root both CLIs set', () => {
    const root = join(import.meta.dirname, '..', 'plugins', 'spatial-artifacts');
    const [h] = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks;
    const script = h.command.match(/"\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/)[1];
    assert.ok(existsSync(join(root, script)));
});

describe('mcp over stdio', () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const env = {
        ...process.env,
        SPATIAL_ARTIFACTS_DIR: HOME,
        SPATIAL_ARTIFACTS_PORT: String(port),
        SPATIAL_ARTIFACTS_AUTO_OPEN: '0',
    };
    const proc = spawn(
        process.execPath,
        [join(import.meta.dirname, '..', 'plugins', 'spatial-artifacts', 'server', 'mcp.ts')],
        {
            env,
            stdio: ['pipe', 'pipe', 'inherit'],
        },
    );
    let buf = '';
    let n = 0;
    const waiting = new Map<number, (m: any) => void>();
    proc.stdout.on('data', (d) => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
            const m = JSON.parse(buf.slice(0, i));
            waiting.get(m.id)?.(m);
        }
    });
    const rpc = (method: string, params?: unknown) =>
        new Promise<any>((ok) => {
            waiting.set(++n, ok);
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
        });
    const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result;
    const out = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');

    after(() => {
        proc.kill();
        const s = JSON.parse(readFileSync(join(HOME, 'server.json'), 'utf8'));
        process.kill(s.pid);
    });

    test('lists the four tools with strict schemas', async () => {
        const init = await rpc('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
        });
        assert.match(init.result.instructions, /spatial-design/);
        const { tools } = (await rpc('tools/list')).result;
        assert.deepEqual(
            tools.map((t: any) => t.name),
            ['SpatialArtifact', 'SpatialArtifactComments', 'SpatialArtifactData', 'SpatialArtifactCheck'],
        );
        assert.ok(tools.every((t: any) => t.inputSchema.additionalProperties === false));
        const r = await call('SpatialArtifactData', { action: 'get', nope: 1 });
        assert.equal(r.isError, true);
    });

    const scratch = () => mkdtempSync(join(tmpdir(), 'da-page-'));

    test('a later session republishing a file updates the artifact it went to, unless it changed since', async () => {
        // a second mcp server process: what a resumed or restarted claude session starts
        const later = async () => {
            const p = spawn(
                process.execPath,
                [join(import.meta.dirname, '..', 'plugins', 'spatial-artifacts', 'server', 'mcp.ts')],
                {
                    env,
                    stdio: ['pipe', 'pipe', 'inherit'],
                },
            );
            let b = '';
            let k = 0;
            const w = new Map<number, (m: any) => void>();
            p.stdout.on('data', (d) => {
                b += d;
                for (let i; (i = b.indexOf('\n')) >= 0; b = b.slice(i + 1)) {
                    const m = JSON.parse(b.slice(0, i));
                    w.get(m.id)?.(m);
                }
            });
            const r = (method: string, params?: unknown) =>
                new Promise<any>((ok) => {
                    w.set(++k, ok);
                    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: k, method, params })}\n`);
                });
            await r('initialize', {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 't', version: '0' },
            });
            return {
                call: async (name: string, args: unknown) => (await r('tools/call', { name, arguments: args })).result,
                kill: () => p.kill(),
            };
        };
        const page = join(scratch(), 'desk.html');
        writeFileSync(page, '<title>Desk</title><p>one</p>');
        const first = out(await call('SpatialArtifact', { file_path: page, icon: 'desk' }));
        const url = (first.match(/at (\S+) \(/) ?? [])[1];

        const a = await later();
        writeFileSync(page, '<title>Desk</title><p>two</p>');
        const again = out(await a.call('SpatialArtifact', { file_path: page }));
        a.kill();
        assert.match(again, new RegExp(`at ${url} \\(Version 2`));
        assert.match(again, /published there in an earlier session/);

        // a version saved from the page itself is newer than the file: the next session gets it back instead
        const id = url.split('/').at(-1);
        const s = JSON.parse(readFileSync(join(HOME, 'server.json'), 'utf8'));
        await http(port, 'POST', '/_agent/publish', {
            headers: { authorization: `Bearer ${s.token}` },
            body: { id, title: 'Desk', html: wrapHtml('<title>Desk</title><p>saved by the page</p>'), by: 'page' },
        });
        const b = await later();
        writeFileSync(page, '<title>Desk</title><p>three</p>');
        const refused = await b.call('SpatialArtifact', { file_path: page });
        assert.equal(refused.isError, true);
        assert.match(out(refused), new RegExp(`this file was published before as ${url}`));
        assert.match(out(await b.call('SpatialArtifact', { file_path: page })), new RegExp(`at ${url} \\(Version 4`));
        b.kill();
    });
    const token = () => JSON.parse(readFileSync(join(HOME, 'server.json'), 'utf8')).token;
    const agentApi = (method: string, path: string, body?: unknown) =>
        http(port, method, path, { body, headers: { authorization: `Bearer ${token()}` } });
    const publishPage = async (name: string, extra: Record<string, unknown> = {}) => {
        const page = join(scratch(), `${name}.html`);
        writeFileSync(page, `<title>${name}</title><p>x</p>`);
        const r = await call('SpatialArtifact', { file_path: page, icon: 'doc', ...extra });
        const url = out(r).match(/at (\S+) \(/)?.[1];
        return { r, page, url, id: url?.split('/').at(-1) };
    };

    test('open, pin, unpin, quickstart and whole-artifact delete', async () => {
        const { url } = await publishPage('Actions Page', { pin: true });
        assert.match(out(await call('SpatialArtifact', { action: 'list' })), /Actions Page — .* — pinned/);
        assert.match(
            out(await call('SpatialArtifact', { action: 'open', url })),
            /Not opened: opening the browser is off/,
        );
        assert.match(out(await call('SpatialArtifact', { action: 'unpin', url })), /Unpinned "Actions Page"/);
        assert.match(out(await call('SpatialArtifact', { action: 'unpin', url })), /already not pinned/);
        assert.match(out(await call('SpatialArtifact', { action: 'pin', url })), /Pinned "Actions Page"/);
        assert.match(
            out(await call('SpatialArtifact', { action: 'quickstart', intent: 'design' })),
            /spatial-3d-design/,
        );
        assert.equal((await call('SpatialArtifact', { action: 'quickstart' })).isError, true);
        assert.match(out(await call('SpatialArtifact', { action: 'list', scope: 'types' })), /No Artifact types/);
        assert.equal(
            (await call('SpatialArtifact', { type_url: 'https://claude.ai/x', file_path: '/tmp/x.html' })).isError,
            true,
        );
        assert.match(
            out(await call('SpatialArtifact', { action: 'delete', url })),
            /Deleted artifact "Actions Page" .* permanently/,
        );
        assert.equal((await call('SpatialArtifact', { action: 'read', url })).isError, true);
    });

    test('a publish replaces only published files this session read, listed or published', async () => {
        const dir = scratch();
        const page = join(dir, 'files.html');
        writeFileSync(page, '<title>Files Page</title><link rel=stylesheet href=a.css>');
        writeFileSync(join(dir, 'a.css'), 'p{}');
        writeFileSync(join(dir, 'b.css'), 'p{color:red}');
        const first = out(
            await call('SpatialArtifact', { file_path: page, icon: 'doc', files: { 'a.css': join(dir, 'a.css') } }),
        );
        const url = first.match(/at (\S+) \(/)?.[1];
        const id = url?.split('/').at(-1);
        // its own publish counts as read
        assert.match(
            out(await call('SpatialArtifact', { file_path: page, files: { 'a.css': join(dir, 'b.css') } })),
            /Version 2/,
        );

        // a file published from elsewhere is unread here
        const live = (await agentApi('GET', `/_agent/a/${id}`)).body.meta;
        await agentApi('POST', '/_agent/publish', {
            id,
            baseVersion: live.ver,
            title: 'Files Page',
            html: wrapHtml('<title>Files Page</title>'),
            files: { 'm.css': { b64: Buffer.from('x{}').toString('base64'), contentType: 'text/css' } },
        });
        await call('SpatialArtifact', { action: 'read', url });
        const refused = await call('SpatialArtifact', { file_path: page, files: { 'm.css': join(dir, 'b.css') } });
        assert.equal(refused.isError, true);
        assert.match(
            out(refused),
            /would replace or remove published file "m\.css", which this session has not read or listed/,
        );
        assert.equal((await call('SpatialArtifact', { file_path: page, files: { 'm.css': null } })).isError, true);
        assert.match(
            out(
                await call('SpatialArtifact', {
                    file_path: page,
                    files: { 'm.css': null },
                    overwrite_unread: ['m.css'],
                }),
            ),
            /Version 4/,
        );
        assert.match(out(await call('SpatialArtifact', { action: 'list', scope: 'files', url })), /a\.css/);
        assert.match(
            out(await call('SpatialArtifact', { file_path: page, files: { 'a.css': join(dir, 'a.css') } })),
            /Version 5/,
        );
    });

    test('preflight.js is checked; files and assets copy from another artifact', async () => {
        const dir = scratch();
        const page = join(dir, 'pre.html');
        writeFileSync(page, '<title>Preflight Page</title>');
        const bad = join(dir, 'bad.js');
        writeFileSync(bad, 'export const x = 1;');
        assert.match(
            out(await call('SpatialArtifact', { file_path: page, icon: 'doc', files: { 'preflight.js': bad } })),
            /default export is a function/,
        );
        writeFileSync(bad, 'export default function ( {');
        assert.match(
            out(await call('SpatialArtifact', { file_path: page, icon: 'doc', files: { 'preflight.js': bad } })),
            /not a valid JavaScript module/,
        );
        const big = join(dir, 'big.js');
        writeFileSync(big, `export default () => {}; // ${'x'.repeat(9000)}`);
        assert.match(
            out(await call('SpatialArtifact', { file_path: page, icon: 'doc', files: { 'preflight.js': big } })),
            /at most 8 KiB/,
        );
        const good = join(dir, 'good.js');
        writeFileSync(good, 'export default async ({ from, to }) => { console.log(from, to); };');
        writeFileSync(join(dir, 'lamp.glb'), 'glTF');
        writeFileSync(join(dir, 'other.html'), '<!doctype html><p>x</p>');
        const src = out(
            await call('SpatialArtifact', {
                file_path: page,
                icon: 'doc',
                files: {
                    'preflight.js': good,
                    'models/lamp.glb': { from: join(dir, 'lamp.glb'), contentType: 'model/gltf-binary' },
                    'other.html': join(dir, 'other.html'),
                },
            }),
        );
        const srcUrl = src.match(/at (\S+) \(/)?.[1];

        const page2 = join(dir, 'copy.html');
        writeFileSync(page2, '<title>Copy Page</title>');
        const copied = await call('SpatialArtifact', {
            file_path: page2,
            icon: 'doc',
            files: { 'models/lamp.glb': { artifact: srcUrl, path: 'models/lamp.glb' } },
            capabilities: { assets: {} },
        });
        assert.match(out(copied), /Published/);
        const url2 = out(copied).match(/at (\S+) \(/)?.[1];
        assert.match(
            out(await call('SpatialArtifact', { action: 'list', scope: 'files', url: url2 })),
            /models\/lamp\.glb {2}model\/gltf-binary/,
        );
        assert.match(
            out(
                await call('SpatialArtifact', {
                    file_path: page2,
                    files: { 'o.html': { artifact: srcUrl, path: 'other.html' } },
                }),
            ),
            /HTML or XML document/,
        );

        const srcId = srcUrl.split('/').at(-1);
        await agentApi('POST', '/_agent/publish', {
            id: srcId,
            baseVersion: (await agentApi('GET', `/_agent/a/${srcId}`)).body.meta.ver,
            title: 'Preflight Page',
            html: wrapHtml('<title>Preflight Page</title>'),
            capabilities: { assets: {} },
        });
        const up = await agentApi('POST', `/_agent/a/${srcId}/assets`, {
            name: 'x.png',
            contentType: 'image/png',
            b64: Buffer.from('png').toString('base64'),
        });
        const r = out(
            await call('SpatialArtifact', { asset: true, url: url2, from_url: srcUrl, asset_ids: [up.body.id] }),
        );
        assert.match(r, /1 of 1 assets copied/);
        assert.equal(
            (
                await call('SpatialArtifact', {
                    asset: true,
                    url: url2,
                    from_url: srcUrl,
                    asset_ids: [up.body.id, up.body.id],
                })
            ).isError,
            true,
        );
    });

    test('capabilities: the local roster, permissions built in, claude.ai-only ones refused', async () => {
        assert.match(
            out((await publishPage('Caps Page', { capabilities: { downloads: true, self: {} } })).r),
            /capabilities downloads, self/,
        );
        assert.match(
            out((await publishPage('Sample Page', { capabilities: { sample: {} } })).r),
            /unknown capability "sample"/,
        );
        assert.match(out((await publishPage('Mcp Page', { capabilities: { mcp: {} } })).r), /unknown capability "mcp"/);
        assert.match(
            out((await publishPage('Files Page', { capabilities: { files: { project: 'chan_123' } } })).r),
            /claude\.ai project ids do not apply locally/,
        );
        assert.match(
            out((await publishPage('Comments Page', { capabilities: { comments: { anything: true } } })).r),
            /only "composer_only" and "customAnchors"/,
        );
        assert.match(out((await publishPage('Perm Page', { capabilities: { permissions: {} } })).r), /built in/);
    });

    test('database: pins required on existing documents, view level writes nothing, profiles name guests', async () => {
        const { url } = await publishPage('Db Page', { capabilities: { db: {}, user: {} } });
        const set = (extra: Record<string, unknown> = {}) =>
            call('SpatialArtifactData', {
                action: 'set',
                url,
                collection: 'rows',
                doc_id: 'r1',
                data: { n: 1 },
                ...extra,
            });
        assert.match(out(await set()), /version 1/);
        const refused = await set();
        assert.equal(refused.isError, true);
        assert.match(
            out(refused),
            /already exists \(version 1\) and the write carries no if_version.*refused until you read it/,
        );
        assert.match(out(await set({ if_version: 1 })), /version 2/);
        assert.match(
            out(
                await call('SpatialArtifactData', {
                    action: 'delete',
                    url,
                    collection: 'rows',
                    doc_id: 'r1',
                    if_version: 2,
                    as_level: 'view',
                }),
            ),
            /as_level "view" allows no writes at all/,
        );
        assert.match(
            out(
                await call('SpatialArtifactData', {
                    action: 'get',
                    url,
                    collection: 'rows',
                    doc_id: 'r1',
                    as_level: 'view',
                }),
            ),
            /"version":2/,
        );
        const big = { blob: 'x'.repeat(600 * 1024) };
        const tooBig = await call('SpatialArtifactData', {
            action: 'batch',
            url,
            writes: [
                { op: 'set', collection: 'rows', doc_id: 'b1', data: big },
                { op: 'set', collection: 'rows', doc_id: 'b2', data: big },
            ],
        });
        assert.match(out(tooBig), /at most 1 MiB/);
        const meId = (await http(port, 'GET', `/api/a/${url.split('/').at(-1)}`)).body.me.id;
        assert.match(
            out(await call('SpatialArtifactData', { action: 'profiles', url, ids: [meId] })),
            new RegExp(`${meId} \\| member \\| `),
        );
    });

    test('publish, conflict refusal, reply gate', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'da-page-'));
        const page = join(dir, 'page.html');
        writeFileSync(page, '<title>Test Page</title><p>one</p>');
        const pub = out(await call('SpatialArtifact', { file_path: page, icon: 'doc' }));
        assert.match(pub, /Published .* at (http:\/\/localhost:\d+\/code\/artifact\/[0-9a-f-]{36}) \(Version 1/);
        const url = (pub.match(/at (\S+) \(/) ?? [])[1];
        const id = url.split('/').at(-1);

        // a newer version saved elsewhere makes the next publish from this session a refusal
        const s = JSON.parse(readFileSync(join(HOME, 'server.json'), 'utf8'));
        await http(port, 'POST', '/_agent/publish', {
            headers: { authorization: `Bearer ${s.token}` },
            body: { id, title: 'Test Page', html: wrapHtml('<title>Test Page</title><p>two</p>') },
        });
        writeFileSync(page, '<title>Test Page</title><p>three</p>');
        const refused = await call('SpatialArtifact', { file_path: page });
        assert.equal(refused.isError, true);
        assert.match(out(refused), /Publish refused — nothing was merged or published: version 2 is live/);
        assert.match(out(await call('SpatialArtifact', { file_path: page })), /Version 3/);

        const t = await http(port, 'POST', `/api/a/${id}/comments`, {
            headers: { origin: `http://localhost:${port}` },
            body: { text: 'hello' },
        });
        const denied = await call('SpatialArtifactComments', {
            action: 'reply',
            url,
            thread_id: t.body.id,
            text: 'hi',
        });
        assert.match(out(denied), /Reply not posted: Claude has no activation on this comment thread/);
        await http(port, 'POST', `/api/a/${id}/comments/${t.body.id}/send`, {
            headers: { origin: `http://localhost:${port}` },
        });
        const read = out(await call('SpatialArtifactComments', { action: 'read', url }));
        assert.match(read, /=== BEGIN ARTIFACT COMMENTS (\w{8}) —/);
        assert.match(read, /sent to you — awaiting reply/);
        assert.match(
            out(await call('SpatialArtifactComments', { action: 'reply', url, thread_id: t.body.id, text: 'done' })),
            /Replied to comment thread/,
        );
        assert.match(
            out(await call('SpatialArtifactComments', { action: 'reply', url, thread_id: t.body.id, text: 'again' })),
            /already followed by a Claude reply/,
        );
        assert.match(
            out(await call('SpatialArtifactComments', { action: 'resolve', url, thread_id: t.body.id })),
            /Marked comment thread .* resolved/,
        );

        const area = {
            path: 'ul',
            label: 'Plans',
            snippet: '<ul class="plans">',
            region: { x0: 0, y0: 0.2, x1: 1, y1: 0.6 },
            inside: ['<li>Basic', '<li>Pro'],
        };
        const r = await http(port, 'POST', `/api/a/${id}/comments`, {
            headers: { origin: `http://localhost:${port}` },
            body: { text: 'make these match', anchor: area },
        });
        const one = out(await call('SpatialArtifactComments', { action: 'read', url, thread_id: r.body.id }));
        assert.match(
            one,
            /\n {2}\[region of\] ul\n {2}\[anchored element\] <ul class="plans">\n {2}\[inside region\] <li>Basic\n {2}\[inside region\] <li>Pro\n/,
        );
        assert.doesNotMatch(one, /\n {2}\[anchored at\]/);
        assert.match(one, /on which the commenter dragged out a rectangle/);

        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const ref = await http(port, 'POST', `/api/a/${id}/comments`, {
            headers: { origin: `http://localhost:${port}` },
            body: { text: 'like this one', images: [`data:image/png;base64,${png}`], toClaude: true },
        });
        const seen = await call('SpatialArtifactComments', { action: 'read', url, thread_id: ref.body.id });
        assert.match(out(seen), /\n {2}\[attached image 1 of 1\] attached after this listing/);
        assert.match(out(seen), /reference image the commenter attached/);
        assert.deepEqual(
            seen.content.filter((x: any) => x.type === 'image').map((x: any) => [x.mimeType, x.data]),
            [['image/png', png]],
        );

        // past the per-read cap, a single-thread read says so rather than pointing back at itself
        const four = Array(4).fill(`data:image/png;base64,${png}`);
        for (const images of [four, four]) {
            await http(port, 'POST', `/api/a/${id}/comments/${ref.body.id}`, {
                headers: { origin: `http://localhost:${port}` },
                body: { text: 'more', images },
            });
        }
        const capped = await call('SpatialArtifactComments', { action: 'read', url, thread_id: ref.body.id });
        assert.equal(capped.content.filter((x: any) => x.type === 'image').length, 8);
        assert.match(out(capped), /\[attached image 4 of 4\] not attached here — past the 8-image cap of one read/);
        assert.doesNotMatch(out(capped), /read this thread on its own/);
    });

    test('official-only calls are accepted: quickstart, types, pin, delete', async () => {
        assert.match(
            out(await call('SpatialArtifact', { action: 'quickstart', intent: 'slides' })),
            /No Artifact types [\s\S]*spatial-design/,
        );
        assert.match(
            out(await call('SpatialArtifact', { action: 'list', scope: 'types' })),
            /No Artifact types are listed/,
        );
        const dir = mkdtempSync(join(tmpdir(), 'da-page-'));
        const page = join(dir, 'gone.html');
        writeFileSync(page, '<title>Gone Page</title><p>x</p>');
        const url = (out(await call('SpatialArtifact', { file_path: page, icon: 'doc', pin: true })).match(
            /at (\S+) \(/,
        ) ?? [])[1];
        assert.match(out(await call('SpatialArtifact', { action: 'list' })), /- Gone Page — .* — pinned\n/);
        assert.match(out(await call('SpatialArtifact', { action: 'unpin', url })), /Unpinned "Gone Page"/);
        assert.match(
            out(await call('SpatialArtifact', { action: 'delete', url })),
            /Deleted artifact "Gone Page" .* permanently/,
        );
        assert.equal((await call('SpatialArtifact', { action: 'read', url })).isError, true);
    });

    test('a publish never overwrites a supporting file this session has not seen', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'da-page-'));
        const page = join(dir, 'files.html');
        writeFileSync(page, '<title>Files Page</title><link rel=stylesheet href=a.css>');
        writeFileSync(join(dir, 'a.css'), 'p{color:red}');
        const url = (out(
            await call('SpatialArtifact', { file_path: page, icon: 'doc', files: { 'a.css': join(dir, 'a.css') } }),
        ).match(/at (\S+) \(/) ?? [])[1];
        const id = url.split('/').at(-1);

        // another session replaces a.css
        const s = JSON.parse(readFileSync(join(HOME, 'server.json'), 'utf8'));
        const live = (await http(port, 'GET', `/_agent/a/${id}`, { headers: { authorization: `Bearer ${s.token}` } }))
            .body.meta;
        await http(port, 'POST', '/_agent/publish', {
            headers: { authorization: `Bearer ${s.token}` },
            body: {
                id,
                title: 'Files Page',
                html: wrapHtml('<title>Files Page</title>'),
                baseVersion: live.ver,
                files: { 'a.css': { b64: Buffer.from('p{}').toString('base64'), contentType: 'text/css' } },
            },
        });
        await call('SpatialArtifact', { action: 'read', url });

        const changed = await call('SpatialArtifact', { file_path: page, files: { 'a.css': join(dir, 'a.css') } });
        assert.match(out(changed), /"a\.css" changed after this session read it/);
        await call('SpatialArtifact', { action: 'read', url, path: 'a.css' });
        assert.match(
            out(await call('SpatialArtifact', { file_path: page, files: { 'a.css': join(dir, 'a.css') } })),
            /Version 3/,
        );

        // a file copied from another artifact
        const other = join(dir, 'other.html');
        writeFileSync(other, '<title>Other Page</title><link rel=stylesheet href=b.css>');
        const copied = out(
            await call('SpatialArtifact', {
                file_path: other,
                icon: 'doc',
                files: { 'b.css': { artifact: url, path: 'a.css' } },
            }),
        );
        assert.match(copied, /Version 1/);
        // a file another session added, which this session only saw through the page
        const now = (await http(port, 'GET', `/_agent/a/${id}`, { headers: { authorization: `Bearer ${s.token}` } }))
            .body.meta;
        await http(port, 'POST', '/_agent/publish', {
            headers: { authorization: `Bearer ${s.token}` },
            body: {
                id,
                title: 'Files Page',
                html: wrapHtml('<title>Files Page</title>'),
                baseVersion: now.ver,
                files: { 'b.css': { b64: Buffer.from('a{}').toString('base64'), contentType: 'text/css' } },
            },
        });
        await call('SpatialArtifact', { action: 'read', url });
        const blind = out(await call('SpatialArtifact', { file_path: page, files: { 'b.css': null } }));
        assert.match(
            blind,
            /would replace or remove published file "b\.css", which this session has not read or listed\. .* `overwrite_unread`/,
        );
        assert.match(
            out(
                await call('SpatialArtifact', {
                    file_path: page,
                    files: { 'b.css': null },
                    overwrite_unread: ['b.css'],
                }),
            ),
            /Version 5/,
        );
    });

    test('SpatialArtifactData refuses writes at as_level "view"', async () => {
        const r = await call('SpatialArtifactData', {
            action: 'set',
            url: `http://localhost:${port}/code/artifact/00000000-0000-4000-8000-000000000000`,
            collection: 'c',
            doc_id: 'd',
            data: {},
            as_level: 'view',
        });
        assert.match(out(r), /allows no writes at all/);
    });
});
