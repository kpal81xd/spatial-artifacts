// stdio mcp server exposing SpatialArtifact, SpatialArtifactComments, SpatialArtifactData and SpatialArtifactCheck
import { createInterface } from 'node:readline';

import { api, ensureDaemon, host } from './client.ts';
import { PRESENCE_MS } from './constants.ts';
import * as P from './prompts.ts';
import * as SC from './schemas.ts';
import { artifact } from './tools/artifact.ts';
import { check } from './tools/check.ts';
import { comments } from './tools/comments.ts';
import { InputError, type Result, session, text } from './tools/common.ts';
import { data } from './tools/data.ts';
import { validate } from './validate.ts';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
    {
        name: 'SpatialArtifact',
        description: P.ARTIFACT,
        inputSchema: SC.ARTIFACT,
        run: artifact,
        annotations: { title: 'SpatialArtifact', openWorldHint: false },
    },
    {
        name: 'SpatialArtifactComments',
        description: P.COMMENTS,
        inputSchema: SC.COMMENTS,
        run: comments,
        annotations: { title: 'SpatialArtifact comments', openWorldHint: false },
    },
    {
        name: 'SpatialArtifactData',
        description: P.DATA,
        inputSchema: SC.DATA,
        run: data,
        annotations: { title: 'SpatialArtifact database', openWorldHint: false },
    },
    {
        name: 'SpatialArtifactCheck',
        description: P.CHECK,
        inputSchema: SC.CHECK,
        run: check,
        annotations: { title: 'SpatialArtifact check', readOnlyHint: true, openWorldHint: false },
    },
];

export const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) {
        return text(`unknown tool ${name}`, true);
    }
    const err = validate(t.inputSchema as never, args);
    if (err) {
        return text(`InputValidationError: ${err}`, true);
    }
    return t
        .run(args)
        .catch((e: Error) => text(e instanceof InputError ? e.message : `${name} failed: ${e.message}`, true));
};

const handle = async (msg: any) => {
    const { id, method, params } = msg;
    switch (method) {
        case 'initialize':
            return {
                protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'spatial-artifacts', version: '0.1.1' },
                instructions: P.INSTRUCTIONS,
            };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: TOOLS.map(({ run: _run, ...t }) => t) };
        case 'tools/call':
            return callTool(params?.name, params?.arguments ?? {}).finally(() => void beat());
    }
    if (id === undefined) {
        return undefined;
    }
    throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
};

// checks in with the artifacts this session published or read, so their pages show whether Claude is there and
// comments reach only this session; never starts the daemon
const me = process.argv[1]?.endsWith('mcp.ts') ? host() : undefined;
const beat = () =>
    me &&
    ensureDaemon(false)
        .then(
            (c) =>
                c &&
                api('POST', '/_agent/presence', {
                    host: me.pid,
                    artifacts: [...new Set([...session.seen.keys(), ...session.linked])],
                }),
        )
        .catch(() => undefined);

if (process.argv[1]?.endsWith('mcp.ts')) {
    setInterval(beat, PRESENCE_MS).unref();
    beat();
    const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
    createInterface({ input: process.stdin }).on('line', (line) => {
        if (!line.trim()) {
            return;
        }
        const msg = JSON.parse(line);
        handle(msg).then(
            (result) => msg.id !== undefined && result !== undefined && out({ jsonrpc: '2.0', id: msg.id, result }),
            (e: Error & { code?: number }) =>
                msg.id !== undefined &&
                out({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
        );
    });
}
