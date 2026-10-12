import {
    Application,
    Asset,
    BoundingBox,
    Color,
    drawQuadWithShader,
    Entity,
    FILLMODE_NONE,
    GAMMA_SRGB,
    Gizmo,
    Layer,
    Mat4,
    OutlineRenderer,
    Picker,
    Ray,
    RESOLUTION_AUTO,
    RotateGizmo,
    ScaleGizmo,
    StandardMaterial,
    TONEMAP_ACES,
    TONEMAP_LINEAR,
    TONEMAP_NEUTRAL,
    TranslateGizmo,
    Vec2,
    Vec3,
} from 'playcanvas';
import { CameraControls } from 'playcanvas/camera-controls';

import {
    anchorAttrs,
    createHistory,
    docId,
    EDITS,
    editWrites,
    entityOf,
    entityPath,
    ID_RE,
    MAX_SELECTION,
    parseColor,
    parseScene,
    pickTarget,
    round,
    sameTransform,
    transformOf,
    validOverride,
    viewFor,
} from './scene-core.mjs';

// picking renders at full canvas size, and a miss retries within PICK_SLOP px so thin rails and legs still pick
const PICK_SLOP = 4;
const CLICK_SLOP = 4;
const MAX_PIXEL_RATIO = 2;
const SNAP = { translate: 0.1, rotate: 15, scale: 0.1 };
const TOOL_KEYS = { 1: 'translate', 2: 'rotate', 3: 'scale' };
// the fly keys, released for the engine when the window loses focus (it would keep flying on a key held then)
const FLY_CODES = [
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'KeyQ',
    'KeyE',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
];
const TONE = { linear: TONEMAP_LINEAR, aces: TONEMAP_ACES, neutral: TONEMAP_NEUTRAL };
const VIEW_KEY = 'scene-view';
// the scene shown full screen, kept across a reload onto a new version
const FULL_KEY = 'scene-fullscreen';
const SELECT_COLOR = new Color(1, 1, 1);
// the selection box where the floor or another object hides it, as in the editor
const SELECT_BEHIND_COLOR = new Color(1, 1, 1, 0.2);

// comment hover and focus outlines take the viewer's comment orange (#c96442), as on 2d pages; the outline
// pass shows colours a gamma step darker (a muddy brown), so the orange is gamma-encoded first
const COMMENT_COLOR = new Color(...[201, 100, 66].map((v) => (v / 255) ** (1 / 2.2)));
// css px the outline edge reaches each side of a silhouette
const OUTLINE_REACH = 1;
// css px wide the selection box edges draw (webgl lines are one device px, so each edge draws twice per device px)
const SELECT_BOX_PX = 1.5;
// the box draws only its corners, as in the editor: this fraction of each edge from either end
const SELECT_BOX_CORNER = 0.15;
// a box's 12 edges, as pairs of corner indices whose bits pick max x, y and z
const BOX_EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
];
const FALLBACK_RGB = [0.5, 0.5, 0.5];
const MIN_SHADOW_DISTANCE = 16;
// the viewer quotes at most this many objects inside a drawn comment area; past it, those covering most of it
const MAX_AREA_OBJECTS = 16;
const SHADOW_BIAS = 0.05;

// a parent scaled unevenly by more than this skews a rotated or scaled child
const SKEW_EPS = 1e-4;

// fly speed per second as a fraction of the scene's diagonal (the script's 10 m/s crosses a desk in a blink), clamped in m/s
const FLY_SCENE_FRACTION = 0.25;
const FLY_SPEED = { min: 0.3, max: 20 };

// a drawn comment area is captured for Claude at most this many px on its long side, as webp (jpeg where unsupported)
const AREA_IMAGE_PX = 800;
const AREA_IMAGE_QUALITY = 0.85;
// a republish hands the next version a still of each scene's last frame, at most this many px on its long side
const STILL_PX = 1600;
const STILL_QUALITY = 0.82;
// the still covers the new version until its models are in, and never longer than this
const STILL_MAX_MS = 15000;

// a clicked object's capture reaches this far past its screen box: a fraction of its long side, at least OBJECT_IMAGE_PAD_PX
const OBJECT_IMAGE_PAD = 0.25;
const OBJECT_IMAGE_PAD_PX = 48;

const attempt = (f) => {
    try {
        return [null, f()];
    } catch (e) {
        return [e];
    }
};
const settle = (p) =>
    p.then(
        (v) => [null, v],
        (e) => [e],
    );
const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// any css colour (hsl, oklch, named, 8-digit hex) resolves to srgb by painting one pixel
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
const cssRgb = (css) => {
    if (!probe || !CSS.supports('color', css)) {
        return null;
    }
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255];
};

/** a scene colour: an rgb array, or `token:--name` read on the scene's own element, so each scene can retune it */
const toColor = (v, el = document.documentElement) => {
    const css = typeof v === 'string' ? getComputedStyle(el).getPropertyValue(v.slice(6)).trim() : '';
    const rgb = typeof v === 'string' ? (parseColor(css) ?? cssRgb(css)) : v;
    if (!rgb) {
        console.warn(`scene colour ${v} is not a css colour; using grey`);
    }
    return new Color(...(rgb ?? FALLBACK_RGB));
};

const place = (e, t) => {
    e.setLocalPosition(...t.pos);
    e.setLocalEulerAngles(...t.rot);
    e.setLocalScale(...t.scale);
};

const read = (e) => {
    const [p, r, s] = [e.getLocalPosition(), e.getLocalEulerAngles(), e.getLocalScale()];
    return { pos: round([p.x, p.y, p.z]), rot: round([r.x, r.y, r.z]), scale: round([s.x, s.y, s.z]) };
};

const loadView = (key) => {
    const [, raw] = attempt(() => sessionStorage.getItem(`${VIEW_KEY}:${key}`));
    return attempt(() => JSON.parse(raw))[1] ?? null;
};

