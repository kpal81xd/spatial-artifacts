import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const SKILL = join(import.meta.dirname, '..', 'plugins', 'spatial-artifacts', 'skills', 'spatial-3d-design');
const core = await import(pathToFileURL(join(SKILL, 'template', 'scene-core.mjs')).href);

const doc = (entities: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        v: 1,
        materials: { m: { diffuse: [1, 1, 1] } },
        models: { lamp: 'models/lamp.glb' },
        entities,
        ...extra,
    });
const ok = (entities: unknown[]) => {
    const [errs, s] = core.parseScene(doc(entities));
    assert.deepEqual(errs, []);
    return s;
};

describe('parseScene', () => {
    test('fills defaults and builds paths', () => {
        const s = ok([
            { id: 'desk', name: 'Desk', primitive: 'box', material: 'm' },
            { id: 'lamp', name: 'Lamp', parent: 'desk', model: 'lamp', pos: [1, 0, 0] },
        ]);
        assert.deepEqual(s.entities[0].scale, [1, 1, 1]);
        assert.deepEqual(s.entities[1].rot, [0, 0, 0]);
        assert.deepEqual(s.camera, { pos: [3, 2, 3], target: [0, 0.5, 0], fov: 45 });
        assert.deepEqual(s.environment, {
            clear: [0.12, 0.12, 0.13],
            ambient: [0.2, 0.2, 0.2],
            exposure: 1,
            toneMapping: 'aces',
        });
        assert.deepEqual(s.materials.m, { diffuse: [1, 1, 1], gloss: 0.5, metalness: 0 });
        assert.equal(core.entityPath(s, 'lamp'), '/Desk/Lamp');
    });

    test('rejects bad json and a wrong version', () => {
        assert.match(core.parseScene('{').at(0)[0], /^scene-data is not valid JSON: /);
        assert.deepEqual(core.parseScene('{"v":2,"entities":[]}'), [['scene-data "v" must be 1'], null]);
        assert.deepEqual(core.parseScene('{"v":1}'), [['scene-data "entities" must be an array'], null]);
    });

    test('reports every entity problem by index and id', () => {
        const [errs, s] = core.parseScene(
            doc([
                { id: 'a', name: 'A' },
                { id: 'a', name: 'A again' },
                { id: 'bad id', name: 'B' },
                { id: 'c', name: 'C/D', parent: 'later' },
                { id: 'later', name: 'L', pos: [0, null, 0] },
                { id: 'e', name: 'E', primitive: 'box', light: { type: 'omni' } },
                { id: 'f', name: 'F', primitive: 'torus', material: 'nope' },
                { id: 'g', name: 'G', model: 'nope' },
                { id: 'h', name: 'H', light: { type: 'area' } },
            ]),
        );
        assert.equal(s, null);
        assert.deepEqual(errs, [
            'entities[1] (a): duplicate id "a"',
            'entities[2] (bad id): "id" must match /^[A-Za-z0-9_-]{1,64}$/',
            'entities[3] (c): "name" must be 1-128 characters without "/"',
            'entities[3] (c): parent "later" must be an earlier entity\'s id',
            'entities[4] (later): "pos" must be three finite numbers',
            'entities[5] (e): has primitive and light; use at most one',
            'entities[6] (f): primitive must be one of box, sphere, cylinder, cone, capsule, plane',
            'entities[6] (f): material "nope" is not a key of "materials"',
            'entities[7] (g): model "nope" is not a key of "models"',
            'entities[8] (h): light type must be one of directional, omni, spot',
        ]);
    });

    test('checks camera, environment and materials', () => {
        const [errs] = core.parseScene(
            doc([], {
                camera: { pos: [0, 0], fov: 400 },
                environment: { clear: 'red', toneMapping: 'filmic', exposure: -1 },
                materials: { m: { diffuse: 'token:--wood', gloss: 2 } },
            }),
        );
        assert.deepEqual(errs, [
            'camera "pos" and "target" must be three finite numbers',
            'camera "fov" must be between 5 and 120',
            'environment "clear" and "ambient" must be RGB arrays or "token:--name"',
            'environment "exposure" must be a positive number',
            'environment "toneMapping" must be one of linear, aces, neutral',
            'materials.m: "gloss" and "metalness" must be between 0 and 1',
        ]);
    });
});

