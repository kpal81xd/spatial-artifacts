import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// drives every capability that acts as the viewer through the real viewer and runtime in Chromium, against a mock
// Messages API and the fixture MCP server. not part of `npm test` (it needs Playwright):
//   CHROME_PATH=/path/to/chrome node test/manual/capabilities.e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() =>
    require(`${process.env.PLAYWRIGHT_DIR ?? '/opt/node22/lib/node_modules/'}playwright`),
);
const HOME = mkdtempSync(join(tmpdir(), 'da-e2e-'));
process.env.SPATIAL_ARTIFACTS_DIR = HOME;
const P = join(import.meta.dirname, '..', '..', 'plugins', 'spatial-artifacts');
const project = mkdtempSync(join(tmpdir(), 'da-proj-'));
mkdirSync(join(project, 'src'));
writeFileSync(join(project, 'src', 'a.txt'), 'hello files');
writeFileSync(
    join(HOME, 'mcp.json'),
    JSON.stringify({
        mcpServers: { notes: { command: process.execPath, args: [`${P}/test/fixtures/mcp-notes.mjs`] } },
    }),
);
const { startDaemon } = await import(`${P}/server/daemon.ts`);
const { wrapHtml } = await import(`${P}/server/wrap.ts`);
const d = await startDaemon({ port: 0 });
const agent = (m, p, b) =>
    fetch(`http://127.0.0.1:${d.port}${p}`, {
        method: m,
        headers: {
            host: `localhost:${d.port}`,
            authorization: `Bearer ${d.token}`,
            'content-type': 'application/json',
        },
        body: b && JSON.stringify(b),
    }).then((r) => r.json());
const html = `<title>Caps</title><h1>Caps</h1><p id=target>Target paragraph</p><button id=compose>Comment here</button><button id=send>Send to Claude</button><button id=custom>Custom compose</button><canvas id=cv width=200 height=100></canvas>
<script>
window.log = [];
window.go = async () => {
  const r = {};
  const perm = await claude.use('permissions');
  r.before = await perm.state();
  r.request = perm.request(['files', 'mcp:host:notes', 'comments']);
  return r;
};
</script>`;
const caps = {
    comments: { customAnchors: true },
    files: { project },
    room: {},
    mcp: { servers: [{ server: 'host:notes', tools: ['get_notes', 'add_note'] }], project },
    user: {},
};
const pub = await agent('POST', '/_agent/publish', { title: 'Caps', html: wrapHtml(html), capabilities: caps });
const browser = await chromium.launch({ ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }) });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://localhost:${d.port}/code/artifact/${pub.id}`);
const frame = await (await page.waitForSelector('iframe')).contentFrame();
await frame.waitForFunction(() => window.go);
const check = (name, v) => console.log(name.padEnd(28), typeof v === 'string' ? v : JSON.stringify(v));

// permissions: prompt states, then one batched dialog
check('state before', await frame.evaluate(async () => (await claude.use('permissions')).state()));
await frame.evaluate(() => {
    window.req = claude.use('permissions').then((p) => p.request(['files', 'mcp:host:notes', 'comments']));
});
await page.waitForSelector('.ask-box');
check('consent dialog', (await page.textContent('.ask-box')).replace(/\s+/g, ' ').slice(0, 300));
await page.click('.ask-box .btn.primary');
check('state after allow', await frame.evaluate(() => window.req));

// files
check(
    'files.read',
    await frame.evaluate(async () => {
        const f = await claude.use('files');
        const r = await f.read('src/a.txt');
        return [new TextDecoder().decode(r.bytes), r.size];
    }),
);
check(
    'files.list',
    await frame.evaluate(async () =>
        (await (await claude.use('files')).list({ recursive: true })).entries.map((e) => e.path),
    ),
);
check(
    'files traversal',
    await frame.evaluate(async () =>
        (await claude.use('files')).read('../x').then(
            () => 'read!',
            (e) => e.code,
        ),
    ),
);

// mcp: a read, a write the viewer confirms, a handle, a watch
check(
    'mcp read',
    await frame.evaluate(async () => (await (await claude.use('mcp')).callTool('host:notes', 'get_notes', {})).payload),
);
await frame.evaluate(() => {
    window.w = claude.use('mcp').then((m) => m.callTool('host:notes', 'add_note', { text: 'from page' }));
});
await page.waitForSelector('.ask-box');
check('mcp confirm', (await page.textContent('.ask-box')).replace(/\s+/g, ' ').slice(0, 160));
await page.click('.ask-box .btn.primary');
check('mcp write', await frame.evaluate(async () => (await window.w).payload));
check(
    'mcp handle',
    await frame.evaluate(async () => (await (await claude.use('mcp')).server('host:notes')).get_notes()),
);
check(
    'mcp watch',
    await frame.evaluate(
        () =>
            new Promise(async (ok) => {
                const m = await claude.use('mcp');
                const stop = m.watchTool('host:notes', 'get_notes', {}, (ev) => {
                    stop();
                    ok(ev.type + ':' + JSON.stringify(ev.result?.payload));
                });
            }),
    ),
);
check(
    'mcp listTools',
    await frame.evaluate(async () =>
        (await (await claude.use('mcp')).listTools()).servers.map((s) => [s.server, s.authStatus, s.tools.length]),
    ),
);

