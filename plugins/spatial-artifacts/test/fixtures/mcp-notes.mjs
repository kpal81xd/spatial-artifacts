// a tiny stdio MCP server for tests: a read-only get_notes and a writing add_note
import { createInterface } from 'node:readline';

const notes = ['first'];
const tools = [
    { name: 'get_notes', description: 'Lists the notes.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'add_note', description: 'Adds a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: false } },
    { name: 'secret', description: 'Not in any manifest.', inputSchema: { type: 'object' } },
];
const out = m => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1' } } });
    if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools } });
    if (m.method === 'tools/call') {
        const { name, arguments: a } = m.params;
        if (name === 'get_notes') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ notes }) }] } });
        if (name === 'add_note') {
            if (!a?.text) return out({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'text is required' }] } });
            notes.push(a.text);
            return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { count: notes.length } } });
        }
    }
    out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
});
