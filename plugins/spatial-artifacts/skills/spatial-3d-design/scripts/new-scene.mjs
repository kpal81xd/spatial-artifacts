#!/usr/bin/env node
// scaffolds a 3d scene page from page.html; the artifact server serves the scene runtime it loads

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TEMPLATE = join(import.meta.dirname, '..', 'template');
const SAMPLE_TITLE = 'Scene Study';
const USAGE = 'usage: new-scene.mjs <out.html> [--title "Name"] [--scenes "A,B,C"] [--force]';
/** @type {Record<string, string>} */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** @param {string} f */
const read = (f) => readFileSync(join(TEMPLATE, f), 'utf8');
/** @param {string} s */
const esc = (s) => s.replace(/[&<>"]/g, (c) => ENTITIES[c]);

const SECTION = /<!-- scene:start -->\n([\s\S]*?)<!-- scene:end -->\n/;
// a scene's label; a page with one scene drops it, since its <h1> names it
const LABEL = /^ *<h2>.*<\/h2>\n/m;
const SAMPLE_KEY = 'study';
const SAMPLE_LABEL = 'Study';

/**
 * a scene key from its label: lowercase letters, digits and dashes, as entity ids allow
 * @param {string} label
 */
const slug = (label) =>
    label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);

/**
 * the assembled page; `title` replaces the sample's <title> and <h1>, `scenes` lays out one section per label.
 * a page with one scene names it by the title, so its labels and comment anchors read as the page
 * @param {{ title?: string | undefined; scenes?: string[] | undefined }} [opts]
 */
export const assemble = ({ title, scenes } = {}) => {
    const labels = scenes ?? [title ?? SAMPLE_LABEL];
    const page = read('page.html');
    const body = (SECTION.exec(page) ?? [])[1];
    const section = labels.length === 1 ? body.replace(LABEL, '') : body;
    const keys = new Set();
    const sections = labels.map((label) => {
        const key = slug(label) || (scenes ? '' : SAMPLE_KEY);
        if (!key) {
            throw new Error(`scene "${label}" has no letters or digits to name it by`);
        }
        if (keys.has(key)) {
            throw new Error(`duplicate scene "${key}"`);
        }
        keys.add(key);
        const l = esc(label);
        return section.replaceAll(SAMPLE_KEY, () => key).replaceAll(SAMPLE_LABEL, () => l);
    });
    const html = page.replace(SECTION, () => sections.join(''));
    if (!title) {
        return html;
    }
    const t = esc(title);
    return html
        .replace(`<title>${SAMPLE_TITLE}</title>`, () => `<title>${t}</title>`)
        .replace(`<h1>${SAMPLE_TITLE}</h1>`, () => `<h1>${t}</h1>`);
};

/** @param {string[]} args */
const cli = (args) => {
    const { values, positionals } = parseArgs({
        args,
        options: { title: { type: 'string' }, scenes: { type: 'string' }, force: { type: 'boolean' } },
        allowPositionals: true,
    });
    const [out] = positionals;
    if (!out) {
        console.error(USAGE);
        process.exit(2);
    }
    if (existsSync(out) && !values.force) {
        console.error(`${out} already exists; pass --force to overwrite it`);
        process.exit(1);
    }
    const scenes = values.scenes
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    writeFileSync(out, assemble({ title: values.title, scenes: scenes?.length ? scenes : undefined }));
    console.log(`wrote ${resolve(out)}`);
};

// argv[1] keeps a symlinked path (.claude/skills/...); import.meta.url is the real one
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    cli(process.argv.slice(2));
}