// comments: create as the viewer, then the shell's composer from a page button
check(
    'comments create',
    await frame.evaluate(async () => {
        const c = await claude.use('comments');
        const a = await c.anchorFor(document.getElementById('target'));
        return (await c.create({ anchor: a, text: 'written by the page' })).threadId.length;
    }),
);
check('canSendToClaude', await frame.evaluate(async () => (await claude.use('comments')).canSendToClaude()));
await page.waitForTimeout(300);
await page.click('button[aria-label="Toggle comments"]').catch(() => {});
await page.waitForTimeout(300);
check(
    'viewer shows via',
    await page.evaluate(() => [...document.querySelectorAll('.comment .via')].map((e) => e.textContent)),
);
await frame.evaluate(() =>
    document.getElementById('compose').addEventListener('click', async () => {
        window.opened = await (
            await claude.use('comments')
        ).openComposer({ element: document.getElementById('target') });
    }),
);
await frame.click('#compose');
await page.waitForTimeout(500);
check('openComposer', await frame.evaluate(() => window.opened));
check('composer open', await page.evaluate(() => !!document.querySelector('textarea[aria-label="Comment"]')));
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

// custom anchors: the page names the spot, the shell posts the thread under that name
await frame.evaluate(async () => {
    const c = await claude.use('comments');
    window.ca = await c.customAnchors({
        mode: (on) => log.push('mode:' + on),
        threads: (l) => (window.threads = l),
        reveal: (id) => log.push('reveal:' + id),
        composing: (o) => log.push('composing:' + o),
    });
    document.getElementById('custom').addEventListener('click', async () => {
        window.cc = await window.ca.compose('shape-7', { x: 50, y: 300 }, { label: 'Shape 7' });
    });
});
await frame.click('#custom');
await page.waitForSelector('textarea[aria-label="Comment"]', { timeout: 5000 });
check('custom compose', await frame.evaluate(() => window.cc));
await page.fill('textarea[aria-label="Comment"]', 'about shape 7');
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
const threads = await agent('GET', `/_agent/a/${pub.id}/comments`);
check(
    'custom thread anchor',
    threads.threads.map((t) => t.anchor?.path),
);
check('threads callback', await frame.evaluate(() => (window.threads || []).map((t) => t.anchor)));
check('callbacks log', await frame.evaluate(() => window.log));

// room: a second view of the same artifact hears the first
const page2 = await browser.newPage();
await page2.goto(`http://${pub.id}.localhost:${d.port}/v/${pub.ver}/`);
await page2.waitForFunction(() => window.go);
await page2.evaluate(async () => {
    const r = await claude.use('room');
    window.got = [];
    r.on('cheer', (m) => window.got.push([m.data, m.sameTab, m.isMe]));
    r.onPeers((c) => (window.peers = c.peers.length));
    r.presence({ view: 'b' });
});
await frame.evaluate(async () => {
    const r = await claude.use('room');
    await new Promise((ok) => {
        const off = r.onConnection((c) => c && (off(), ok()));
    });
});
await page.waitForTimeout(500);
await frame.evaluate(async () => (await claude.use('room')).emit('cheer', { n: 1 }));
await page.waitForTimeout(500);
check('room heard', await page2.evaluate(() => window.got));
check('room peers', await page2.evaluate(() => window.peers));
check(
    'room presence seen',
    await frame.evaluate(async () =>
        (await claude.use('room')).peers().map((p) => [p.sameTab, p.presence.view ?? null]),
    ),
);
const g = await frame.evaluate(async () => {
    const r = await claude.use('room');
    const a = await r.join('game-1');
    return [a.name, a.peers().length];
});
check('room join', g);

// sendToClaudeSession: from a click, confirmed in the viewer, delivered with the next notice
await agent('POST', '/_agent/presence', { host: 4321, artifacts: [pub.id] });
check('canSendToClaudeSession', await frame.evaluate(async () => (await claude.use('room')).canSendToClaudeSession()));
await frame.evaluate(() =>
    document.getElementById('send').addEventListener('click', async () => {
        const r = await claude.use('room');
        window.sent = r
            .sendToClaudeSession(
                { label: 'Target', id: 7 },
                { deliver: 'send', onStatus: (s) => log.push('status:' + s.state) },
            )
            .then(
                (x) => x.to,
                (e) => e.code,
            );
    }),
);
await frame.click('#send');
await page.waitForSelector('.ask-box');
await page.click('.ask-box .btn.primary');
check('sent', await frame.evaluate(() => window.sent));
const pend = await agent('POST', '/_agent/pending', { host: 4321 });
check(
    'pending send',
    pend.map((p) => p.sends),
);
await page.waitForTimeout(400);
check('status log', await frame.evaluate(() => window.log.filter((x) => x.startsWith('status'))));

// permissions.manage: the viewer's own panel, revoke files
await frame.evaluate(() => {
    window.m = claude
        .use('permissions')
        .then((p) => p.manage())
        .then(
            () => 'closed',
            (e) => e.code,
        );
});
await page.waitForSelector('.perms-box');
check('panel rows', await page.evaluate(() => [...document.querySelectorAll('.perm-row b')].map((b) => b.textContent)));
await page.click('.perm-row:nth-of-type(2) button');
await page.waitForTimeout(200);
await page.click('.perms-box > .row .btn');
check('manage resolved', await frame.evaluate(() => window.m));
check('files after revoke', await frame.evaluate(async () => (await claude.use('permissions')).state('files')));
check('page errors', errs);
await browser.close();
await d.close();
api.close();
process.exit(0);
