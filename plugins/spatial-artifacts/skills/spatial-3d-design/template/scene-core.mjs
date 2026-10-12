// pure scene logic for the page runtime; no engine or dom access, so node tests it directly

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const EDITS = 'edits';
export const MAX_SELECTION = 50;
export const PRIMITIVES = ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane'];
export const LIGHTS = ['directional', 'omni', 'spot'];
export const TONE_MAPS = ['linear', 'aces', 'neutral'];
const CAMERA_DEFAULT = { pos: [3, 2, 3], target: [0, 0.5, 0], fov: 45 };
const ENV_DEFAULT = { clear: [0.12, 0.12, 0.13], ambient: [0.2, 0.2, 0.2], exposure: 1, toneMapping: 'aces' };
const MAT_DEFAULT = { diffuse: [0.8, 0.8, 0.8], gloss: 0.5, metalness: 0 };
const KINDS = ['primitive', 'model', 'light'];
const EPS = 1e-4;

// 1 - |dot| of two unit quaternions; 1e-8 is about 0.016 degrees
const ROT_EPS = 1e-8;

export const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
export const round = (v, d = 4) => v.map((n) => Math.round(n * 10 ** d) / 10 ** d);
const isColor = (v) => isVec3(v) || (typeof v === 'string' && /^token:--[\w-]+$/.test(v));
const unit = (n) => Number.isFinite(n) && n >= 0 && n <= 1;

const parseJson = (text) => {
    try {
        return [null, JSON.parse(text)];
    } catch (e) {
        return [e];
    }
};

/** validates scene-data text; returns [errors, scene with defaults filled] */
export const parseScene = (text) => {
    const [je, s] = parseJson(text);
    if (je) {
        return [[`scene-data is not valid JSON: ${je.message}`], null];
    }
    if (!s || s.v !== 1) {
        return [['scene-data "v" must be 1'], null];
    }
    if (!Array.isArray(s.entities)) {
        return [['scene-data "entities" must be an array'], null];
    }
    const errs = [];
    const camera = { ...CAMERA_DEFAULT, ...s.camera };
    if (!isVec3(camera.pos) || !isVec3(camera.target)) {
        errs.push('camera "pos" and "target" must be three finite numbers');
    }
    if (!(camera.fov >= 5 && camera.fov <= 120)) {
        errs.push('camera "fov" must be between 5 and 120');
    }
    const environment = { ...ENV_DEFAULT, ...s.environment };
    if (!isColor(environment.clear) || !isColor(environment.ambient)) {
        errs.push('environment "clear" and "ambient" must be RGB arrays or "token:--name"');
    }
    if (!(environment.exposure > 0)) {
        errs.push('environment "exposure" must be a positive number');
    }
    if (!TONE_MAPS.includes(environment.toneMapping)) {
        errs.push(`environment "toneMapping" must be one of ${TONE_MAPS.join(', ')}`);
    }
    const materials = Object.fromEntries(
        Object.entries(s.materials ?? {}).map(([k, m]) => {
            const mat = { ...MAT_DEFAULT, ...m };
            if (!isColor(mat.diffuse) || (mat.emissive !== undefined && !isColor(mat.emissive))) {
                errs.push(`materials.${k}: "diffuse" and "emissive" must be RGB arrays or "token:--name"`);
            }
            if (!unit(mat.gloss) || !unit(mat.metalness)) {
                errs.push(`materials.${k}: "gloss" and "metalness" must be between 0 and 1`);
            }
            return [k, mat];
        }),
    );
    const models = s.models ?? {};
    const seen = new Set();
    const entities = s.entities.map((e, i) => {
        const at = `entities[${i}]${typeof e?.id === 'string' ? ` (${e.id})` : ''}`;
        if (!e || typeof e !== 'object') {
            return (errs.push(`${at} must be an object`), null);
        }
        if (!ID_RE.test(e.id ?? '')) {
            errs.push(`${at}: "id" must match ${ID_RE}`);
        } else if (seen.has(e.id)) {
            errs.push(`${at}: duplicate id "${e.id}"`);
        }
        if (typeof e.name !== 'string' || !e.name || e.name.length > 128 || e.name.includes('/')) {
            errs.push(`${at}: "name" must be 1-128 characters without "/"`);
        }
        if (e.parent !== undefined && !seen.has(e.parent)) {
            errs.push(`${at}: parent "${e.parent}" must be an earlier entity's id`);
        }
        seen.add(e.id);
        for (const k of ['pos', 'rot', 'scale']) {
            if (e[k] !== undefined && !isVec3(e[k])) {
                errs.push(`${at}: "${k}" must be three finite numbers`);
            }
        }
        const kinds = KINDS.filter((k) => e[k] !== undefined);
        if (kinds.length > 1) {
            errs.push(`${at}: has ${kinds.join(' and ')}; use at most one`);
        }
        if (e.primitive !== undefined && !PRIMITIVES.includes(e.primitive)) {
            errs.push(`${at}: primitive must be one of ${PRIMITIVES.join(', ')}`);
        }
        if (e.material !== undefined && !materials[e.material]) {
            errs.push(`${at}: material "${e.material}" is not a key of "materials"`);
        }
        if (e.model !== undefined && typeof models[e.model] !== 'string') {
            errs.push(`${at}: model "${e.model}" is not a key of "models"`);
        }
        if (e.light !== undefined && !LIGHTS.includes(e.light?.type)) {
            errs.push(`${at}: light type must be one of ${LIGHTS.join(', ')}`);
        }
        if (e.light?.color !== undefined && !isColor(e.light.color)) {
            errs.push(`${at}: light "color" must be an RGB array or "token:--name"`);
        }
        return { ...e, pos: e.pos ?? [0, 0, 0], rot: e.rot ?? [0, 0, 0], scale: e.scale ?? [1, 1, 1] };
    });
    return errs.length ? [errs, null] : [[], { v: 1, camera, environment, materials, models, entities }];
};