/** one scene: its canvas, the .scene-data and toolbar in its .scene section; returns its key handlers */
const mount = async (canvas, db, activate, isActive) => {
    const key = canvas.dataset.scene;
    const root = canvas.closest('.scene') ?? document.body;
    const q = (sel) => root.querySelector(sel);
    const ui = {
        tools: q('.hud .tools'),
        selection: q('.scene-selection'),
        status: q('.scene-status'),
        space: q('[data-action="space"]'),
        snap: q('[data-action="snap"]'),
        undo: q('[data-action="undo"]'),
        redo: q('[data-action="redo"]'),
    };
    let sayTimer = 0;
    const say = (text, ms = 0) => {
        if (!ui.status) {
            return;
        }
        clearTimeout(sayTimer);
        ui.status.textContent = text;
        if (ms) {
            sayTimer = setTimeout(() => (ui.status.textContent = ''), ms);
        }
    };
    const dataEl = q('.scene-data');
    if (!dataEl) {
        return console.error(`scene-data (${key}): no .scene-data JSON block in its .scene section`);
    }
    const [errs, scene] = parseScene(dataEl.textContent);
    if (errs.length) {
        for (const e of errs) {
            console.error(`scene-data (${key}): ${e}`);
        }
        return say('This scene has errors');
    }
    const [ae, app] = attempt(
        () => new Application(canvas, { graphicsDeviceOptions: { antialias: true, alpha: false } }),
    );
    if (ae || !app.graphicsDevice) {
        console.error(`3D isn't available in this browser (${key}): ${ae?.message ?? 'no graphics device'}`);
        return say("3D isn't available in this browser");
    }
    app.setCanvasFillMode(FILLMODE_NONE);
    app.setCanvasResolution(RESOLUTION_AUTO);
    // the engine takes the lower of this and the live device ratio, so moving to another screen only needs a refit
    app.graphicsDevice.maxPixelRatio = MAX_PIXEL_RATIO;
    const ratio = () => Math.min(devicePixelRatio, MAX_PIXEL_RATIO);

    // each scene sizes to its own box in the page layout, and again when the window moves to a screen of another density
    const box = canvas.parentElement;
    const fit = () => app.resizeCanvas(box.clientWidth, box.clientHeight);
    new ResizeObserver(fit).observe(box);
    const density = () =>
        matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
            'change',
            () => {
                fit();
                density();
            },
            { once: true },
        );
    density();
    fit();

    // a lost context (a gpu reset, or too many pages with 3d open) leaves a blank canvas; say so instead
    app.graphicsDevice.on('devicelost', () => say('The 3D view lost its graphics context; reload the page'));
    app.graphicsDevice.on('devicerestored', () => say(''));

    // only a scene on screen draws: one scrolled away, or under another scene taken full screen, waits
    let onScreen = true;
    const drawWhenShown = () => {
        const covered = document.documentElement.hasAttribute('data-fullscreen') && !root.hasAttribute('data-max');
        app.autoRender = onScreen && !covered;
        app.renderNextFrame = app.autoRender;
    };
    new IntersectionObserver(([e]) => {
        onScreen = e.isIntersecting;
        drawWhenShown();
    }).observe(canvas);
    document.addEventListener('claude:fullscreen-change', drawWhenShown);

    // the viewer takes its frame full screen (so its comment box stays) and marks the page root; this scene then fills it
    const fs = q('[data-action="fullscreen"]');
    const full = () => root.hasAttribute('data-max') && document.documentElement.hasAttribute('data-fullscreen');
    const syncFull = () => {
        const on = full();
        fs.setAttribute('aria-pressed', String(on));
        fs.ariaLabel = on ? 'Exit full screen' : 'Full screen';
    };
    if (fs) {
        if (attempt(() => sessionStorage.getItem(FULL_KEY))[1] === key) {
            root.setAttribute('data-max', '');
        }
        fs.addEventListener('click', () => {
            const on = !full();
            for (const s of document.querySelectorAll('.scene[data-max]')) {
                s.removeAttribute('data-max');
            }
            if (on) {
                root.setAttribute('data-max', '');
            }
            attempt(() => (on ? sessionStorage.setItem(FULL_KEY, key) : sessionStorage.removeItem(FULL_KEY)));
            document.dispatchEvent(new CustomEvent('claude:fullscreen', { detail: { on } }));
        });
        document.addEventListener('claude:fullscreen-change', syncFull);
        syncFull();
    }

    const env = scene.environment;
    app.scene.exposure = env.exposure;

    // colours given as tokens follow the theme: each records how to set itself again
    const themed = [];
    const paintWith = (v, set) => {
        set(toColor(v, root));
        if (typeof v === 'string') {
            themed.push(() => set(toColor(v, root)));
        }
    };
    const mats = new Map(
        Object.entries(scene.materials).map(([k, m]) => {
            const mat = new StandardMaterial();
            mat.useMetalness = true;
            mat.metalness = m.metalness;
            mat.gloss = m.gloss;
            paintWith(m.diffuse, (c) => {
                mat.diffuse = c;
                mat.update();
            });
            if (m.emissive) {
                paintWith(m.emissive, (c) => {
                    mat.emissive = c;
                    mat.update();
                });
            }
            return [k, mat];
        }),
    );

    // scene entities, parents first (parseScene guarantees the order)
    const nodes = new Map();
    for (const d of scene.entities) {
        const e = new Entity(d.name);
        e.sceneId = d.id;
        if (d.primitive) {
            e.addComponent('render', {
                type: d.primitive,
                material: mats.get(d.material),
                castShadows: !!d.shadows,
                receiveShadows: true,
            });
        }
        if (d.light) {
            e.addComponent('light', {
                type: d.light.type,
                intensity: d.light.intensity ?? 1,
                castShadows: !!d.light.shadows,
                shadowResolution: 2048,
                shadowDistance: MIN_SHADOW_DISTANCE,
                normalOffsetBias: SHADOW_BIAS,
                range: d.light.range ?? 10,
                innerConeAngle: d.light.inner ?? 30,
                outerConeAngle: d.light.outer ?? 45,
            });
        }
        if (d.light) {
            paintWith(d.light.color ?? [1, 1, 1], (c) => (e.light.color = c));
        }
        (d.parent ? nodes.get(d.parent) : app.root).addChild(e);
        nodes.set(d.id, e);
        place(e, transformOf(d));
    }

    const cam = new Entity('camera');
    cam.addComponent('camera', {
        fov: scene.camera.fov,
        nearClip: 0.05,
        farClip: 500,
        toneMapping: TONE[env.toneMapping],
        gammaCorrection: GAMMA_SRGB,
    });
    cam.addComponent('script');
    app.root.addChild(cam);
    const applyTheme = () => {
        cam.camera.clearColor = toColor(env.clear, root);
        app.scene.ambientLight = toColor(env.ambient, root);
        for (const f of themed) {
            f();
        }
    };
    applyTheme();

    // directional shadows end shadowDistance from the camera; reach past the farthest caster (and its shadow)
    const suns = scene.entities
        .filter((d) => d.light?.type === 'directional' && d.light.shadows)
        .map((d) => nodes.get(d.id).light);
    const casters = new BoundingBox();
    if (suns.length) {
        app.on('update', () => {
            let empty = true;
            for (const r of app.root.findComponents('render')) {
                if (r.castShadows) {
                    for (const mi of r.meshInstances) {
                        if (empty) {
                            casters.copy(mi.aabb);
                        } else {
                            casters.add(mi.aabb);
                        }
                        empty = false;
                    }
                }
            }
            if (empty) {
                return;
            }
            const reach = cam.getPosition().distance(casters.center) + casters.halfExtents.length() * 2;
            const dist = Math.min(Math.max(reach, MIN_SHADOW_DISTANCE), cam.camera.farClip);

            // a longer reach spreads the same shadow map over more metres, so the bias grows with it
            for (const l of suns) {
                Object.assign(l, {
                    shadowDistance: dist,
                    normalOffsetBias: (SHADOW_BIAS * dist) / MIN_SHADOW_DISTANCE,
                });
            }
        });
    }
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    new MutationObserver(applyTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    });

    // a pose saved under an older authored camera would hide Claude's camera change
    const from = JSON.stringify(scene.camera);
    const view = viewFor(loadView(key), scene.camera);
    cam.setPosition(...view.pos);
    cam.lookAt(...view.target);
    const cc = cam.script.create(CameraControls);

    // as the camera-controls script: W/A/S/D/Q/E fly (Shift faster, Ctrl slower) and the right button looks around;
    // the engine hears keys on the whole window, so only the active scene flies, and not while a field has focus
    app.on('update', () => {
        const fly = isActive() && !typing(document.activeElement);
        if (cc.enableFly !== fly) {
            cc.enableFly = fly;
        }
    });
    cc.pitchRange = new Vec2(-89.9, 89.9);
    cc.reset(new Vec3(...view.target), new Vec3(...view.pos));
    let lastView = '';
    setInterval(() => {
        const [p, f] = [cam.getPosition(), cc.focusPoint];
        const s = JSON.stringify({ pos: round([p.x, p.y, p.z], 3), target: round([f.x, f.y, f.z], 3), from });
        if (s !== lastView) {
            attempt(() => sessionStorage.setItem(`${VIEW_KEY}:${key}`, (lastView = s)));
        }
    }, 1000);

    // viewer edits live in db, as edits/<scene>:<entity>, and override the scene json
    const col = db?.collection(EDITS);
    const editable = !!col;
    let existing = new Set();
    let dragging = new Set();
    const pending = new Map();
    const docsOf = (r) =>
        new Map(
            r.docs.flatMap((d) => {
                const id = entityOf(key, d.id);
                return id ? [[id, d.data()]] : [];
            }),
        );

    // a collection read keeps the runtime's version pin of a deleted doc; a doc read resets it
    const repin = (ids) => Promise.all(ids.map((id) => settle(col.doc(docId(key, id)).get())));
    const sync = (docs) => {
        const gone = [...existing].filter((id) => !docs.has(id));
        existing = new Set(docs.keys());
        if (gone.length) {
            repin(gone);
        }
        for (const d of scene.entities) {
            if (dragging.has(d.id) || pending.get(d.id)) {
                continue;
            }
            place(nodes.get(d.id), validOverride(docs.get(d.id)) ?? transformOf(d));
        }
    };
    if (col) {
        const [ge, r] = await settle(col.get());
        if (ge) {
            console.error(`scene edits (${key}) could not be read: ${ge.message}`);
        } else {
            sync(docsOf(r));
        }
        col.onSnapshot(
            (r) => sync(docsOf(r)),
            (err) => console.error(`scene edits (${key}) stopped syncing: ${err.message}`),
        );
    }

    app.start();
    app.once('frameend', () => {
        root.dataset.sceneReady = '';
        say('');
        console.info('scene ready', {
            scene: key,
            entities: scene.entities.length,
            device: app.graphicsDevice.deviceType,
            editable,
        });
    });

    const containers = new Map();
    const container = (url) => {
        if (!containers.has(url)) {
            containers.set(
                url,
                new Promise((ok) => {
                    const a = new Asset(url, 'container', { url });
                    a.once('load', () => ok(a));
                    a.once('error', (err) => {
                        console.warn(`model ${url} did not load: ${err}`);
                        ok(null);
                    });
                    app.assets.add(a);
                    app.assets.load(a);
                }),
            );
        }
        return containers.get(url);
    };
    const loads = [];
    for (const d of scene.entities) {
        if (d.model) {
            const load = container(scene.models[d.model]).then(
                (a) =>
                    a &&
                    nodes
                        .get(d.id)
                        .addChild(
                            a.resource.instantiateRenderEntity({ castShadows: !!d.shadows, receiveShadows: true }),
                        ),
            );
            loads.push(load);
        }
    }
    const lift = stills.get(key);
    if (lift) {
        Promise.all(loads).then(() => app.once('frameend', () => app.once('frameend', lift)));
    }

    // picking: gpu for hover, cpu ray vs aabb where there is no hover (touch, pen); both return the part hit
    const targets = new Map(scene.entities.map((d) => [d.id, pickTarget(scene, d.id)]));
    const owner = (node) => {
        let n = node;
        while (n && !n.sceneId) {
            n = n.parent;
        }
        return n ?? null;
    };

    // the object a part belongs to: its nearest unlocked ancestor, so a compound object moves as one
    const objectOf = (part) => part && (nodes.get(targets.get(part.sceneId)) ?? part);

    // a double-click drills into an object, so clicks inside it pick its parts; a click elsewhere or Esc leaves
    let scope = null;
    const level = (part) => (part && scope && objectOf(part) === scope ? part : objectOf(part));
    const picker = new Picker(app, 1, 1, true);
    const world = [app.scene.layers.getLayerByName('World')];
    const prepare = () => {
        picker.resize(Math.max(1, canvas.clientWidth | 0), Math.max(1, canvas.clientHeight | 0));
        picker.prepare(cam.camera, app.scene, world);
    };
    const gpuPick = async (x, y) => {
        prepare();
        let [mi] = await picker.getSelectionAsync(x, y);
        if (!mi) {
            [mi] = await picker.getSelectionAsync(
                Math.max(0, x - PICK_SLOP),
                Math.max(0, y - PICK_SLOP),
                PICK_SLOP * 2 + 1,
                PICK_SLOP * 2 + 1,
            );
        }
        const e = mi?.node ? owner(mi.node) : null;
        const p = e && (await picker.getWorldPointAsync(x, y));
        return { e, p: p ? [p.x, p.y, p.z] : null };
    };
    const ray = new Ray();
    const hit = new Vec3();
    const cpuPick = (x, y) => {
        cam.camera.screenToWorld(x, y, cam.camera.nearClip, ray.origin);
        cam.camera.screenToWorld(x, y, cam.camera.farClip, ray.direction);
        ray.direction.sub(ray.origin).normalize();
        let best = { e: null, p: null, d: Infinity };
        for (const r of app.root.findComponents('render')) {
            const e = owner(r.entity);
            if (!e) {
                continue;
            }
            for (const mi of r.meshInstances) {
                if (!mi.aabb.intersectsRay(ray, hit)) {
                    continue;
                }
                const d = hit.distance(ray.origin);
                if (d < best.d) {
                    best = { e, p: [hit.x, hit.y, hit.z], d };
                }
            }
        }
        return best;
    };

    // selection, hover and comment anchor attributes

    // outlined meshes render in their own layer; the default (immediate) is also drawn by the main camera, unlit
    const outlineLayer = new Layer({ name: 'Outline' });
    app.scene.layers.push(outlineLayer);
    const outline = new OutlineRenderer(app, outlineLayer);

    // the engine's edge reaches ~1 device px with no width option; its extend passes sample at 1x and 2x
    // uOffset, so a wider offset thickens it (same passes as OutlineRenderer.onPostRender, playcanvas 2.22)
    const reach = () => OUTLINE_REACH * ratio();
    const offset = new Float32Array(2);
    outline.onPostRender = function () {
        const d = app.graphicsDevice;
        const pass = (x, y, src, mul, dst) => {
            offset.set([x, y]);
            d.scope.resolve('uOffset').setValue(offset);
            d.scope.resolve('source').setValue(src.colorBuffer);
            d.scope.resolve('uSrcMultiplier').setValue(mul);
            drawQuadWithShader(d, dst, this.shaderExtend);
        };
        pass(reach() / 2 / this.rt.width, 0, this.rt, 0, this.tempRt);
        pass(0, reach() / 2 / this.rt.height, this.tempRt, 1, this.rt);
    };
    const immediate = app.scene.layers.getLayerByName('Immediate');
    let sel = [];
    let hov = null;

    // what the viewer's comment focus is on: outlined like a selection
    let marked = [];

    // in comment mode, hover outlines what a comment would land on, down to the exact part;
    // otherwise only a selection is outlined
    let commenting = false;
    let drafting = false;

    // a capture in progress draws no outlines, whatever hover or comment focus comes in meanwhile
    let capturing = 0;

    // comment mode hides the selection and its gizmo, so only the comment's highlight shows; leaving restores them
    const shown = () => (commenting ? [] : sel);

    // world bounds of entities' meshes, reusing `out`; null when they have none
    const boundsOf = (list, out) => {
        let empty = true;
        for (const e of list) {
            for (const r of e.findComponents('render')) {
                for (const mi of r.meshInstances) {
                    if (empty) {
                        out.copy(mi.aabb);
                    } else {
                        out.add(mi.aabb);
                    }
                    empty = false;
                }
            }
        }
        return empty ? null : out;
    };

    // once meshes have world bounds, fly at a pace that suits the scene; Shift doubles it, Ctrl halves it
    app.once('frameend', () => {
        const b = boundsOf([...nodes.values()], new BoundingBox());
        if (!b) {
            return;
        }
        const v = Math.min(Math.max(b.halfExtents.length() * 2 * FLY_SCENE_FRACTION, FLY_SPEED.min), FLY_SPEED.max);
        Object.assign(cc, { moveSpeed: v, moveFastSpeed: v * 2, moveSlowSpeed: v / 2 });
    });

    // selection also gets a box's corners, since a silhouette edge alone is easy to lose against the scene; as in the
    // editor it draws twice, solid where depth tested and faint over everything, so hidden edges still show, dimmed.
    // the solid pass goes first: the engine's no-depth lines still write depth, which would let it pass everywhere
    const corners = Array.from({ length: 8 }, () => new Vec3());
    const segs = [];
    const [dir, side, eye] = [new Vec3(), new Vec3(), new Vec3()];

    // the box is the entity's own, turned and stretched with it, so a rotated part keeps the corners on itself
    const [local, part] = [new BoundingBox(), new BoundingBox()];
    const [toLocal, rel] = [new Mat4(), new Mat4()];
    const cornersOf = (e) => {
        const w = e.getWorldTransform();
        toLocal.copy(w).invert();
        let empty = true;
        for (const r of e.findComponents('render')) {
            for (const mi of r.meshInstances) {
                part.setFromTransformedAabb(mi.mesh.aabb, rel.mul2(toLocal, mi.node.getWorldTransform()));
                if (empty) {
                    local.copy(part);
                } else {
                    local.add(part);
                }
                empty = false;
            }
        }
        if (empty) {
            return false;
        }
        const [lo, hi] = [local.getMin(), local.getMax()];
        corners.forEach((c, i) =>
            w.transformPoint(c.set(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z), c),
        );
        return true;
    };

    // each corner mark repeats half a device px apart across itself as seen from the camera, so it reads SELECT_BOX_PX wide
    // with no gaps between diagonal lines; the step is taken at the mark's own corner, since a long edge's far end is much
    // smaller on screen than its near one
    const [tip, far] = [new Vec3(), new Vec3()];
    const boxSegs = () => {
        const n = Math.max(1, Math.round(SELECT_BOX_PX * ratio() * 2));
        const px = Math.tan((cam.camera.fov * Math.PI) / 360) / Math.max(1, canvas.height);
        let k = 0;
        const mark = (from, to) => {
            eye.sub2(from, cam.getPosition());
            side.cross(dir, eye)
                .normalize()
                .mulScalar(Math.max(eye.dot(cam.forward), 0) * px);
            for (let j = 0; j < n; j++) {
                const t = j - (n - 1) / 2;
                for (const c of [from, to]) {
                    (segs[k++] ??= new Vec3()).copy(side).mulScalar(t).add(c);
                }
            }
        };
        for (const [a, z] of BOX_EDGES) {
            dir.sub2(corners[z], corners[a]);
            mark(corners[a], tip.copy(dir).mulScalar(SELECT_BOX_CORNER).add(corners[a]));
            mark(corners[z], far.copy(dir).mulScalar(-SELECT_BOX_CORNER).add(corners[z]));
        }
        return segs.slice(0, k);
    };
    app.on('update', () => {
        outline.frameUpdate(cam, immediate, false);
        for (const e of shown()) {
            if (!cornersOf(e)) {
                continue;
            }
            const lines = boxSegs();
            app.drawLines(lines, SELECT_COLOR, true);
            app.drawLines(lines, SELECT_BEHIND_COLOR, false);
        }
    });
    const paint = () => {
        outline.removeAllEntities();
        if (capturing) {
            return;
        }
        const on = shown();
        for (const e of on) {
            outline.addEntity(e, SELECT_COLOR);
        }
        for (const e of marked) {
            if (!on.includes(e)) {
                outline.addEntity(e, COMMENT_COLOR);
            }
        }

        // hover outlines only in comment mode; in edit mode only a selection is outlined
        if (commenting && !drafting && hov && !marked.includes(hov)) {
            outline.addEntity(hov, COMMENT_COLOR);
        }
    };
    const anchor = (e, p) => {
        const a = anchorAttrs(e ? entityPath(scene, e.sceneId) : null, p);
        canvas.dataset.entity = a.entity;
        canvas.dataset.point = a.point;
    };

    // comment mode asks what is under the cursor, so the viewer anchors the object, not the canvas; the scene
    // draws the highlight itself (hover as usual, the comment's objects as a selection) instead of a screen box
    const label = root.getAttribute('aria-label') || key;
    const corner = new Vec3();
    const screen = new Vec3();

    // an entity's world bounds as a canvas-px box, clipped to the canvas; null without meshes
    const screenBox = (e, c) => {
        const b = boundsOf([e], new BoundingBox());
        if (!b) {
            return null;
        }
        const [lo, hi] = [b.getMin(), b.getMax()];
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < 8; i++) {
            corner.set(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
            cam.camera.worldToScreen(corner, screen);
            [x0, y0, x1, y1] = [
                Math.min(x0, screen.x),
                Math.min(y0, screen.y),
                Math.max(x1, screen.x),
                Math.max(y1, screen.y),
            ];
        }
        [x0, y0, x1, y1] = [Math.max(x0, 0), Math.max(y0, 0), Math.min(x1, c.width), Math.min(y1, c.height)];
        return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
    };
    // a click comments on the object, a double-click drills into the part, as in edit mode; a click (not a hover)
    // also captures the object and some of what surrounds it, as the viewer sees it
    window.claude?.pick?.(canvas, async (x, y, how) => {
        const c = canvas.getBoundingClientRect();
        const { e: part, p } = await gpuPick(x - c.left, y - c.top);

        // empty space takes no comment; a drawn area still can
        if (!part) {
            return false;
        }
        const clicks = how?.clicks ?? 0;
        if (clicks >= 2) {
            scope = objectOf(part);
        } else if (clicks === 1 && objectOf(part) !== scope) {
            scope = null;
        }
        const e = level(part);
        const a = anchorAttrs(entityPath(scene, e.sceneId), p);
        const b = clicks && screenBox(e, c);
        const pad = b && Math.max(Math.max(b.x1 - b.x0, b.y1 - b.y0) * OBJECT_IMAGE_PAD, OBJECT_IMAGE_PAD_PX);
        const [x0, y0, x1, y1] = b
            ? [
                  Math.max(0, b.x0 - pad),
                  Math.max(0, b.y0 - pad),
                  Math.min(c.width, b.x1 + pad),
                  Math.min(c.height, b.y1 + pad),
              ]
            : [];
        const image = b
            ? await capture({ left: c.left + x0, top: c.top + y0, width: x1 - x0, height: y1 - y0 })
            : undefined;
        return {
            label: `${label} › ${a.entity}`,
            snippet: `<canvas data-scene="${key}" data-entity="${a.entity}" data-point="${a.point}">`,
            image,
        };
    });

    const byId = new Map(scene.entities.map((d) => [d.id, d]));
    const byPath = new Map(scene.entities.map((d) => [entityPath(scene, d.id), nodes.get(d.id)]));
    canvas.addEventListener('claude:focus', (ev) => {
        const d = ev.detail;
        const paths = d ? [d.snippet, ...d.inside].map((s) => /data-entity="([^"]+)"/.exec(s)?.[1]) : [];
        marked = paths.map((p) => byPath.get(p)).filter(Boolean);
        if (marked.length) {
            ev.preventDefault();
        }
        paint();
    });

    // a comment's pin sits on the world point it was placed at, hidden when that point is behind the camera or off the canvas;
    // an area's sits on the centre of the objects it lists, since the scene under its centre can be a wall far behind them
    const pinWorld = new Vec3();
    const pinScreen = new Vec3();
    const toPin = new Vec3();
    const pinBox = new BoundingBox();
    canvas.addEventListener('claude:pin', (ev) => {
        const d = ev.detail;
        const b = boundsOf(
            d.inside.map((s) => byPath.get(/data-entity="([^"]+)"/.exec(s)?.[1])).filter(Boolean),
            pinBox,
        );
        const p = /data-point="([^"]+)"/.exec(d.snippet)?.[1]?.split(',').map(Number);
        if (b) {
            pinWorld.copy(b.center);
        } else if (p?.length === 3 && p.every(Number.isFinite)) {
            pinWorld.set(...p);
        } else {
            return;
        }
        toPin.sub2(pinWorld, cam.getPosition());
        const c = canvas.getBoundingClientRect();
        cam.camera.worldToScreen(pinWorld, pinScreen);
        d.hidden =
            toPin.dot(cam.forward) <= 0 ||
            pinScreen.x < 0 ||
            pinScreen.y < 0 ||
            pinScreen.x > c.width ||
            pinScreen.y > c.height;
        [d.x, d.y] = [c.left + pinScreen.x, c.top + pinScreen.y];
    });

    // and a drawn area lists the outermost objects at least half inside it that show there, parents before children
    window.claude?.pickRect?.(canvas, async (r) => {
        const c = canvas.getBoundingClientRect();
        const [rx0, ry0, rx1, ry1] = [
            r.left - c.left,
            r.top - c.top,
            r.left - c.left + r.width,
            r.top - c.top + r.height,
        ];

        // what shows in the area, and every entity above it, so parts hidden behind others are left out
        prepare();
        const [px, py] = [Math.max(0, rx0 | 0), Math.max(0, ry0 | 0)];
        const seen = new Set();
        for (const mi of await picker.getSelectionAsync(
            px,
            py,
            Math.max(1, (Math.min(rx1, c.width) - px) | 0),
            Math.max(1, (Math.min(ry1, c.height) - py) | 0),
        )) {
            for (let n = mi.node; n; n = n.parent) {
                seen.add(n);
            }
        }
        const picked = new Set();
        const under = (d) => {
            for (let p = d.parent; p; p = byId.get(p).parent) {
                if (picked.has(p)) {
                    return true;
                }
            }
            return false;
        };
        const found = [];
        for (const d of scene.entities) {
            if (d.light || under(d) || !seen.has(nodes.get(d.id))) {
                continue;
            }
            const b = screenBox(nodes.get(d.id), c);
            if (!b) {
                continue;
            }
            const w = Math.max(0, Math.min(b.x1, rx1) - Math.max(b.x0, rx0));
            const h = Math.max(0, Math.min(b.y1, ry1) - Math.max(b.y0, ry0));
            if (w * h < ((b.x1 - b.x0) * (b.y1 - b.y0)) / 2) {
                continue;
            }
            picked.add(d.id);
            found.push({ d, cover: w * h });
        }
        const keep = new Set([...found].sort((a, b) => b.cover - a.cover).slice(0, MAX_AREA_OBJECTS));
        const inside = found
            .filter((f) => keep.has(f))
            .map((f) => `<canvas data-scene="${key}" data-entity="${entityPath(scene, f.d.id)}">`);
        const [cp, fp] = [cam.getPosition(), cc.focusPoint];
        const pose = [...round([cp.x, cp.y, cp.z], 2), ...round([fp.x, fp.y, fp.z], 2), cam.camera.fov].join(',');

        // an area over no objects (a shadow on the floor) pins on the scene point under its centre
        const [p, image] = await Promise.all([
            inside.length ? null : gpuPick((rx0 + rx1) / 2, (ry0 + ry1) / 2).then((h) => h.p),
            capture(r),
        ]);
        const point = p ? ` data-point="${anchorAttrs(null, p).point}"` : '';
        return {
            label: `${label} › area`,
            snippet: `<canvas data-scene="${key}" data-camera="${pose}"${point}>`,
            inside,
            image,
        };
    });

    // the drawn area as the viewer saw it, without hover or comment outlines; a webgl canvas is readable only
    // while the frame it drew is still in its buffer, so the copy is made as a frame ends: the second one, since
    // the frame under way may have drawn its outlines already
    const capture = (r) => {
        if (app.graphicsDevice.contextLost) {
            return Promise.resolve(null);
        }
        capturing++;
        paint();
        return new Promise((ok) =>
            app.once('frameend', () =>
                app.once('frameend', () => {
                    const c = canvas.getBoundingClientRect();
                    const [sx, sy] = [canvas.width / c.width, canvas.height / c.height];
                    const [x, y, w, h] = [(r.left - c.left) * sx, (r.top - c.top) * sy, r.width * sx, r.height * sy];
                    const k = Math.min(1, AREA_IMAGE_PX / Math.max(w, h));
                    const out = document.createElement('canvas');
                    [out.width, out.height] = [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
                    out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
                    capturing--;
                    paint();
                    const [, webp] = attempt(() => out.toDataURL('image/webp', AREA_IMAGE_QUALITY));
                    ok(
                        webp?.startsWith('data:image/webp')
                            ? webp
                            : attempt(() => out.toDataURL('image/jpeg', AREA_IMAGE_QUALITY))[1],
                    );
                }),
            ),
        );
    };

    // gizmos: only the active tool's gizmo is enabled and attached
    const layer = Gizmo.createLayer(app);
    const gizmos = {
        translate: new TranslateGizmo(cam.camera, layer),
        rotate: new RotateGizmo(cam.camera, layer),
        scale: new ScaleGizmo(cam.camera, layer),
    };
    const history = createHistory();
    // like an editor: a click selects, and the active gizmo attaches at once
    let tool = 'translate';
    let space = 'world';
    let snapLatch = false;
    let snapHeld = false;
    let onHandle = false;
    let before = null;
    const attach = () => {
        for (const [name, g] of Object.entries(gizmos)) {
            const on = editable && name === tool && shown().length > 0;
            if (on) {
                g.attach(sel);
            } else {
                g.detach();
            }
            g.enabled = on;
        }
    };
    // rotating or scaling a part under an unevenly scaled parent would skew it, so only Move is offered then
    const skewed = (e) => {
        for (let n = e.parent; n && n !== app.root; n = n.parent) {
            const s = n.getLocalScale();
            if (Math.abs(s.x - s.y) > SKEW_EPS || Math.abs(s.y - s.z) > SKEW_EPS) {
                return true;
            }
        }
        return false;
    };
    const moveOnly = () => sel.some(skewed);
    const select = (list) => {
        sel = list.slice(0, MAX_SELECTION);
        ui.selection.textContent = sel.map((e) => entityPath(scene, e.sceneId)).join(', ');
        const only = moveOnly();
        for (const b of ui.tools.querySelectorAll('[data-tool="rotate"], [data-tool="scale"]')) {
            b.dataset.label ??= b.ariaLabel;
            b.disabled = only;
            b.ariaLabel = only
                ? 'Only Move: a parent is stretched unevenly, so rotating or scaling this part would skew it'
                : b.dataset.label;
        }
        if (only && tool !== 'translate') {
            setTool('translate');
        }
        attach();
        paint();
    };

    const commit = async (changes) => {
        for (const c of changes) {
            place(nodes.get(c.id), c.to);
        }
        let writes = editWrites(changes, scene, existing, key);
        if (!writes.length) {
            return;
        }
        const ids = changes.map((c) => c.id);
        for (const id of ids) {
            pending.set(id, (pending.get(id) ?? 0) + 1);
        }
        say('Saving…');
        let [e] = await settle(db.batch(writes));
        if (e) {
            // refresh the version pins of every written doc, then retry once
            const [re, r] = await settle(col.get());
            if (!re) {
                existing = new Set(r.docs.map((d) => entityOf(key, d.id)).filter(Boolean));
            }
            await repin(ids);
            writes = editWrites(changes, scene, existing, key);
            [e] = re ? [re] : writes.length ? await settle(db.batch(writes)) : [null];
        }
        for (const id of ids) {
            pending.set(id, pending.get(id) - 1);
        }
        if (e) {
            console.error(`scene edits (${key}) not saved: ${e.message}`);
            return say(`Not saved — ${e.message}`);
        }
        for (const w of writes) {
            const id = entityOf(key, w.path.slice(EDITS.length + 1));
            if (w.op === 'delete') {
                existing.delete(id);
            } else {
                existing.add(id);
            }
        }
        say('Saved', 1500);
    };

    // freeze the camera during a handle drag instead of disabling it: re-enabling discards input
    // deltas, which leaves its shift state unbalanced (shift-to-snap then turns every orbit into a pan)
    let frozen = null;
    const freeze = (on) => {
        if (on && !frozen) {
            frozen = { rotateSpeed: cc.rotateSpeed, zoomSpeed: cc.zoomSpeed, enablePan: cc.enablePan };
            Object.assign(cc, { rotateSpeed: 0, zoomSpeed: 0, enablePan: false });
        } else if (!on && frozen) {
            Object.assign(cc, frozen);
            frozen = null;
        }
    };

    Object.entries(gizmos).forEach(([name, g]) => {
        g.coordSpace = space;
        g.snapIncrement = SNAP[name];
        g.enabled = false;
        g.on('pointer:down', (_x, _y, mi) => {
            if (name !== tool) {
                return;
            }
            onHandle = !!mi;
            if (onHandle) {
                freeze(true);
            }
        });
        g.on('pointer:up', () => {
            if (name !== tool) {
                return;
            }
            onHandle = false;
            freeze(false);
        });
        g.on('transform:start', () => {
            before = sel.map((e) => ({ id: e.sceneId, before: read(e) }));
            dragging = new Set(before.map((b) => b.id));
        });
        g.on('transform:end', () => {
            const op = (before ?? [])
                .map((b) => ({ ...b, after: read(nodes.get(b.id)) }))
                .filter((o) => !sameTransform(o.before, o.after));
            before = null;
            dragging = new Set();
            if (!op.length) {
                return;
            }
            history.push(op);
            commit(op.map((o) => ({ id: o.id, to: o.after })));
        });
    });

    const setSnap = () => {
        for (const g of Object.values(gizmos)) {
            g.snap = snapLatch || snapHeld;
        }
        ui.snap.setAttribute('aria-pressed', String(snapLatch));
    };
    const setTool = (t) => {
        if (t !== 'translate' && moveOnly()) {
            return;
        }
        tool = t;
        for (const b of ui.tools.querySelectorAll('[data-tool]')) {
            b.setAttribute('aria-pressed', String(b.dataset.tool === t));
        }
        attach();
    };
    const setSpace = (s) => {
        space = s;
        for (const g of Object.values(gizmos)) {
            g.coordSpace = s;
        }
        ui.space.ariaLabel = `${s === 'local' ? 'Local' : 'World'} axes (X)`;
        ui.space.setAttribute('aria-pressed', String(s === 'local'));
    };
    const undoRedo = (redo) => {
        const ch = redo ? history.redo() : history.undo();
        if (ch) {
            commit(ch);
        }
    };
    const frame = () => {
        const box = boundsOf(sel, new BoundingBox());
        if (!box) {
            return;
        }
        const c = box.center.clone();
        cc.reset(c, c.clone().add(cam.forward.clone().mulScalar(-Math.max(box.halfExtents.length() * 3, 0.5))));
    };

    if (editable) {
        ui.tools.hidden = false;
        ui.tools.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) {
                return;
            }
            if (b.dataset.tool) {
                setTool(b.dataset.tool);
            } else if (b === ui.space) {
                setSpace(space === 'world' ? 'local' : 'world');
            } else if (b === ui.snap) {
                snapLatch = !snapLatch;
                setSnap();
            } else if (b === ui.undo || b === ui.redo) {
                undoRedo(b === ui.redo);
            }
        });
    }

    // keys reach only the active scene: the one last pointed at
    const keydown = (e) => {
        const k = e.key.toLowerCase();
        if ((e.metaKey || e.ctrlKey) && k === 'z') {
            if (!editable) {
                return;
            }
            e.preventDefault();
            return undoRedo(e.shiftKey);
        }
        if (e.metaKey || e.ctrlKey || e.altKey) {
            return;
        }
        if (e.key === 'Shift') {
            snapHeld = true;
            return setSnap();
        }
        if (k === 'escape') {
            // out of a drilled-in object first, back to the object itself
            const s = scope;
            scope = null;
            select(s ? [s] : []);
        } else if (k === 'f') {
            frame();
        } else if (editable && TOOL_KEYS[k]) {
            setTool(TOOL_KEYS[k]);
        } else if (editable && k === 'x') {
            setSpace(space === 'world' ? 'local' : 'world');
        }
    };
    const keyup = (e) => {
        if (e.key !== 'Shift') {
            return;
        }
        snapHeld = false;
        setSnap();
    };
    const blur = () => {
        snapHeld = false;
        setSnap();
    };
    // a still of the frame without hover or comment outlines; rendered and copied in one task, while it is still readable
    const still = () => {
        if (app.graphicsDevice.contextLost || !canvas.width) {
            return undefined;
        }
        capturing++;
        paint();
        app.render();
        const k = Math.min(1, STILL_PX / Math.max(canvas.width, canvas.height));
        const out = document.createElement('canvas');
        [out.width, out.height] = [Math.round(canvas.width * k), Math.round(canvas.height * k)];
        out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
        capturing--;
        paint();
        return attempt(() => out.toDataURL('image/jpeg', STILL_QUALITY))[1] ?? undefined;
    };

    // what a republish keeps through window.claude.hot: the selection, the gizmo tool and a still of the view (the
    // camera keeps itself)
    const snapshot = () => ({ sel: sel.map((e) => e.sceneId), tool, still: still() });
    const restore = (v) => {
        if (!v || !Array.isArray(v.sel)) {
            return;
        }
        select(v.sel.map((id) => nodes.get(id)).filter(Boolean));
        if (['translate', 'rotate', 'scale'].includes(v.tool)) {
            setTool(v.tool);
        }
    };
    const ctl = { key, keydown, keyup, blur, snapshot, restore };

    // pointer: gizmo listeners were added first, so onHandle is current in our pointerdown
    let hoverAt = null;
    let hoverRaf = 0;
    // no hover outline while a comment box is open; the comment's own outline stays
    document.addEventListener('claude:draft', (e) => {
        drafting = !!e.detail?.open;
        if (drafting) {
            hov = null;
            canvas.style.removeProperty('cursor');
        }
        paint();
        if (!drafting && over && hoverAt) {
            hoverRaf ||= requestAnimationFrame(hover);
        }
    });
    document.addEventListener('claude:comment-mode', (e) => {
        commenting = !!e.detail?.on;
        attach();
        paint();
        if (over && hoverAt) {
            hoverRaf ||= requestAnimationFrame(hover);
        }
    });
    let down = null;
    let lastPart = null;
    let over = false;
    let lastPose = '';
    const hover = async () => {
        hoverRaf = 0;
        const { e: part, p } = await gpuPick(...hoverAt);
        if (!over) {
            return;
        }
        const e = level(part);
        if (e !== hov) {
            hov = e;
            paint();
        }
        anchor(e, p);

        // a hand only in comment mode, over what a comment would land on; it outranks the viewer's crosshair
        if (commenting && !drafting && e) {
            canvas.style.setProperty('cursor', 'pointer', 'important');
        } else {
            canvas.style.removeProperty('cursor');
        }
    };
    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse' || down) {
            return;
        }

        // a press in comment mode is the viewer's click or area drag (it never reaches pointerdown), so hover steps aside
        if (commenting && e.buttons) {
            if (hov) {
                hov = null;
                paint();
            }
            return;
        }
        over = true;
        hoverAt = [e.offsetX, e.offsetY];

        // hover only matters in comment mode; edit mode picks on the click itself
        if (commenting) {
            hoverRaf ||= requestAnimationFrame(hover);
        }
    });

    // a zoom, orbit or look moves the scene under a still cursor and its pins, so re-pick and re-pin when the
    // camera moves or turns; on 'prerender', since the camera's view matrix only refreshes then, and pins placed
    // earlier in the frame would project with the last frame's camera and trail the scene by a frame
    app.on('prerender', () => {
        const [c, r] = [cam.getPosition(), cam.getRotation()];
        const pose = `${c.x},${c.y},${c.z},${r.x},${r.y},${r.z},${r.w}`;
        if (pose === lastPose) {
            return;
        }
        lastPose = pose;
        document.dispatchEvent(new Event('claude:layout'));
        if (commenting && over && hoverAt && !down) {
            hoverRaf ||= requestAnimationFrame(hover);
        }
    });
    canvas.addEventListener('pointerenter', () => {
        over = true;
        activate(ctl);
    });
    canvas.addEventListener('pointerleave', () => {
        over = false;
        hov = null;
        paint();
        anchor(null, null);
    });
    canvas.addEventListener('pointerdown', (e) => {
        activate(ctl);

        // only the primary button selects; the others orbit, pan and fly
        if (e.button !== 0) {
            return;
        }
        down = { x: e.offsetX, y: e.offsetY, handle: onHandle, hit: null };
        if (e.pointerType === 'mouse') {
            return;
        }
        const h = cpuPick(e.offsetX, e.offsetY);
        anchor(level(h.e), h.p);
        down.hit = h.e;
    });
    // a click picks where it landed: the last hover pick can lag a quick move, and would select what was under it
    canvas.addEventListener('pointerup', async (e) => {
        const d = down;
        down = null;
        if (!d || d.handle || Math.hypot(e.offsetX - d.x, e.offsetY - d.y) > CLICK_SLOP) {
            return;
        }
        lastPart = e.pointerType === 'mouse' ? (await gpuPick(e.offsetX, e.offsetY)).e : d.hit;
        const h = level(lastPart);
        if (!h || objectOf(h) !== scope) {
            scope = null;
        }
        const toggled = h && (sel.includes(h) ? sel.filter((x) => x !== h) : [...sel, h]);
        select(h ? (e.shiftKey ? toggled : [h]) : e.shiftKey ? sel : []);
    });

    // a double-click selects the part under the cursor and drills into its object, and the camera glides to put
    // the point clicked at the centre of the view, where it then orbits (comment mode keeps the view still)
    canvas.addEventListener('dblclick', async (e) => {
        if (commenting || !lastPart) {
            return;
        }
        scope = objectOf(lastPart);
        select([lastPart]);
        const { p } = await gpuPick(e.offsetX, e.offsetY);
        if (p) {
            cc.focus(new Vec3(...p));
        }
    });
    return ctl;
};

