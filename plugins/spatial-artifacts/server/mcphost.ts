// the mcp capability's local half: the viewer's own MCP servers, as Claude Code configures them for the artifact's project
// (`host:<name>` in a page's manifest). the daemon runs each one itself, over stdio or streamable http, the first time a page
// calls it, and stops it after a quiet spell. claude.ai connectors have no local counterpart
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { HOME } from './constants.ts';

const PROTOCOL = '2025-06-18';
const CALL_MS = 130000;
const IDLE_MS = 5 * 60 * 1000;

export type ServerConfig = {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    cwd?: string;
};
export type McpErr = {
    code: string;
    message: string;
    server?: string;
    retryable?: true;
    retryAfterMs?: number;
    result?: unknown;
};
type Tool = {
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
};

/** `<name>` as a page names it: anything outside [A-Za-z0-9_-] becomes `_`, as in the original */
export const hostName = (name: string) => `host:${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const readJson = (f: string) => {
    try {
        return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
    } catch {
        return undefined;
    }
};

// ${VAR} and ${VAR:-default}, as Claude Code expands them in .mcp.json
const expand = (v: unknown): any =>
    typeof v === 'string'
        ? v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '')
        : Array.isArray(v)
          ? v.map(expand)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
            : v;

/** the servers configured for `project`, by page name; later sources win: user, project .mcp.json, local, then the plugin's own file */
export const configured = (project: string): Map<string, ServerConfig> => {
    const out = new Map<string, ServerConfig>();
    const add = (o: unknown) => {
        if (!o || typeof o !== 'object') {
            return;
        }
        for (const [name, c] of Object.entries(o as Record<string, ServerConfig>)) {
            if (c && typeof c === 'object') {
                out.set(hostName(name), expand(c));
            }
        }
    };
    const user = readJson(join(homedir(), '.claude.json'));
    add(user?.mcpServers);
    add(readJson(join(project, '.mcp.json'))?.mcpServers);
    add(user?.projects?.[resolve(project)]?.mcpServers);
    add(readJson(join(HOME, 'mcp.json'))?.mcpServers);
    return out;
};

type Conn = {
    request: (method: string, params?: unknown) => Promise<any>;
    close: () => void;
    tools?: Tool[];
    timer?: ReturnType<typeof setTimeout>;
};

const stdio = (cfg: ServerConfig, command: string, cwd: string): Promise<Conn> =>
    new Promise((ok, no) => {
        let child: ChildProcessByStdio<Writable, Readable, null>;
        try {
            child = spawn(command, cfg.args ?? [], {
                cwd: cfg.cwd ?? cwd,
                env: { ...process.env, ...(cfg.env ?? {}) },
                stdio: ['pipe', 'pipe', 'ignore'],
            });
        } catch (e: any) {
            return no({ code: 'server_not_connected', message: `could not start ${cfg.command}: ${e.message}` });
        }
        let n = 0;
        let buf = '';
        const waits = new Map<number, { ok: (v: any) => void; no: (e: any) => void }>();
        const dead = (why: string) => {
            for (const w of waits.values()) {
                w.no({ code: 'server_unavailable', message: why, retryable: true });
            }
            waits.clear();
        };
        child.on(
            'error',
            (e) => (
                dead(e.message),
                no({ code: 'server_not_connected', message: `could not start ${cfg.command}: ${e.message}` })
            ),
        );
        child.on('exit', (c) => dead(`the server exited (${c})`));
        child.stdout.on('data', (d) => {
            buf += d;
            for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
                let m: any;
                try {
                    m = JSON.parse(buf.slice(0, i));
                } catch {
                    continue;
                }
                const w = m && waits.get(m.id);
                if (!w) {
                    continue;
                }
                waits.delete(m.id);
                if (m.error) {
                    w.no({ code: 'upstream_error', message: m.error.message ?? 'MCP error' });
                } else {
                    w.ok(m.result);
                }
            }
        });
        const request = (method: string, params?: unknown) =>
            new Promise((rok, rno) => {
                const id = ++n;
                const t = setTimeout(
                    () => (
                        waits.delete(id),
                        rno({
                            code: 'server_unavailable',
                            message: 'the server did not answer in time',
                            retryable: true,
                        })
                    ),
                    CALL_MS,
                );
                waits.set(id, { ok: (v) => (clearTimeout(t), rok(v)), no: (e) => (clearTimeout(t), rno(e)) });
                child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
            });
        const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
        const conn: Conn = { request, close: () => child.kill() };
        request('initialize', {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: 'spatial-artifacts', version: '1' },
        }).then(
            () => (notify('notifications/initialized'), ok(conn)),
            (e) => (
                child.kill(),
                no({ code: 'server_not_connected', message: `the server did not initialize: ${e.message}` })
            ),
        );
    });

// streamable http: one POST per message; the answer comes back as JSON or as an event stream
const http = async (cfg: ServerConfig, url: string): Promise<Conn> => {
    let session: string | undefined;
    let n = 0;
    const send = async (body: unknown, expectId?: number) => {
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'mcp-protocol-version': PROTOCOL,
                ...(session && { 'mcp-session-id': session }),
                ...(cfg.headers ?? {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(CALL_MS),
        }).catch((e) => {
            throw { code: 'server_unavailable', message: e.message, retryable: true };
        });
        session = r.headers.get('mcp-session-id') ?? session;
        if (r.status === 401 || r.status === 403) {
            throw {
                code: 'needs_reauth',
                message: `the server answered ${r.status}; its credentials need refreshing in your MCP configuration`,
            };
        }
        if (r.status >= 500) {
            throw { code: 'server_unavailable', message: `the server answered ${r.status}`, retryable: true };
        }
        if (expectId === undefined) {
            return undefined;
        }
        if (!r.ok) {
            throw { code: 'upstream_error', message: `the server answered ${r.status}` };
        }
        const type = r.headers.get('content-type') ?? '';
        const msgs: any[] = [];
        if (type.includes('text/event-stream')) {
            for (const frame of (await r.text()).split('\n\n')) {
                const data = frame
                    .split('\n')
                    .filter((l) => l.startsWith('data:'))
                    .map((l) => l.slice(5))
                    .join('\n');
                if (data) {
                    msgs.push(JSON.parse(data));
                }
            }
        } else {
            msgs.push(await r.json());
        }
        const m = msgs.find((x) => x?.id === expectId);
        if (!m) {
            throw { code: 'upstream_error', message: 'the server sent no answer' };
        }
        if (m.error) {
            throw { code: 'upstream_error', message: m.error.message ?? 'MCP error' };
        }
        return m.result;
    };
    const request = (method: string, params?: unknown) => {
        const id = ++n;
        return send({ jsonrpc: '2.0', id, method, params }, id);
    };
    await request('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'spatial-artifacts', version: '1' },
    }).catch((e) => {
        throw e.code === 'needs_reauth'
            ? e
            : { code: 'server_not_connected', message: `the server did not initialize: ${e.message}` };
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { request, close: () => undefined };
};

/** the json payload most servers return: structuredContent, else the first text block parsed as JSON, else that text */
export const payloadOf = (r: any) => {
    if (r?.structuredContent !== undefined) {
        return r.structuredContent;
    }
    const t = Array.isArray(r?.content) ? r.content.find((b: any) => b?.type === 'text') : undefined;
    if (!t) {
        return undefined;
    }
    try {
        return JSON.parse(t.text);
    } catch {
        return t.text;
    }
};

export const createHosts = () => {
    // project + server -> live connection
    const conns = new Map<string, Promise<Conn>>();

    const connect = (project: string, server: string): Promise<Conn> => {
        const key = `${project}\0${server}`;
        const have = conns.get(key);
        if (have) {
            return have;
        }
        const cfg = configured(project).get(server);
        if (!cfg) {
            return Promise.reject({
                code: 'server_not_connected',
                message: `no MCP server is configured as ${server.slice(5)} for ${project}`,
            });
        }
        const type = cfg.type ?? (cfg.url ? 'http' : 'stdio');
        const p =
            type === 'stdio' && cfg.command
                ? stdio(cfg, cfg.command, project)
                : type === 'http' && cfg.url
                  ? http(cfg, cfg.url)
                  : Promise.reject({
                        code: 'server_not_connected',
                        message: `${server.slice(5)} is a ${type} server, which the local viewer does not run (stdio and http only)`,
                    });
        conns.set(key, p);
        p.catch(() => conns.delete(key));
        return p.then((c) => {
            if (c.timer) {
                clearTimeout(c.timer);
            }
            c.timer = setTimeout(() => (c.close(), conns.delete(key)), IDLE_MS);
            c.timer.unref?.();
            return c;
        });
    };

    const tools = async (project: string, server: string): Promise<Tool[]> => {
        const c = await connect(project, server);
        if (!c.tools) {
            const all: Tool[] = [];
            let cursor: string | undefined;
            do {
                const r = await c.request('tools/list', cursor ? { cursor } : {});
                all.push(...(r?.tools ?? []));
                cursor = r?.nextCursor;
            } while (cursor && all.length < 2000);
            c.tools = all;
        }
        return c.tools;
    };

    const call = async (project: string, server: string, tool: string, input: unknown) => {
        const c = await connect(project, server);
        const r = await c.request('tools/call', { name: tool, arguments: input ?? {} });
        if (r?.isError) {
            const t = Array.isArray(r.content) ? r.content.find((b: any) => b?.type === 'text')?.text : undefined;
            throw { code: 'tool_error', message: t ?? 'the tool reported a failure', server, result: r };
        }
        return {
            content: Array.isArray(r?.content) ? r.content : [],
            ...(r?.structuredContent !== undefined && { structuredContent: r.structuredContent }),
            payload: payloadOf(r),
        };
    };

    const closeAll = () => {
        for (const p of conns.values()) {
            p.then(
                (c) => c.close(),
                () => undefined,
            );
        }
        conns.clear();
    };

    return { tools, call, closeAll };
};
