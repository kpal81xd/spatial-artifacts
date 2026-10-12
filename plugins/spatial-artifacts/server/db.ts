// the per-artifact document database. paths alternate collection/document, like firestore.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    COLLECTION_RE,
    DB_BATCH_MAX,
    DB_DOC_MAX_BYTES,
    DB_MAX_DOCS,
    DB_QUERY_DEFAULT,
    DB_QUERY_MAX,
    DB_STR_MAX,
    DOC_ID_RE,
    FIELD_RE,
} from './constants.ts';
import { dir, me, writeAtomic } from './store.ts';

export type Doc = { data: Record<string, unknown>; version: number; updatedAt: string };
export type DbError = { code: string; message: string; current?: number | undefined };

const file = (id: string) => join(dir(id), 'db.json');
const load = (id: string): Record<string, Doc> =>
    existsSync(file(id)) ? JSON.parse(readFileSync(file(id), 'utf8')) : {};
const save = (id: string, d: Record<string, Doc>) => writeAtomic(file(id), JSON.stringify(d));

const OPS: Record<string, string> = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };

/** "data/users/me/..." names the local person */
export const resolveMe = (collection: string) =>
    collection.replace(/^data\/users\/me(?=\/|$)/, `data/users/${me().id}`);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDel = (v: unknown) => isObj(v) && v['__delete__'] === true && Object.keys(v).length === 1;

const hasDelete = (v: unknown): boolean =>
    isDel(v) || (Array.isArray(v) ? v.some(hasDelete) : isObj(v) && Object.values(v).some(hasDelete));

const inArray = (v: unknown, within = false): boolean =>
    Array.isArray(v)
        ? v.some((x) => inArray(x, true))
        : isObj(v)
          ? (within && isDel(v)) || Object.values(v).some((x) => inArray(x, within))
          : false;

const merge = (base: Record<string, unknown>, patch: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (isDel(v)) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- json record keyed by field
            delete out[k];
        } else if (isObj(v) && isObj(out[k])) {
            out[k] = merge(out[k] as Record<string, unknown>, v);
        } else if (isObj(v)) {
            out[k] = merge({}, v);
        } else {
            out[k] = v;
        }
    }
    return out;
};

const field = (data: Record<string, unknown>, path: string) =>
    path.split('.').reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), data);

const cmp = (a: unknown, b: unknown) => {
    if (a === b) {
        return 0;
    }
    if (a === undefined) {
        return -1;
    }
    if (b === undefined) {
        return 1;
    }
    return (a as number) < (b as number) ? -1 : 1;
};

const test = (v: unknown, op: string, x: unknown) => {
    switch (op) {
        case 'eq':
            return JSON.stringify(v) === JSON.stringify(x);
        case 'ne':
            return JSON.stringify(v) !== JSON.stringify(x);
        case 'lt':
            return v !== undefined && cmp(v, x) < 0;
        case 'lte':
            return v !== undefined && cmp(v, x) <= 0;
        case 'gt':
            return v !== undefined && cmp(v, x) > 0;
        case 'gte':
            return v !== undefined && cmp(v, x) >= 0;
        case 'in':
            return Array.isArray(x) && x.some((y) => JSON.stringify(y) === JSON.stringify(v));
        case 'not-in':
            return Array.isArray(x) && !x.some((y) => JSON.stringify(y) === JSON.stringify(v));
        case 'array-contains':
            return Array.isArray(v) && v.some((y) => JSON.stringify(y) === JSON.stringify(x));
    }
    return false;
};

const parent = (path: string) => path.slice(0, path.lastIndexOf('/'));
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// the page reaches the db without the tool's schema, so every path is checked here
const badPath = (collection: unknown, docId?: unknown) =>
    typeof collection !== 'string' || !COLLECTION_RE.test(collection) || collection.split('/').length % 2 === 0
        ? `collection must be an odd number of "/"-separated segments (letters, digits, _ - . ~ : @ +)`
        : docId !== undefined && (typeof docId !== 'string' || !DOC_ID_RE.test(docId))
          ? 'doc_id must be one path segment (letters, digits, _ - . ~ : @ +)'
          : undefined;

