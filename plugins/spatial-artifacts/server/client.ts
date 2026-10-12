// finds or starts the daemon and calls its agent api
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOME, PORT } from './constants.ts';

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), 'daemon.ts');
const SERVER_FILE = join(HOME, 'server.json');
const START_MS = 15000;

type Conn = { port: number; token: string };
type Res = { status: number; body: any };
let conn: Conn | undefined;

const read = (): Conn | undefined =>
    existsSync(SERVER_FILE) ? JSON.parse(readFileSync(SERVER_FILE, 'utf8')) : undefined;

// node:http so the Host header is ours to set: the daemon only answers localhost hosts
const call = (c: Conn, method: string, path: string, body?: unknown) =>
    new Promise<Res>((ok) => {
        const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = request(
            {
                host: '127.0.0.1',
                port: c.port,
                method,
                path,
                headers: {
                    host: `localhost:${c.port}`,
                    authorization: `Bearer ${c.token}`,
                    ...(data && { 'content-type': 'application/json', 'content-length': data.length }),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (d: Buffer) => chunks.push(d));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    const isJson = String(res.headers['content-type']).startsWith('application/json');
                    ok({ status: res.statusCode ?? 0, body: isJson ? JSON.parse(text) : text });
                });
            },
        );
        req.on('error', () => ok({ status: 0, body: 'unreachable' }));
        req.end(data);
    });

// a token-checked call proves it is our daemon, not another process on the port
const healthy = async (c: Conn) => (await call(c, 'GET', '/_agent/artifacts')).status === 200;

/** returns a live connection; with start=false, undefined when no daemon runs */
export const ensureDaemon = async (start = true) => {
    if (conn && (await healthy(conn))) {
        return conn;
    }
    const cur = read();
    const live = cur && (await healthy(cur));
    if (live && cur.port === PORT) {
        return (conn = cur);
    }
    if (!start) {
        return live ? cur : undefined;
    }
    // a daemon from an older port setting: replace it so links match the configured port
    if (live) {
        process.kill((cur as Conn & { pid: number }).pid);
    }
    mkdirSync(HOME, { recursive: true });
    const log = openSync(join(HOME, 'server.log'), 'a');
    spawn(process.execPath, [DAEMON], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
    const deadline = Date.now() + START_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        const c = read();
        if (c && c.token !== cur?.token && (await healthy(c))) {
            return (conn = c);
        }
    }
    const tail = existsSync(join(HOME, 'server.log'))
        ? readFileSync(join(HOME, 'server.log'), 'utf8').split('\n').slice(-12).join('\n')
        : '';
    throw new Error(`the local artifact server did not start within ${START_MS / 1000}s. server.log:\n${tail}`);
};

export const base = (c: Conn) => `http://localhost:${c.port}`;

/** whether a process with this pid is running */
export const alive = (pid: number) => {
    try {
        return process.kill(pid, 0);
    } catch {
        return false;
    }
};

/** the claude or codex process this one runs under (its parent, or a few levels up past shells): keys the session */
export const host = () => {
    for (let p = process.ppid, i = 0; i < 4 && p > 1; i++) {
        const [pp, ...args] = (
            spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(p)], { encoding: 'utf8' }).stdout ?? ''
        )
            .trim()
            .split(/\s+/);

        // args[0] is the binary, or node when it runs an npm-installed script
        const exe = args.slice(0, 2).find((a) => /^(claude|codex)$/.test(basename(a)));
        if (exe) {
            return {
                pid: p,
                exe: exe.startsWith('/') ? exe : basename(exe),
                kind: basename(exe) as 'claude' | 'codex',
            };
        }
        p = Number(pp);
    }
    return undefined;
};

/** agent api call; resolves {status, body} and never throws on http errors */
export const api = async (method: string, path: string, body?: unknown) =>
    call((await ensureDaemon()) as Conn, method, path, body);