// every <canvas data-scene> is an independent app; they share one engine module and one db handle
const canvases = [...document.querySelectorAll('canvas[data-scene]')];

// after a republish each scene shows the last version's still until its own models have drawn, so the open view
// never shows an empty or half-loaded scene; each entry lifts that scene's still
const stills = new Map();
for (const c of canvases) {
    const src = window.claude?.hot?.data?.scenes?.[c.dataset.scene]?.still;
    if (typeof src !== 'string' || !src.startsWith('data:image/')) {
        continue;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    img.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;transition:opacity .3s';
    if (getComputedStyle(c.parentElement).position === 'static') {
        c.parentElement.style.position = 'relative';
    }
    c.after(img);
    let t = 0;
    const lift = () => {
        clearTimeout(t);
        img.style.opacity = '0';
        setTimeout(() => img.remove(), 350);
    };
    t = setTimeout(lift, STILL_MAX_MS);
    stills.set(c.dataset.scene, lift);
}
const db = canvases.length ? ((await window.claude?.use('db')) ?? null) : null;
const keys = new Set();
const ctls = [];
let active = null;
const activate = (x) => (active = x);
const isActive = (x) => !!x && active === x;
for (const c of canvases) {
    const k = c.dataset.scene;
    if (!ID_RE.test(k) || keys.has(k)) {
        console.error(`scene "${k}": data-scene must be unique and match ${ID_RE}`);
        continue;
    }
    keys.add(k);
    // the scene can ask before mount resolves (its app updates while it loads), so ctl starts null
    let ctl = null;
    ctl = await mount(c, db, activate, () => isActive(ctl));
    if (ctl) {
        ctls.push(ctl);
    }
}
active ??= ctls[0] ?? null;

// a republish reaches open views through window.claude.hot: hand over each scene's selection and tool, and take them back
const hot = window.claude?.hot;
hot?.snapshot?.(() => ({ scenes: Object.fromEntries(ctls.map((c) => [c.key, c.snapshot()])) }));
const kept = hot?.data?.scenes;
if (kept && typeof kept === 'object') {
    for (const c of ctls) {
        c.restore(kept[c.key]);
    }
}
addEventListener('keydown', (e) => typing(e.target) || active?.keydown(e));
addEventListener('keyup', (e) => active?.keyup(e));
addEventListener('blur', () => {
    ctls.forEach((c) => c.blur());
    for (const code of FLY_CODES) {
        dispatchEvent(new KeyboardEvent('keyup', { code }));
    }
});
