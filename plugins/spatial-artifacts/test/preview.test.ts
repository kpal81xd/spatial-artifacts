import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'spatial-artifacts-preview-'));
process.env['SPATIAL_ARTIFACTS_DIR'] = HOME;
const { preview } = await import('../server/preview.ts');

const FIX = join(import.meta.dirname, 'fixtures');
const { assemble } = await import(
    pathToFileURL(join(import.meta.dirname, '..', 'skills', 'spatial-3d-design', 'scripts', 'new-scene.mjs')).href
);

after(() => {
    if (!process.env['KEEP_PREVIEWS']) {
        rmSync(HOME, { recursive: true, force: true });
    }
});

test('good page: four captures and no issues', async () => {
    const r = await preview(join(FIX, 'good.html'));
    assert.equal(r.isError, false, r.text);
    assert.match(
        r.text,
        /^Previewed good\.html \(\d+ kB as published\) at 1280\/390 px in light \+ dark: 4 of 4 captures, 0 issues found by the mechanical checks\./,
    );
    assert.match(r.text, /Nothing flagged; the checks cover only/);
    assert.match(r.text, /=== BEGIN PREVIEW REPORT ([0-9a-f]{8}) — [\s\S]*=== END PREVIEW REPORT \1 ===$/);
    assert.deepEqual(
        r.images.map((i) => i.label),
        ['Capture 1 (1280 light):', 'Capture 2 (390 light):', 'Capture 3 (1280 dark):', 'Capture 4 (390 dark):'],
    );
    for (const i of r.images) {
        assert.ok(i.base64.startsWith('/9j/'));
    }
    const paths = [...r.text.matchAll(/^\d\. .* — (\/.*\.jpg)$/gm)].map((m) => m[1]);
    assert.equal(paths.length, 4);
    for (const p of paths) {
        assert.ok(existsSync(p), p);
    }
});

test('broken page: console error, overflow, theme-only var and missing title', async () => {
    const r = await preview(join(FIX, 'bad.html'));
    assert.equal(r.images.length, 4, r.text);
    assert.match(
        r.text,
        /^- no <title>: the artifact's name will come from the `title` parameter, else from the file name$/m,
    );
    assert.match(
        r.text,
        /^- --accent gets a value only within @media \(prefers-color-scheme\) or \[data-theme\] rules, leaving it undefined in the opposite theme$/m,
    );
    assert.match(
        r.text,
        /^- 1280 light, 1280 dark: page scrolls horizontally \(2000px of content in a 1280px viewport\)$/m,
    );
    assert.match(r.text, /^- 1280 light, 1280 dark: content overflows section\.wrap \(720px wider than its box\)$/m);
    assert.match(r.text, /^- every render: 1 console error on load — boom from fixture$/m);
    assert.doesNotMatch(r.text, /Nothing flagged; the checks cover only/);
});

test('markdown page is refused', async () => {
    const r = await preview(join(FIX, 'page.md'));
    assert.deepEqual(r, {
        text: 'preview only draws hand-written .html pages; markdown gets its layout from the fixed document template when published, so there is no page here to render.',
        images: [],
        isError: true,
    });
});

test('missing file is refused', async () => {
    const f = join(FIX, 'nope.html');
    const r = await preview(f);
    assert.equal(r.text, `no file at ${f} — write the page first, then preview it.`);
    assert.equal(r.isError, true);
});

test('webgl2 is available in preview', async () => {
    const r = await preview(join(FIX, 'webgl.html'));
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /no webgl2 context/);
    assert.match(r.text, / 0 issues found by the mechanical checks\./);
});

test('3d scene: pinned engine, webgl2 and a valid scene preview cleanly', async () => {
    const f = join(HOME, 'plinth-study.html');
    writeFileSync(f, assemble({ title: 'Plinth Study' }));
    const r = await preview(f);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, / 0 issues found by the mechanical checks\./, r.text);
    assert.match(r.text, /^- note: preview has no artifact runtime, so window\.claude\.use\(\) returned null for db/m);
    assert.equal(r.images.length, 4);
});

test('3d scene: invalid scene-data is reported as a console error', async () => {
    const f = join(HOME, 'dup-id.html');
    writeFileSync(f, assemble().replace('"id": "sphere"', '"id": "vessel"'));
    const r = await preview(f);
    assert.match(
        r.text,
        /console error on load — scene-data \(study\): entities\[3\] \(vessel\): duplicate id "vessel"/,
    );
});

test('3d scene: three scenes side by side each render, with 0 issues', async () => {
    const f = join(HOME, 'three-maps.html');
    writeFileSync(f, assemble({ title: 'Map Designs', scenes: ['Grid', 'Radial', 'Organic'] }));
    const r = await preview(f);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, / 0 issues found by the mechanical checks\./, r.text);
    assert.equal(r.images.length, 4);
});