describe('overrides', () => {
    const s = ok([{ id: 'box', name: 'Box', primitive: 'box', pos: [0, 1, 0] }]);
    const base = { pos: [0, 1, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
    const moved = { pos: [0.123456, 1, 0], rot: [0, 0, 0], scale: [1, 1, 1] };

    test('validOverride accepts only three finite vectors', () => {
        assert.deepEqual(core.validOverride({ ...moved, path: '/Box' }), moved);
        for (const bad of [
            null,
            undefined,
            'x',
            {},
            { ...moved, pos: 'x' },
            { ...moved, scale: [1, 1] },
            { ...moved, rot: [0, null, 0] },
        ]) {
            assert.equal(core.validOverride(bad), null);
        }
    });

    test('editWrites sets moved entities, rounded, with their path', () => {
        assert.deepEqual(core.editWrites([{ id: 'box', to: moved }], s, new Set(), 'city'), [
            {
                op: 'set',
                path: 'edits/city:box',
                data: { pos: [0.1235, 1, 0], rot: [0, 0, 0], scale: [1, 1, 1], path: '/Box', scene: 'city' },
            },
        ]);
    });

    test('editWrites deletes an existing doc on return to base and skips a missing one', () => {
        assert.deepEqual(core.editWrites([{ id: 'box', to: base }], s, new Set(['box']), 'city'), [
            { op: 'delete', path: 'edits/city:box' },
        ]);
        assert.deepEqual(core.editWrites([{ id: 'box', to: base }], s, new Set(), 'city'), []);
        assert.deepEqual(core.editWrites([{ id: 'gone', to: moved }], s, new Set(), 'city'), []);
    });

    test('sameTransform compares rotations as orientations, not euler triples', () => {
        const at = (rot: number[]) => ({ ...base, rot });
        assert.equal(core.sameTransform(at([0, 180, 0]), at([180, 0, 180])), true);
        assert.equal(core.sameTransform(at([0, 120, 0]), at([180, 60, 180])), true);
        assert.equal(core.sameTransform(at([0, 0, 200]), at([0, 0, -160])), true);
        assert.equal(core.sameTransform(at([0, 90, 0]), at([0, 0, 0])), false);
        assert.equal(core.sameTransform(at([0, 0, 0]), at([0, 1, 0])), false);
    });

    test('undo to a yawed base deletes the doc even when the engine reports another euler form', () => {
        const [, yawed] = core.parseScene(doc([{ id: 'chair', name: 'Chair', primitive: 'box', rot: [0, 180, 0] }]));
        assert.deepEqual(
            core.editWrites(
                [{ id: 'chair', to: { pos: [0, 0, 0], rot: [180, 0, 180], scale: [1, 1, 1] } }],
                yawed,
                new Set(['chair']),
                'room',
            ),
            [{ op: 'delete', path: 'edits/room:chair' }],
        );
    });

    test('sameTransform tolerates rounding noise only', () => {
        assert.equal(core.sameTransform(base, { ...base, pos: [0, 1.00005, 0] }), true);
        assert.equal(core.sameTransform(base, { ...base, pos: [0, 1.001, 0] }), false);
    });
});

describe('pickTarget', () => {
    const s = ok([
        { id: 'floor', name: 'Floor', primitive: 'plane', locked: true },
        { id: 'ramp', name: 'Ramp', primitive: 'box' },
        { id: 'deck', name: 'Deck', parent: 'ramp', primitive: 'box', locked: true },
        { id: 'coping', name: 'Coping', parent: 'deck', primitive: 'cylinder', locked: true },
        { id: 'rail', name: 'Rail', parent: 'ramp', primitive: 'box' },
    ]);

    test('a locked part passes the click to its nearest unlocked ancestor', () => {
        assert.equal(core.pickTarget(s, 'coping'), 'ramp');
        assert.equal(core.pickTarget(s, 'deck'), 'ramp');
        assert.equal(core.pickTarget(s, 'rail'), 'rail');
        assert.equal(core.pickTarget(s, 'floor'), 'floor');
    });

    test('comments anchor to the part itself, locked or not', () => {
        assert.equal(core.pickTarget(s, 'coping', true), 'coping');
        assert.equal(core.pickTarget(s, 'floor', true), 'floor');
    });
});

describe('scene keys', () => {
    test('doc ids namespace entities by scene and round-trip', () => {
        assert.equal(core.docId('grid', 'road-1'), 'grid:road-1');
        assert.equal(core.entityOf('grid', 'grid:road-1'), 'road-1');
        assert.equal(core.entityOf('grid', 'radial:road-1'), null);
    });
});

describe('history', () => {
    const t = (x: number) => ({ pos: [x, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] });

    test('undo and redo walk ops; a new push drops the redo branch', () => {
        const h = core.createHistory();
        h.push([{ id: 'a', before: t(0), after: t(1) }]);
        h.push([{ id: 'a', before: t(1), after: t(2) }]);
        assert.deepEqual(h.undo(), [{ id: 'a', to: t(1) }]);
        assert.deepEqual(h.undo(), [{ id: 'a', to: t(0) }]);
        assert.equal(h.undo(), null);
        assert.deepEqual(h.redo(), [{ id: 'a', to: t(1) }]);
        h.push([{ id: 'a', before: t(1), after: t(5) }]);
        assert.equal(h.redo(), null);
    });

    test('keeps at most `limit` ops', () => {
        const h = core.createHistory(2);
        for (const x of [1, 2, 3]) {
            h.push([{ id: 'a', before: t(x - 1), after: t(x) }]);
        }
        assert.ok(h.undo());
        assert.ok(h.undo());
        assert.equal(h.undo(), null);
    });
});

describe('saved view', () => {
    const camera = { pos: [3, 2, 3], target: [0, 0.5, 0], fov: 45 };
    const saved = { pos: [1, 1, 1], target: [0, 0, 0], from: JSON.stringify(camera) };

    test('keeps the saved pose while the authored camera is unchanged', () => {
        assert.deepEqual(core.viewFor(saved, camera), saved);
    });

    test('drops the saved pose when Claude changed the camera, or when it is malformed', () => {
        assert.deepEqual(core.viewFor(saved, { ...camera, pos: [0, 6, 0] }), { ...camera, pos: [0, 6, 0] });
        for (const bad of [null, 'x', { ...saved, pos: [1, 1] }, { pos: [1, 1, 1], target: [0, 0, 0] }]) {
            assert.deepEqual(core.viewFor(bad, camera), camera);
        }
    });
});

describe('anchors and colours', () => {
    test('anchorAttrs formats path and point for the canvas', () => {
        assert.deepEqual(core.anchorAttrs(null, null), { entity: '', point: '' });
        assert.deepEqual(core.anchorAttrs('/Desk/Lamp', [1.234, -0.456, 2]), {
            entity: '/Desk/Lamp',
            point: '1.23,-0.46,2',
        });
    });

    test('parseColor reads hex and rgb, rejects the rest', () => {
        assert.deepEqual(core.parseColor('#fff'), [1, 1, 1]);
        assert.deepEqual(core.parseColor(' #ff0033 '), [1, 0, 0.2]);
        assert.deepEqual(core.parseColor('rgb(255, 0, 51)'), [1, 0, 0.2]);
        assert.deepEqual(core.parseColor('rgba(255 255 255 / 50%)'), [1, 1, 1]);
        assert.equal(core.parseColor('oklch(0.7 0.1 150)'), null);
        assert.equal(core.parseColor(''), null);
    });
});

describe('new-scene', () => {
    const SCRIPT = join(SKILL, 'scripts', 'new-scene.mjs');
    test('loads the served runtime under the pinned engine, and names a single scene by its title', async () => {
        const { assemble } = await import(pathToFileURL(SCRIPT).href);
        const html = assemble();
        assert.equal(
            html.match(/<script type="module" src="\/_frame\/scene\/scene-runtime\.mjs"><\/script>/g)?.length,
            1,
        );
        assert.doesNotMatch(html, /const parseScene =/);
        assert.ok(
            html.includes('"playcanvas":"https://cdn.jsdelivr.net/npm/playcanvas@2.22.5/build/playcanvas.min.mjs"'),
        );
        assert.ok(
            html.includes(
                '"https://cdn.jsdelivr.net/npm/playcanvas@2.22.5/build/playcanvas.min.mjs":"sha384-taKFZkoi0MnbpX25w5jlEe4Kv4+DNMsEybkkBegCSD3k7K4/tqfoxBcKVK9pgi8f"',
            ),
        );
        assert.ok(
            html.includes(
                '"https://cdn.jsdelivr.net/npm/playcanvas@2.22.5/scripts/esm/camera-controls.mjs":"sha384-mwdf62dEa/NFlVc9OvBgOrV/mObR9yRmvDTmB41Cd8YcU+OBC/p2L0DlL4OlkrjK"',
            ),
        );
        assert.match(html, /<canvas data-scene="study" data-entity="" data-point=""/);

        // one scene: the <h1> names it, so no scene label
        assert.doesNotMatch(html, /<h2>/);
        const [errs] = core.parseScene(
            (/<script type="application\/json" class="scene-data">([\s\S]*?)<\/script>/.exec(html) ?? [])[1],
        );
        assert.deepEqual(errs, []);

        // and with a title, its labels and comment anchors read as the page, not the sample
        const lamp = assemble({ title: 'Desk Lamp' });
        assert.match(lamp, /<canvas data-scene="desk-lamp"/);
        assert.match(lamp, /aria-label="Desk Lamp tools"/);
        assert.doesNotMatch(lamp, /Study/);

        // the served modules parse on their own
        for (const f of ['scene-core.mjs', 'scene-runtime.mjs']) {
            const check = spawnSync(process.execPath, ['--check', join(SKILL, 'template', f)], { encoding: 'utf8' });
            assert.equal(check.status, 0, check.stderr);
        }
    });

    test('title is escaped and literal in <title> and <h1>', async () => {
        const { assemble } = await import(pathToFileURL(SCRIPT).href);
        const html = assemble({ title: 'R&D <Lab> $&' });
        assert.ok(html.startsWith('<title>R&amp;D &lt;Lab&gt; $&amp;</title>'));
        assert.ok(html.includes('<h1>R&amp;D &lt;Lab&gt; $&amp;</h1>'));
        assert.ok(!html.includes('Scene Study'));
    });

    test('--scenes lays out one independent scene per name, sharing one engine and runtime', async () => {
        const { assemble } = await import(pathToFileURL(SCRIPT).href);
        const html = assemble({ title: 'Map Designs', scenes: ['Grid city', 'Radial', 'Organic & old'] });
        assert.deepEqual(
            [...html.matchAll(/<canvas data-scene="([^"]+)" data-entity=""/g)].map((m) => m[1]),
            ['grid-city', 'radial', 'organic-old'],
        );
        assert.deepEqual(
            [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]),
            ['Grid city', 'Radial', 'Organic &amp; old'],
        );

        // labels sit above each viewport, not over it
        assert.equal(html.match(/<section class="scene"[^>]*>\s*<h2>/g)?.length, 3);
        assert.equal(html.match(/<script type="application\/json" class="scene-data">/g)?.length, 3);
        assert.equal(html.match(/src="\/_frame\/scene\/scene-runtime\.mjs"/g)?.length, 1);
        assert.equal(html.match(/type="importmap"/g)?.length, 1);

        // each scene has its own fullscreen button, outside the edit toolbar so read-only scenes have it too
        assert.equal(html.match(/<div class="tools corner"[^>]*><button[^>]*data-action="fullscreen"/g)?.length, 3);
        assert.ok(readFileSync(join(SKILL, 'template', 'scene-runtime.mjs'), 'utf8').includes("'claude:fullscreen'"));
        const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
        assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
        assert.throws(() => assemble({ scenes: ['Same', 'same'] }), /duplicate scene "same"/);
        assert.throws(() => assemble({ scenes: ['!!!'] }), /no letters or digits/);
    });

    test('cli writes a page and refuses to overwrite without --force', () => {
        const out = join(mkdtempSync(join(tmpdir(), 'scene3d-')), 'desk.html');
        const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
        assert.equal(run().status, 2);
        const first = run(out, '--title', 'Desk Study', '--scenes', 'A,B');
        assert.equal(first.status, 0, first.stderr);
        assert.ok(existsSync(out));
        const again = run(out);
        assert.equal(again.status, 1);
        assert.match(again.stderr, /already exists; pass --force to overwrite it/);
        assert.equal(run(out, '--force').status, 0);
    });

    test('cli runs through a symlinked skill directory', () => {
        const dir = mkdtempSync(join(tmpdir(), 'scene3d-'));
        symlinkSync(SKILL, join(dir, 'skill'));
        const out = join(dir, 'linked.html');
        const r = spawnSync(process.execPath, [join(dir, 'skill', 'scripts', 'new-scene.mjs'), out], {
            encoding: 'utf8',
        });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(out));
    });
});
