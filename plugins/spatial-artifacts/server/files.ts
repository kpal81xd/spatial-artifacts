// the files capability: a page reads the project folder its artifact declares, once the viewer allowed it.
// paths are relative to that folder and never leave it, through `..` or a symlink; .git is never listed or read
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

export const PAGE_SIZE = 500;
export const READ_MAX = 25 * 1024 * 1024;
export const DOWNLOAD_MAX = 512 * 1024 * 1024;
const WALK_MAX = 20000;

// programs and scripts never leave as a download, as in the original
const NO_DOWNLOAD = new Set([
    '.exe',
    '.bat',
    '.cmd',
    '.com',
    '.scr',
    '.msi',
    '.ps1',
    '.vbs',
    '.js',
    '.mjs',
    '.cjs',
    '.jar',
    '.sh',
    '.app',
    '.dmg',
    '.pkg',
    '.deb',
    '.rpm',
    '.apk',
    '.dll',
    '.so',
    '.dylib',
]);

export type FilesError = { code: string; message: string };
const fail = (code: string, message: string): { error: FilesError } => ({ error: { code, message } });

const hidden = (rel: string) => rel.split(/[\\/]/).includes('.git');

/** the real path of `rel` inside `root`, or an error; the folder itself for '' */
export const inProject = (root: string, rel: unknown): { file: string; rel: string } | { error: FilesError } => {
    if (rel !== undefined && typeof rel !== 'string') {
        return fail('bad_request', 'path must be a string');
    }
    const r = String(rel ?? '').replace(/^\.\/+/, '');
    if (r.length > 4096 || r.startsWith('/') || /^[A-Za-z]:/.test(r) || r.includes('\0')) {
        return fail('bad_request', 'path must be relative to the project');
    }
    if (hidden(r)) {
        return fail('not_found', 'no file or folder at that path');
    }
    let base: string;
    try {
        base = realpathSync(root);
    } catch {
        return fail('unavailable', 'the project folder is not there any more');
    }
    const want = resolve(base, r);
    if (want !== base && !want.startsWith(base + sep)) {
        return fail('bad_request', 'path leaves the project');
    }
    if (!existsSync(want)) {
        return fail('not_found', 'no file or folder at that path');
    }
    const real = realpathSync(want);
    if (real !== base && !real.startsWith(base + sep)) {
        return fail('not_found', 'no file or folder at that path');
    }
    return { file: real, rel: relative(base, want).split(sep).join('/') };
};

export const revision = (file: string) => {
    const st = statSync(file);
    return createHash('sha256').update(`${st.size}:${st.mtimeMs}:${st.ino}`).digest('base64url').slice(0, 16);
};

const entry = (_base: string, file: string, rel: string) => {
    const st = statSync(file);
    return {
        path: rel,
        isDirectory: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        ...(st.birthtimeMs > 0 && { createdAt: st.birthtime.toISOString() }),
    };
};

export const list = (root: string, o: { path?: unknown; recursive?: unknown; cursor?: unknown }) => {
    const at = inProject(root, o.path ?? '');
    if ('error' in at) {
        return at;
    }
    if (!statSync(at.file).isDirectory()) {
        return fail('bad_request', 'path is a file, not a folder');
    }
    let start = 0;
    if (o.cursor !== undefined) {
        const n =
            typeof o.cursor === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(o.cursor)
                ? Number(Buffer.from(o.cursor, 'base64url').toString())
                : NaN;
        if (!Number.isInteger(n) || n < 0) {
            return fail('bad_request', 'malformed cursor');
        }
        start = n;
    }
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
        for (const name of readdirSync(dir).sort()) {
            if (name === '.git' || out.length >= WALK_MAX) {
                continue;
            }
            const r = rel ? `${rel}/${name}` : name;
            out.push(r);
            const full = join(dir, name);
            // recurse into real folders only; a symlinked folder could lead outside the project
            if (o.recursive === true && lstatSync(full).isDirectory()) {
                walk(full, r);
            }
        }
    };
    walk(at.file, at.rel);
    const base = realpathSync(root);
    const page = out.slice(start, start + PAGE_SIZE).flatMap((r) => {
        const x = inProject(root, r);
        return 'error' in x ? [] : [entry(base, x.file, r)];
    });
    const next =
        start + PAGE_SIZE < out.length ? Buffer.from(String(start + PAGE_SIZE)).toString('base64url') : undefined;
    return { entries: page, ...(next && { cursor: next }) };
};

export const read = (root: string, path: unknown, offset: unknown, length: unknown) => {
    const at = inProject(root, path);
    if ('error' in at) {
        return at;
    }
    const st = statSync(at.file);
    if (st.isDirectory()) {
        return fail('bad_request', 'path is a folder');
    }
    const off = offset === undefined ? 0 : Number(offset);
    const len = length === undefined ? READ_MAX : Number(length);
    if (!Number.isInteger(off) || off < 0 || !Number.isInteger(len) || len < 0 || len > READ_MAX) {
        return fail('bad_request', `offset must be a whole number ≥ 0 and length 0-${READ_MAX}`);
    }
    const rev = revision(at.file);
    const n = Math.max(0, Math.min(len, st.size - off));
    const buf = Buffer.alloc(n);
    if (n) {
        const fd = openSync(at.file, 'r');
        try {
            readSync(fd, buf, 0, n, off);
        } finally {
            closeSync(fd);
        }
    }
    if (revision(at.file) !== rev) {
        return fail('changed', 'the file changed while it was read; try again');
    }
    return { bytes: buf, size: st.size, revision: rev };
};

/** a file the viewer may save: the bytes stay out of the page; programs and scripts are refused */
export const downloadable = (root: string, path: unknown) => {
    const at = inProject(root, path);
    if ('error' in at) {
        return at;
    }
    const st = statSync(at.file);
    if (st.isDirectory()) {
        return fail('bad_request', 'path is a folder');
    }
    if (NO_DOWNLOAD.has(extname(at.file).toLowerCase())) {
        return fail('bad_request', `${extname(at.file)} files can't be saved from an artifact`);
    }
    if (st.size > DOWNLOAD_MAX) {
        return fail('too_large', 'the file is over 512 MiB');
    }
    return { file: at.file, rel: at.rel, size: st.size };
};