/** "/"-joined names from the root, e.g. /Desk/Lamp */
export const entityPath = (scene, id) => {
    const by = new Map(scene.entities.map((e) => [e.id, e]));
    const names = [];
    for (let e = by.get(id); e; e = by.get(e.parent)) {
        names.unshift(e.name);
    }
    return `/${names.join('/')}`;
};

/** the entity a click on `id` selects: itself, or for a locked part its nearest unlocked ancestor, else its root; `any` takes the part itself */
export const pickTarget = (scene, id, any = false) => {
    const by = new Map(scene.entities.map((e) => [e.id, e]));
    let e = by.get(id);
    if (!e) {
        return null;
    }
    while (!any && (e.locked || e.light) && e.parent) {
        e = by.get(e.parent);
    }
    return e.id;
};

export const transformOf = (e) => ({ pos: [...e.pos], rot: [...e.rot], scale: [...e.scale] });

/** euler degrees to a quaternion, same convention as the engine's Quat#setFromEulerAngles */
const quatOf = ([ex, ey, ez]) => {
    const [sx, cx, sy, cy, sz, cz] = [ex, ey, ez].flatMap((d) => [
        Math.sin((d * Math.PI) / 360),
        Math.cos((d * Math.PI) / 360),
    ]);
    return [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
    ];
};
const near = (a, b) => a.every((n, i) => Math.abs(n - b[i]) < EPS);

// the engine reads rotations back in another euler form (0,180,0 as 180,0,180), so compare orientations
export const sameTransform = (a, b) => {
    const [qa, qb] = [quatOf(a.rot), quatOf(b.rot)];
    return (
        near(a.pos, b.pos) && near(a.scale, b.scale) && Math.abs(qa.reduce((s, n, i) => s + n * qb[i], 0)) > 1 - ROT_EPS
    );
};

export const validOverride = (d) =>
    d && isVec3(d.pos) && isVec3(d.rot) && isVec3(d.scale) ? { pos: d.pos, rot: d.rot, scale: d.scale } : null;

/** edits doc id for an entity in a scene; ids never contain ":" */
export const docId = (key, id) => `${key}:${id}`;
export const entityOf = (key, doc) => (doc.startsWith(`${key}:`) ? doc.slice(key.length + 1) : null);

/** db.batch writes for changed transforms: set when off base, delete an existing doc when back on it */
export const editWrites = (changes, scene, existing, key) => {
    const by = new Map(scene.entities.map((e) => [e.id, e]));
    return changes.flatMap(({ id, to }) => {
        const e = by.get(id);
        if (!e) {
            return [];
        }
        const path = `${EDITS}/${docId(key, id)}`;
        if (sameTransform(to, e)) {
            return existing.has(id) ? [{ op: 'delete', path }] : [];
        }
        return [
            {
                op: 'set',
                path,
                data: {
                    pos: round(to.pos),
                    rot: round(to.rot),
                    scale: round(to.scale),
                    path: entityPath(scene, id),
                    scene: key,
                },
            },
        ];
    });
};

/** undo stack of ops, each op = [{ id, before, after }] */
export const createHistory = (limit = 100) => {
    const undo = [];
    const redo = [];
    return {
        push: (op) => {
            undo.push(op);
            if (undo.length > limit) {
                undo.shift();
            }
            redo.length = 0;
        },
        undo: () => {
            const op = undo.pop();
            if (!op) {
                return null;
            }
            redo.push(op);
            return op.map((o) => ({ id: o.id, to: o.before }));
        },
        redo: () => {
            const op = redo.pop();
            if (!op) {
                return null;
            }
            undo.push(op);
            return op.map((o) => ({ id: o.id, to: o.after }));
        },
    };
};

/** the saved view if it was taken under this authored camera; otherwise the authored camera */
export const viewFor = (saved, camera) =>
    saved && isVec3(saved.pos) && isVec3(saved.target) && saved.from === JSON.stringify(camera) ? saved : camera;

export const anchorAttrs = (path, point) => ({ entity: path ?? '', point: point ? round(point, 2).join(',') : '' });

/** css hex or rgb()/rgba() to 0-1 floats; null for anything else */
export const parseColor = (css) => {
    const s = (css ?? '').trim();
    const h = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(s);
    if (h) {
        const x = h[1].length === 3 ? [...h[1]].map((c) => c + c).join('') : h[1];
        return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
    }
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
    return m ? [m[1], m[2], m[3]].map((n) => Number(n) / 255) : null;
};