export const get = (id: string, collection: string, docId: string) => {
    if (badPath(collection, docId)) {
        return undefined;
    }
    const p = `${resolveMe(collection)}/${docId}`;
    const d = load(id)[p];
    return d ? { id: docId, ...d } : undefined;
};

export type Query = {
    where?: [string, string, unknown][];
    order_by?: { field: string; direction?: 'asc' | 'desc' };
    limit?: number;
    cursor?: string;
};

export const query = (id: string, collection: string, q: Query = {}) => {
    const why = badPath(collection);
    if (why) {
        return { error: fail('invalid_argument', why), docs: [] };
    }
    const c = resolveMe(collection);
    const all = load(id);
    let docs = Object.entries(all)
        .filter(([p]) => parent(p) === c)
        .map(([p, d]) => ({ id: leaf(p), ...d }))
        .sort((a, b) => a.id.localeCompare(b.id));
    for (const [f, op, v] of q.where ?? []) {
        docs = docs.filter((d) => test(field(d.data, f), OPS[op] ?? op, v));
    }
    const limit = Math.min(q.limit ?? DB_QUERY_DEFAULT, DB_QUERY_MAX);
    if (q.order_by) {
        const dirn = q.order_by.direction === 'desc' ? -1 : 1;
        const f = q.order_by.field;
        docs.sort((a, b) => dirn * cmp(field(a.data, f), field(b.data, f)));
        return { docs: docs.slice(0, limit), ordered: true, more: docs.length > limit };
    }
    if (q.cursor) {
        const after = Buffer.from(q.cursor, 'base64url').toString('utf8');
        docs = docs.filter((d) => d.id > after);
    }
    const page = docs.slice(0, limit);
    const next = docs.length > limit ? Buffer.from(page[page.length - 1].id).toString('base64url') : undefined;
    return { docs: page, next_cursor: next };
};

export type Write = {
    op: 'set' | 'update' | 'delete' | 'str_replace';
    collection: string;
    doc_id: string;
    data?: Record<string, unknown>;
    if_version?: number;
    field?: string;
    old_str?: string;
    new_str?: string;
    replace_all?: boolean;
};

const fail = (code: string, message: string, current?: number): DbError => ({ code, message, current });

/**
 * checks one write against the current state; returns the new doc (null = delete) or an error.
 * with `pinned`, a write to a document that exists must carry its if_version (SpatialArtifactData's rule; a page's own writes are exempt)
 */
const plan = (all: Record<string, Doc>, w: Write, pinned = false): { path: string; next: Doc | null } | DbError => {
    const why = badPath(w.collection, w.doc_id);
    if (why) {
        return fail('invalid_argument', why);
    }
    const path = `${resolveMe(w.collection)}/${w.doc_id}`;
    const cur = all[path];
    if (pinned && cur && w.if_version === undefined) {
        return fail(
            'version_required',
            `document ${path} already exists (version ${cur.version}) and the write carries no if_version`,
            cur.version,
        );
    }
    if (w.if_version !== undefined && (cur?.version ?? 0) !== w.if_version) {
        return fail(
            'version_mismatch',
            `document ${path} is at version ${cur?.version ?? 'none (deleted or never written)'}, not ${w.if_version}`,
            cur?.version,
        );
    }
    if (!cur && w.op !== 'delete' && Object.keys(all).length >= DB_MAX_DOCS) {
        return fail('too_large', `the database holds at most ${DB_MAX_DOCS} documents`);
    }
    const r = next(cur, w, path);
    return 'code' in r || !r.next || Buffer.byteLength(JSON.stringify(r.next.data)) <= DB_DOC_MAX_BYTES
        ? r
        : fail('too_large', `document ${path} would be over ${DB_DOC_MAX_BYTES / 1024 / 1024} MiB`);
};

