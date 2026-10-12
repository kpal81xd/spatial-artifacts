// the capabilities that act as the viewer: grants, comments, files, room, sample and mcp, against a daemon in this process
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'da-caps-'));
process.env['SPATIAL_ARTIFACTS_DIR'] = HOME;
const { startDaemon } = await import('../server/daemon.ts');
const { wrapHtml } = await import('../server/wrap.ts');
const { parseJson } = await import('../server/sample.ts');
const { configured } = await import('../server/mcphost.ts');

type Res = { status: number; body: any; headers: Record<string, unknown>; raw: Buffer };
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
                    const raw = Buffer.concat(chunks);
                    const t = raw.toString();
                    ok({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        raw,
                        body: String(res.headers['content-type']).startsWith('application/json') ? JSON.parse(t) : t,
                    });
                });
            },
        );
        req.end(data);
    });

// an sse client that collects named events
const listen = (port: number, host: string, path: string) => {
    const events: { event: string; data: any }[] = [];
    let buf = '';
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host } }, (res) =>
        res.on('data', (c: Buffer) => {
            buf += c;
            for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
                const ev = /^event: (.+)$/m.exec(buf.slice(0, i))?.[1];
                const data = /^data: (.+)$/m.exec(buf.slice(0, i))?.[1];
                if (ev && data) {
                    events.push({ event: ev, data: JSON.parse(data) });
                }
            }
        }),
    );
    req.end();
    const wait = async (pred: (e: { event: string; data: any }) => boolean, ms = 3000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 20))) {
            const e = events.find(pred);
            if (e) {
                return e;
            }
        }
        throw new Error('event did not arrive');
    };
    return { events, wait, close: () => req.destroy() };
};

describe('capabilities', () => {
    let d: Awaited<ReturnType<typeof startDaemon>>;
    const project = mkdtempSync(join(tmpdir(), 'da-proj-'));
    const agent = (method: string, path: string, body?: unknown) =>
        http(d.port, method, path, { body, headers: { authorization: `Bearer ${d.token}` } });
    const shell = (method: string, path: string, body?: unknown, origin = `http://localhost:${d.port}`) =>
        http(d.port, method, path, { body, headers: { origin } });
    const page = (id: string, method: string, path: string, body?: unknown) =>
        http(d.port, method, path, {
            body,
            host: `${id}.localhost:${d.port}`,
            headers: { origin: `http://${id}.localhost:${d.port}` },
        });
    const publish = async (capabilities: Record<string, unknown>) =>
        (
            await agent('POST', '/_agent/publish', {
                title: 'C',
                html: wrapHtml('<title>C</title><p>x</p>'),
                capabilities,
            })
        ).body.id as string;
    const grant = (id: string, name: string, on = true) => shell('POST', `/api/a/${id}/grants`, { name, on });

    before(async () => {
        d = await startDaemon({ port: 0 });
        mkdirSync(join(project, 'src'));
        mkdirSync(join(project, '.git'));
        writeFileSync(join(project, 'src', 'a.txt'), 'hello files');
        writeFileSync(join(project, 'run.js'), 'x');
        writeFileSync(join(project, '.git', 'config'), 'secret');
        symlinkSync('/etc', join(project, 'etc-link'));
    });
    after(() => d.close());

    test('grants: only the shell writes them, the page reads its own', async () => {
        const id = await publish({ comments: {} });
        assert.equal(
            (await shell('POST', `/api/a/${id}/grants`, { name: 'comments' }, `http://${id}.localhost:${d.port}`))
                .status,
            403,
        );
        assert.equal((await shell('POST', `/api/a/${id}/grants`, { name: 'everything' })).status, 400);
        assert.deepEqual((await page(id, 'GET', '/_frame/api/grants')).body.granted, []);
        await grant(id, 'comments');
        assert.deepEqual((await page(id, 'GET', '/_frame/api/grants')).body.granted, ['comments']);
        assert.equal((await page(id, 'POST', '/_frame/api/grants', {})).status, 404);
    });

    test('comments: page writes need consent, are labelled, and never activate Claude by text', async () => {
        const id = await publish({ comments: {} });
        const anchor = { path: 'p', at: { x: 0.5, y: 0.5 } };
        assert.equal(
            (await page(id, 'POST', '/_frame/api/comments', { anchor, text: 'hi' })).body.error.code,
            'consent_required',
        );
        await grant(id, 'comments');
        assert.equal(
            (await page(id, 'POST', '/_frame/api/comments', { anchor, text: '   ' })).body.error.code,
            'invalid',
        );
        assert.equal(
            (await page(id, 'POST', '/_frame/api/comments', { anchor, text: 'a\u0001b' })).body.error.code,
            'invalid',
        );
        const c = await page(id, 'POST', '/_frame/api/comments', { anchor, text: '@claude make it blue' });
        const t = (await shell('GET', `/api/a/${id}/comments`)).body.threads.find((x: any) => x.id === c.body.threadId);
        assert.equal(t.comments[0].via, 'page');
        assert.equal(t.claude_activated_at, undefined);
        assert.equal(
            (await page(id, 'POST', `/_frame/api/comments/${c.body.threadId}/reply`, { text: 'more', toClaude: true }))
                .body.error.code,
            'claude_unavailable',
        );
        assert.equal((await page(id, 'GET', '/_frame/api/comments/can-send')).body.state, 'no_session');
        await page(id, 'POST', `/_frame/api/comments/${c.body.threadId}/resolve`, { resolved: true });
        await page(id, 'DELETE', `/_frame/api/comments/${c.body.threadId}`);
        assert.equal((await shell('GET', `/api/a/${id}/comments`)).body.threads.length, 0);
        const only = await publish({ comments: { composer_only: true } });
        await grant(only, 'comments');
        assert.equal(
            (await page(only, 'POST', '/_frame/api/comments', { anchor, text: 'x' })).body.error.code,
            'not_granted',
        );
        assert.equal((await page(only, 'GET', '/_frame/api/comments/can-send')).body.state, 'off');
    });

    test('files: read inside the project only, never .git or through a symlink out, programs never downloaded', async () => {
        const id = await publish({ files: { project } });
        assert.equal((await page(id, 'POST', '/_frame/api/files/list', {})).body.error.code, 'not_granted');
        await grant(id, 'files');
        const all = (await page(id, 'POST', '/_frame/api/files/list', { recursive: true })).body.entries.map(
            (e: any) => e.path,
        );
        assert.ok(all.includes('src/a.txt'));
        assert.ok(!all.some((p: string) => p.startsWith('.git')));
        const r = await page(id, 'POST', '/_frame/api/files/read', { path: 'src/a.txt', offset: 6 });
        assert.equal(r.raw.toString(), 'files');
        assert.equal(r.headers['x-size'], '11');
        assert.equal(
            (await page(id, 'POST', '/_frame/api/files/read', { path: '../x' })).body.error.code,
            'bad_request',
        );
        assert.equal(
            (await page(id, 'POST', '/_frame/api/files/read', { path: '.git/config' })).body.error.code,
            'not_found',
        );
        assert.equal(
            (await page(id, 'POST', '/_frame/api/files/read', { path: 'etc-link/hostname' })).body.error.code,
            'not_found',
        );
        assert.equal(
            (await page(id, 'POST', '/_frame/api/files/stat', { path: 'run.js' })).body.error.code,
            'bad_request',
        );
        assert.equal(
            (await http(d.port, 'GET', `/api/a/${id}/files/raw?path=src%2Fa.txt`)).raw.toString(),
            'hello files',
        );
        await grant(id, 'files', false);
        assert.equal((await http(d.port, 'GET', `/api/a/${id}/files/raw?path=src%2Fa.txt`)).status, 403);
    });

    test('room: peers, moments, presence and named rooms are relayed live', async () => {
        const id = await publish({ room: {}, user: {} });
        const host = `${id}.localhost:${d.port}`;
        const a = listen(d.port, host, '/_frame/room/connect');
        const ha = (await a.wait((e) => e.event === 'hello')).data;
        const b = listen(d.port, host, '/_frame/room/connect');
        const hb = (await b.wait((e) => e.event === 'hello')).data;
        assert.equal(hb.peers.length, 2);
        assert.ok(hb.peers[0].by.startsWith('u_'));
        await a.wait((e) => e.event === 'joined' && e.data.peer === hb.peer);
        assert.equal(
            (await page(id, 'POST', '/_frame/room/emit', { peer: ha.peer, topic: 'Bad:topic' })).body.error.code,
            'invalid_argument',
        );
        await page(id, 'POST', '/_frame/room/emit', { peer: ha.peer, topic: 'cheer', data: { n: 1 } });
        assert.deepEqual((await b.wait((e) => e.event === 'msg')).data.data, { n: 1 });
        await page(id, 'POST', '/_frame/room/presence', { peer: hb.peer, presence: { cursor: [1, 2] } });
        assert.deepEqual((await a.wait((e) => e.event === 'presence')).data.presence, { cursor: [1, 2] });
        assert.equal(
            (await page(id, 'POST', '/_frame/room/presence', { peer: hb.peer, presence: { 'bad key': 1 } })).body.error
                .code,
            'invalid_argument',
        );
        await page(id, 'POST', '/_frame/room/join', { peer: ha.peer, name: 'game-1' });
        await page(id, 'POST', '/_frame/room/emit', { peer: ha.peer, room: 'game-1', topic: 'move', data: 1 });
        await a.wait((e) => e.event === 'msg' && e.data.room === 'game-1');
        assert.ok(!b.events.some((e) => e.event === 'msg' && e.data.room === 'game-1'));
        assert.equal(
            (await page(id, 'POST', '/_frame/room/emit', { peer: hb.peer, room: 'game-1', topic: 'move' })).body.error
                .code,
            'invalid_argument',
        );
        b.close();
        await a.wait((e) => e.event === 'left' && e.data.peer === hb.peer);
        a.close();
    });

    test('sendToClaudeSession: only the shell sends, and the next notice carries it once', async () => {
        const id = await publish({ room: {} });
        assert.equal(
            (await shell('POST', `/api/a/${id}/to-claude`, { data: { label: 'x' } })).body.error.code,
            'claude_unavailable',
        );
        await agent('POST', '/_agent/presence', { host: 777, artifacts: [id] });
        assert.equal((await shell('POST', `/api/a/${id}/to-claude`, { data: {} })).body.error.code, 'invalid_argument');
        assert.equal(
            (
                await shell(
                    'POST',
                    `/api/a/${id}/to-claude`,
                    { data: { label: 'x' } },
                    `http://${id}.localhost:${d.port}`,
                )
            ).status,
            403,
        );
        const ev = listen(d.port, `${id}.localhost:${d.port}`, '/_frame/events');
        const r = await shell('POST', `/api/a/${id}/to-claude`, {
            data: { label: 'Q3 chart', point: 3 },
            presence: { cursor: 1, view: 'q3' },
        });
        assert.equal(r.body.to, 'session');
        assert.equal(
            (await shell('POST', `/api/a/${id}/to-claude`, { data: { a: 1 } })).body.error.code,
            'rate_limited',
        );
        const p = (await agent('POST', '/_agent/pending', { host: 777 })).body.find((x: any) => x.id === id);
        assert.deepEqual(p.sends[0].data, { data: { label: 'Q3 chart', point: 3 }, presence: { view: 'q3' } });
        assert.equal((await ev.wait((e) => e.event === 'to-claude')).data.id, r.body.id);
        assert.equal((await agent('POST', '/_agent/pending', { host: 777 })).body.length, 0);
        ev.close();
    });

    test('sample: streams from the Messages API, runs page tools between rounds, caches, needs consent', async () => {
        const seen: any[] = [];
        const api = createServer((req, res) => {
            let b = '';
            req.on('data', (c) => (b += c));
            req.on('end', () => {
                const body = JSON.parse(b);
                seen.push({ body, headers: req.headers });
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const ev = (o: unknown) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
                const last = body.messages.at(-1);
                if (body.tools && !Array.isArray(last.content)) {
                    ev({
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'tool_use', id: 't1', name: 'getCount', input: {} },
                    });
                    ev({
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
                    });
                    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
                } else {
                    const reply = Array.isArray(last.content) ? `count is ${last.content[0].content}` : '[1, 2]';
                    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } });
                    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
                }
                res.end();
            });
        });
        await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
        process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${(api.address() as any).port}`;
        process.env['ANTHROPIC_API_KEY'] = 'test-key';
        try {
            const id = await publish({ sample: {} });
            const ask = async (b: unknown) =>
                (await page(id, 'POST', '/_frame/api/sample', b)).raw
                    .toString()
                    .trim()
                    .split('\n')
                    .map((l) => JSON.parse(l));
            assert.equal((await ask({ input: 'hi' }))[0].code, 'not_granted');
            await grant(id, 'sample');
            const j = await ask({ verb: 'json', input: 'numbers' });
            assert.deepEqual(j.at(-1), {
                type: 'done',
                value: [1, 2],
                text: '[1, 2]',
                truncated: false,
                tier: 'default',
            });
            assert.equal(seen[0].body.model, 'claude-opus-5-5');
            assert.equal(seen[0].body.fallbacks, 'default');
            assert.equal(seen[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
            assert.equal(seen[0].headers['x-api-key'], 'test-key');
            await ask({ verb: 'json', input: 'numbers' });
            assert.equal(seen.length, 1, 'the second identical call is a cache replay');
            assert.equal((await ask({ input: [{ role: 'assistant', content: 'x' }] }))[0].code, 'invalid_request');
            assert.equal(
                (await ask({ input: 'x', tools: [{ name: 'a', description: 'b' }], cache: true }))[0].code,
                'invalid_request',
            );

            // a tool round: the page gets the calls on the stream, posts results, and the answer continues
            const out = await new Promise<any[]>((ok) => {
                const lines: any[] = [];
                let buf = '';
                const data = Buffer.from(
                    JSON.stringify({
                        input: 'count?',
                        tier: 'quick',
                        tools: [{ name: 'getCount', description: 'the count' }],
                    }),
                );
                const req = request(
                    {
                        host: '127.0.0.1',
                        port: d.port,
                        method: 'POST',
                        path: '/_frame/api/sample',
                        headers: {
                            host: `${id}.localhost:${d.port}`,
                            origin: `http://${id}.localhost:${d.port}`,
                            'content-type': 'application/json',
                        },
                    },
                    (res) => {
                        res.on('data', (c: Buffer) => {
                            buf += c;
                            for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
                                const ev = JSON.parse(buf.slice(0, i));
                                lines.push(ev);
                                if (ev.type === 'tools') {
                                    page(id, 'POST', '/_frame/api/sample/results', {
                                        callId: ev.callId,
                                        results: [{ id: ev.calls[0].id, content: '42' }],
                                    });
                                }
                            }
                        });
                        res.on('end', () => ok(lines));
                    },
                );
                req.end(data);
            });
            assert.deepEqual(out.find((e) => e.type === 'tools').calls, [
                { id: 't1', name: 'getCount', input: { x: 1 } },
            ]);
            assert.equal(out.at(-1).text, 'count is 42');
            assert.equal(out.at(-1).tier, 'quick');
            assert.equal(seen.at(-1).body.model, 'claude-haiku-4-5');
            assert.equal(seen.at(-1).body.fallbacks, undefined);
            assert.equal(seen.at(-1).body.tools[0].eager_input_streaming, true);
            assert.equal(seen.at(-1).body.messages.at(-1).content[0].tool_use_id, 't1');
        } finally {
            delete process.env['ANTHROPIC_API_KEY'];
            delete process.env['ANTHROPIC_BASE_URL'];
            api.close();
        }
    });

    test('sample: the reply is read tolerantly as JSON', () => {
        assert.deepEqual(parseJson('Here you go:\n```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
        assert.deepEqual(parseJson('Sure. [1,2] Done.'), { ok: true, value: [1, 2] });
        assert.deepEqual(parseJson('no json'), { ok: false });
    });

    test('mcp: host servers from the local config, consent per server, writes only with a one-time viewer approval', async () => {
        writeFileSync(
            join(HOME, 'mcp.json'),
            JSON.stringify({
                mcpServers: {
                    'my notes': {
                        command: process.execPath,
                        args: [join(import.meta.dirname, 'fixtures', 'mcp-notes.mjs')],
                    },
                },
            }),
        );
        assert.ok(configured(project).has('host:my_notes'));
        const id = await publish({
            mcp: { servers: [{ server: 'host:my_notes', tools: ['get_notes', 'add_note'] }], project },
        });
        const mcp = (verb: string, b: unknown) => page(id, 'POST', `/_frame/api/mcp/${verb}`, b).then((r) => r.body);
        assert.deepEqual((await mcp('list', {})).servers[0], {
            server: 'host:my_notes',
            authStatus: 'unknown',
            tools: [
                { name: 'get_notes', description: '' },
                { name: 'add_note', description: '' },
            ],
        });
        assert.equal((await mcp('call', { server: 'host:my_notes', tool: 'get_notes' })).error.code, 'not_in_manifest');
        await grant(id, 'mcp:host:my_notes');
        const listed = (await mcp('list', {})).servers[0];
        assert.equal(listed.authStatus, 'connected');
        assert.deepEqual(
            listed.tools.map((t: any) => [t.name, t.annotations.readOnlyHint]),
            [
                ['get_notes', true],
                ['add_note', false],
            ],
        );
        assert.deepEqual((await mcp('call', { server: 'host:my_notes', tool: 'get_notes', input: {} })).payload, {
            notes: ['first'],
        });
        assert.equal((await mcp('call', { server: 'host:my_notes', tool: 'secret' })).error.code, 'not_in_manifest');
        const write = { server: 'host:my_notes', tool: 'add_note', input: { text: 'second' } };
        assert.equal((await mcp('call', write)).error.code, 'confirm_required');
        const { token } = (await shell('POST', `/api/a/${id}/mcp-approve`, write)).body;
        assert.equal(
            (await mcp('call', { ...write, input: { text: 'other' }, approval: token })).error.code,
            'confirm_required',
        );
        assert.deepEqual((await mcp('call', { ...write, approval: token })).payload, { count: 2 });
        assert.equal(
            (await mcp('call', { ...write, approval: token })).error.code,
            'confirm_required',
            'an approval is good once',
        );
        const t2 = (await shell('POST', `/api/a/${id}/mcp-approve`, { ...write, input: {} })).body.token;
        assert.equal((await mcp('call', { ...write, input: {}, approval: t2 })).error.code, 'tool_error');
        assert.equal(
            (await mcp('describe', { server: 'host:my_notes', tool: 'add_note' })).inputSchema.required[0],
            'text',
        );
    });
});