const next = (cur: Doc | undefined, w: Write, path: string): { path: string; next: Doc | null } | DbError => {
    const at = new Date().toISOString();
    const version = (cur?.version ?? 0) + 1;
    switch (w.op) {
        case 'delete':
            if (!cur) {
                return fail('not_found', `no document ${path}`);
            }
            return { path, next: null };
        case 'set':
            if (!isObj(w.data)) {
                return fail('invalid_argument', 'set needs a JSON object as data');
            }
            if (hasDelete(w.data)) {
                return fail('invalid_argument', '"set" rejects {"__delete__": true}: use "update" to remove a field');
            }
            return { path, next: { data: w.data, version, updatedAt: at } };
        case 'update':
            if (!isObj(w.data)) {
                return fail('invalid_argument', 'update needs a JSON object as data');
            }
            if (inArray(w.data)) {
                return fail('invalid_argument', '{"__delete__": true} is rejected inside arrays');
            }
            return { path, next: { data: merge(cur?.data ?? {}, w.data), version, updatedAt: at } };
        case 'str_replace': {
            if (!cur) {
                return fail('not_found', `no document ${path}`);
            }
            if (typeof w.field !== 'string' || !FIELD_RE.test(w.field)) {
                return fail('invalid_argument', 'field must name one top-level key');
            }
            if (typeof w.old_str !== 'string' || !w.old_str || typeof w.new_str !== 'string') {
                return fail('invalid_argument', 'str_replace needs a non-empty old_str and a new_str');
            }
            if (w.old_str.length > DB_STR_MAX || w.new_str.length > DB_STR_MAX) {
                return fail('too_large', `old_str and new_str are at most ${DB_STR_MAX} characters`);
            }
            const v = cur.data[w.field];
            if (v === undefined) {
                return fail('edit_field_missing', `document ${path} has no field ${w.field}`);
            }
            if (typeof v !== 'string') {
                return fail('edit_field_not_string', `field ${w.field} of ${path} is not a string`);
            }
            const n = v.split(w.old_str).length - 1;
            if (n === 0) {
                return fail('edit_no_match', `old_str does not occur in field ${w.field}`);
            }
            if (n > 1 && !w.replace_all) {
                return fail(
                    'edit_ambiguous',
                    `old_str occurs ${n} times in field ${w.field}; set replace_all or use a longer old_str`,
                );
            }
            const to = w.new_str;
            const s = w.replace_all ? v.split(w.old_str).join(to) : v.replace(w.old_str, () => to);
            return { path, next: { data: { ...cur.data, [w.field]: s }, version, updatedAt: at } };
        }
        default:
            return fail('invalid_argument', `unknown write operation "${w.op}"`);
    }
};

const isErr = (x: unknown): x is DbError => isObj(x) && typeof x['code'] === 'string';

export const write = (id: string, w: Write, pinned = false) => {
    const all = load(id);
    const r = plan(all, w, pinned);
    if (isErr(r)) {
        return { error: r };
    }
    if (r.next) {
        all[r.path] = r.next;
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- docs are keyed by path
        delete all[r.path];
    }
    save(id, all);
    return { version: r.next?.version, path: r.path, usage: usage(all) };
};

/** all-or-nothing: every entry is planned against the same snapshot before any is applied */
export const batch = (id: string, writes: Write[], pinned = false) => {
    if (writes.length === 0 || writes.length > DB_BATCH_MAX) {
        return { error: fail('invalid_argument', `a batch takes 1-${DB_BATCH_MAX} writes`) };
    }
    const all = load(id);
    const seen = new Set<string>();
    const results: { version?: number | undefined; path: string }[] = [];
    for (const [i, w] of writes.entries()) {
        const r = plan(all, w, pinned);
        if (isErr(r)) {
            return { error: { ...r, message: `entry ${i}: ${r.message}` }, index: i };
        }
        if (seen.has(r.path)) {
            return { error: fail('invalid_argument', `entry ${i}: ${r.path} is addressed twice`), index: i };
        }
        seen.add(r.path);
        results.push({ path: r.path, version: r.next?.version });
    }
    for (const [i, w] of writes.entries()) {
        const r = plan(all, w) as { path: string; next: Doc | null };
        if (r.next) {
            all[r.path] = r.next;
        } else {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- docs are keyed by path
            delete all[r.path];
        }
        results[i].version = r.next?.version;
    }
    save(id, all);
    return { results, usage: usage(all) };
};

const usage = (all: Record<string, Doc>) => ({ documents: Object.keys(all).length, maxDocuments: 100000 });

/** paths that changed, for live subscriptions */
export const changed = (w: Write | Write[]) =>
    (Array.isArray(w) ? w : [w]).map((x) => `${resolveMe(x.collection)}/${x.doc_id}`);
