// builds the garden bedroom as GLBs with baked PNG textures; node only, no dependencies
// usage: node build-models.mjs [out dir], which defaults to models/ beside this script
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] ?? join(import.meta.dirname, 'models');
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

// late-afternoon sun: the direction its light travels (matches the scene's sun rot [-62, -35, 0])
const SUN = [-0.506, -0.469, 0.723];

// ---------- math ----------

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const sstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};
const fract = (x) => x - Math.floor(x);
const norm = (v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((c) => c / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const rng = (s) => () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------- noise (tileable value noise over the unit square) ----------

const hash = (x, y, s) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const vn = (x, y, px, py, s = 0) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const X = (i) => ((i % px) + px) % px, Y = (j) => ((j % py) + py) % py;
    const a = hash(X(xi), Y(yi), s), b = hash(X(xi + 1), Y(yi), s);
    const c = hash(X(xi), Y(yi + 1), s), d = hash(X(xi + 1), Y(yi + 1), s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

// fx, fy: whole lattice cells across the tile, so the result wraps
const fbm = (u, v, fx, fy = fx, oct = 4, s = 0) => {
    let t = 0, a = 1, n = 0;
    for (let o = 0; o < oct; o++) {
        t += a * vn(u * fx, v * fy, fx, fy, s + o * 17);
        n += a;
        a *= 0.5;
        fx *= 2;
        fy *= 2;
    }
    return t / n;
};

// cheap smooth 3d noise for displacing hedges, crowns and stones
const KS = Array.from({ length: 8 }, (_, i) => {
    const r = rng(91 + i);
    return [...norm([r() - 0.5, r() - 0.5, r() - 0.5]).map((c) => c * (1 + i * 0.8)), r() * TAU];
});
const n3 = (p, s = 0) => {
    let t = 0;
    for (let i = 0; i < 6; i++) {
        const k = KS[(i + s) % KS.length];
        t += Math.sin(p[0] * k[0] + p[1] * k[1] + p[2] * k[2] + k[3] + s) / (i + 1);
    }
    return t / 2.45;
};

// ---------- textures ----------

const img = (w, h, f, ch = 3) => {
    const d = new Uint8Array(w * h * ch);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const c = f(x / w, y / h), o = (y * w + x) * ch;
            for (let k = 0; k < ch; k++) {
                d[o + k] = Math.round(clamp(c[k] ?? 1) * 255);
            }
        }
    }
    return { w, h, ch, d };
};

// one pass yields colour, a tangent-space normal map from height, and roughness (glTF reads green)
const bake = (w, h, f, k = 4) => {
    const H = new Float32Array(w * h), C = [], R = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = f(x / w, y / h);
            H[y * w + x] = s.h ?? 0;
            C.push(s.c);
            R.push(s.r ?? 0.8);
        }
    }
    const at = (x, y) => H[((y + h) % h) * w + ((x + w) % w)];
    const n = img(w, h, (u, v) => {
        const x = Math.round(u * w), y = Math.round(v * h);
        const q = norm([(at(x - 1, y) - at(x + 1, y)) * k, (at(x, y - 1) - at(x, y + 1)) * k, 1]);
        return q.map((c) => c * 0.5 + 0.5);
    });
    return {
        c: img(w, h, (u, v) => C[Math.round(v * h) * w + Math.round(u * w)]),
        n,
        r: img(w, h, (u, v) => [1, R[Math.round(v * h) * w + Math.round(u * w)], 0]),
    };
};
const lazy = (f) => {
    let v;
    return () => (v ??= f());
};

// grain runs along u; rings across v, warped so they wander like real figure
const wood = (u, v, o) => {
    const w = fbm(u, v, 2, 3, 3, o.s) * 1.6 + fbm(u, v, 1, 6, 2, o.s + 5) * 0.4;
    const ring = Math.pow(0.5 + 0.5 * Math.sin(TAU * (v * o.rings + w * (o.warp ?? 2))), o.sharp ?? 3);
    const fig = fbm(u, v, 3, 2, 3, o.s + 9);
    const pore = Math.pow(vn(u * 5, v * o.pores, 5, o.pores, o.s + 11), 8);
    const t = clamp(ring * (o.k ?? 0.75) + (fig - 0.5) * 0.6);
    const c = mixc(o.light, o.dark, t).map((x) => x * (0.92 + 0.16 * fig) * (1 - 0.35 * pore));
    return { c, h: ring * 0.35 - pore * 0.6, r: o.rough + 0.2 * pore - 0.05 * ring };
};
const WALNUT = { light: [0.47, 0.31, 0.2], dark: [0.25, 0.15, 0.1], rings: 22, pores: 160, rough: 0.42, s: 3 };
const ASH = { light: [0.84, 0.74, 0.6], dark: [0.66, 0.53, 0.38], rings: 14, pores: 140, rough: 0.5, sharp: 6, s: 21 };

// plain-weave linen: slubby threads, warp over weft on alternating cells
const weave = (u, v, base, N = 120, s = 0) => {
    const x = u * N, y = v * N, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sw = 0.75 + 0.5 * vn(v * 9, ix, 9, N, s + 3), sf = 0.75 + 0.5 * vn(u * 9, iy, 9, N, s + 4);
    const warp = Math.pow(Math.sin(Math.PI * fx), 0.7) * sw, weft = Math.pow(Math.sin(Math.PI * fy), 0.7) * sf;
    const over = (ix + iy) % 2 == 0;
    const h = over ? Math.max(warp, weft * 0.55) : Math.max(weft, warp * 0.55);
    const tone = 0.9 + 0.08 * (over ? sw : sf) + 0.04 * fbm(u, v, 6, 6, 3, s) - 0.14 * (1 - h);
    return { c: base.map((c) => c * tone), h: h * 0.5, r: 0.85 };
};

const T = {
    walnut: lazy(() => bake(1024, 1024, (u, v) => wood(u, v, WALNUT), 3)),
    ash: lazy(() => bake(512, 512, (u, v) => wood(u, v, ASH), 3)),
    // oak boards 125 mm wide, grain along v, two joints per column per 2 m tile
    oak: lazy(() =>
        bake(1024, 1024, (u, v) => {
            const N = 16, col = Math.floor(u * N), fu = u * N - col;
            const j1 = hash(col, 1, 7), j2 = fract(j1 + 0.3 + 0.35 * hash(col, 2, 7));
            const a = Math.min(j1, j2), b = Math.max(j1, j2), seg = v >= a && v < b ? 1 : 0;
            const id = hash(col, seg + 3, 9);
            const wrap = (d) => Math.min(Math.abs(d), 1 - Math.abs(d));
            const dj = Math.min(wrap(v - a), wrap(v - b)) * 2, ds = Math.min(fu, 1 - fu) * (2 / N);
            const e = Math.min(dj, ds), seam = 1 - sstep(0.0006, 0.0022, e);

            // the board that wraps the tile edge keeps unshifted grain, so the tile repeats without a jump
            const w = wood(fract(v + seg * id * 0.5), u, { light: [0.82, 0.64, 0.45], dark: [0.66, 0.48, 0.32], rings: 48, pores: 220, rough: 0.4, sharp: 4, s: 33, k: 0.35, warp: 0.8 });
            const tone = 0.86 + 0.24 * id;
            const c = w.c.map((x, i) => x * tone * (i == 2 ? 0.96 + 0.06 * id : 1)).map((x) => x * (1 - 0.55 * seam));
            return { c, h: (w.h * 0.25 + 0.6) * sstep(0, 0.004, e), r: w.r + 0.35 * seam };
        }, 3),
    ),
    plaster: lazy(() =>
        bake(512, 512, (u, v) => {
            const m = fbm(u, v, 3, 3, 4, 41), t = Math.abs(fbm(u, v, 6, 6, 3, 43) - 0.5) * 2, g = fbm(u, v, 64, 64, 2, 45);
            return { c: [0.9, 0.87, 0.82].map((c) => c * (0.95 + 0.07 * m - 0.03 * t + 0.02 * g)), h: t * 0.25 + g * 0.15, r: 0.9 };
        }, 3),
    ),
    sage: lazy(() =>
        img(512, 512, (u, v) => {
            const m = fbm(u, v, 3, 3, 4, 41), t = Math.abs(fbm(u, v, 6, 6, 3, 43) - 0.5) * 2;
            return [0.6, 0.64, 0.55].map((c) => c * (0.92 + 0.12 * m - 0.04 * t));
        }),
    ),
    linen: lazy(() => bake(512, 512, (u, v) => weave(u, v, [0.95, 0.94, 0.91]), 5)),
    linenBlue: lazy(() => img(512, 512, (u, v) => weave(u, v, [0.56, 0.64, 0.7]).c)),
    linenRust: lazy(() => img(512, 512, (u, v) => weave(u, v, [0.72, 0.4, 0.28], 90, 7).c)),
    linenOat: lazy(() => img(512, 512, (u, v) => weave(u, v, [0.88, 0.84, 0.76], 120, 9).c)),

    // chunky chevron knit for the throw
    knit: lazy(() =>
        bake(512, 512, (u, v) => {
            const cols = 28, rows = 40, x = u * cols, fx = fract(x), ix = Math.floor(x);
            const y = v * rows + Math.abs(fx - 0.5) * 1.2, fy = fract(y);
            const h = Math.sin(Math.PI * fx) * Math.pow(Math.sin(Math.PI * fy), 0.6);
            const tone = 0.78 + 0.25 * h + 0.06 * vn(ix, v * 20, cols, 20, 5);
            return { c: [0.76, 0.54, 0.26].map((c) => c * tone), h, r: 0.95 };
        }, 4),
    ),
    boucle: lazy(() =>
        bake(512, 512, (u, v) => {
            const a = Math.abs(vn(u * 90, v * 90, 90, 90, 61) - 0.5) * 2, b = Math.abs(vn(u * 45, v * 45, 45, 45, 63) - 0.5) * 2;
            const h = 1 - Math.min(a, b);
            return { c: [0.22, 0.32, 0.29].map((c) => c * (0.78 + 0.32 * h)), h: h * 0.6, r: 0.95 };
        }, 4),
    ),

    // flat-woven wool rug: cream field, charcoal lattice, rust and indigo border bands
    rug: lazy(() =>
        bake(1024, 726, (u, v) => {
            const x = u * 2.4, z = v * 1.7, e = Math.min(x, 2.4 - x, z, 1.7 - z), dx = x - 1.2, dz = z - 0.85;
            const wob = (fbm(u, v, 8, 6, 3, 71) - 0.5) * 0.06;
            const CREAM = [0.87, 0.82, 0.72], CHAR = [0.3, 0.27, 0.25], RUST = [0.63, 0.31, 0.2], INDIGO = [0.2, 0.25, 0.38], OCHRE = [0.8, 0.6, 0.32];
            let c = CREAM;
            if (e < 0.045) c = CHAR;
            else if (e < 0.1) c = CREAM;
            else if (e < 0.15) c = RUST;
            else if (e < 0.165) c = CREAM;
            else if (e < 0.185) c = INDIGO;
            else if (e > 0.23) {
                const d1 = Math.abs(fract((dx + dz) / 0.32 + wob) - 0.5), d2 = Math.abs(fract((dx - dz) / 0.32 + wob) - 0.5);
                const md = Math.abs(dx) / 0.62 + Math.abs(dz) / 0.42;
                if (md < 0.42) c = RUST;
                else if (md < 0.55) c = OCHRE;
                else if (md < 0.62) c = CREAM;
                else if (md < 1) c = INDIGO;
                else if (md < 1.06) c = CREAM;
                else if (Math.max(d1, d2) > 0.465 + 0.02 * vn(u * 40, v * 30, 40, 30, 72)) c = CHAR;
            }
            const pile = fbm(u, v, 160, 113, 2, 73), abrash = fbm(u, v, 4, 3, 3, 75);
            return { c: c.map((q) => q * (0.84 + 0.18 * pile + 0.08 * abrash)), h: pile * 0.6, r: 0.98 };
        }, 4),
    ),
    // pebbled caramel leather with a little patina on the high points
    leather: lazy(() =>
        bake(512, 512, (u, v) => {
            const a = vn(u * 110, v * 110, 110, 110, 191), b = vn(u * 55, v * 55, 55, 55, 193), m = fbm(u, v, 4, 4, 4, 195);
            const h = (1 - Math.abs(a - 0.5) * 2) * 0.6 + b * 0.4;
            return { c: [0.62, 0.37, 0.17].map((q) => q * (0.8 + 0.24 * m + 0.12 * h)), h, r: 0.4 + 0.18 * (1 - h) };
        }, 3),
    ),
    ceramic: lazy(() =>
        img(256, 256, (u, v) => {
            const sp = vn(u * 120, v * 120, 120, 120, 81) > 0.9 ? 0.55 : 1;
            return [0.9, 0.86, 0.78].map((c, i) => c * (0.96 + 0.05 * fbm(u, v, 4, 4, 3, 83)) * (i == 2 ? sp * 0.95 : sp));
        }),
    ),
    terracotta: lazy(() => img(256, 256, (u, v) => [0.72, 0.4, 0.26].map((c) => c * (0.85 + 0.2 * fbm(u, v, 8, 8, 4, 85))))),
    soil: lazy(() => img(256, 256, (u, v) => [0.2, 0.14, 0.1].map((c) => c * (0.6 + 0.6 * fbm(u, v, 32, 32, 3, 87))))),
    pages: lazy(() => img(64, 256, (u, v) => [0.94, 0.91, 0.83].map((c) => c * (0.9 + 0.1 * vn(u * 2, v * 256, 2, 256, 89))))),
    cloth: (rgb, s) => img(256, 256, (u, v) => rgb.map((c) => c * (0.88 + 0.08 * Math.sin(u * TAU * 64) * Math.sin(v * TAU * 64) + 0.1 * fbm(u, v, 8, 8, 3, s)))),
    sansevieria: lazy(() =>
        img(128, 256, (u, v) => {
            if (u < 0.07 || u > 0.93) return [0.72, 0.7, 0.32];
            const band = sstep(0.55, 0.8, Math.sin(v * 70 + Math.sin(u * 9) * 1.4 + fbm(u, v, 4, 8, 2, 91) * 3));
            return mixc([0.12, 0.25, 0.13], [0.4, 0.52, 0.38], band * 0.7);
        }),
    ),
    keyboard: lazy(() =>
        img(512, 360, (u, v) => {
            const AL = [0.74, 0.75, 0.77];
            const x = u * 0.29, z = v * 0.2;
            if (z > 0.115) {
                const tx = Math.abs(x - 0.145), tz = Math.abs(z - 0.16);
                const pad = tx < 0.055 && tz < 0.032;
                const edge = pad && (0.055 - tx < 0.0008 || 0.032 - tz < 0.0008);
                return edge ? [0.6, 0.61, 0.63] : AL;
            }
            if (z < 0.012 || x < 0.012 || x > 0.278) return AL;
            const kz = (z - 0.012) / 0.0172, row = Math.floor(kz), fz = kz - row;
            const w = row == 0 ? 0.0145 : 0.0178, off = row % 2 ? 0.006 : 0;
            const kx = (x - 0.012 - off) / w, fx = fract(kx);
            const inKey = fz > 0.1 && fz < 0.9 && (fx > 0.08 && fx < 0.92) && row < 6;
            return inKey ? [0.13, 0.13, 0.14] : [0.1, 0.1, 0.11];
        }),
    ),

    // a dusk dune wallpaper with a menu bar and dock, lit as the screen's emission
    screen: lazy(() =>
        img(512, 330, (u, v) => {
            if (v < 0.035) return [0.88, 0.86, 0.84];
            let c = mixc([0.95, 0.66, 0.46], [0.36, 0.44, 0.66], clamp(1 - v * 1.6));
            for (const [h, col] of [[0.55, [0.78, 0.46, 0.34]], [0.68, [0.58, 0.32, 0.27]], [0.82, [0.36, 0.2, 0.2]]]) {
                if (v > h + 0.05 * Math.sin(u * 7 + h * 9) + 0.03 * Math.sin(u * 17 + h * 4)) c = col.map((q) => q * (0.9 + 0.2 * (1 - v)));
            }
            const dock = v > 0.9 && v < 0.97 && Math.abs(u - 0.5) < 0.2;
            return dock ? mixc(c, [0.92, 0.9, 0.88], 0.5) : c;
        }),
    ),

    // the print above the bed: layered hills under a low sun on warm paper
    art: lazy(() =>
        img(512, 360, (u, v) => {
            const paper = [0.93, 0.89, 0.81].map((c) => c * (0.97 + 0.03 * fbm(u, v, 32, 24, 2, 95)));
            if (Math.hypot(u - 0.66, (v - 0.36) * 0.72) < 0.11) return [0.86, 0.56, 0.32];
            let c = paper;
            const layers = [[0.5, [0.79, 0.62, 0.42], 3], [0.6, [0.62, 0.67, 0.55], 5], [0.7, [0.75, 0.43, 0.3], 2], [0.82, [0.3, 0.37, 0.33], 4]];
            for (const [h, col, f] of layers) {
                if (v > h + 0.06 * Math.sin(u * f + h * 7) + 0.02 * Math.sin(u * 23 + h)) c = col.map((q) => q * (0.94 + 0.08 * fbm(u, v, 16, 12, 3, 97)));
            }
            return c;
        }),
    ),
    grass: lazy(() =>
        bake(1024, 1024, (u, v) => {
            const b = vn(u * 300, v * 300, 300, 300, 101), m = fbm(u, v, 4, 4, 4, 103), t = fbm(u, v, 40, 40, 3, 105);
            const c = mixc([0.2, 0.31, 0.1], [0.42, 0.55, 0.2], clamp(b * 0.5 + m * 0.5 + (t - 0.5) * 0.6));
            return { c: c.map((q, i) => q * (i == 0 ? 1 + 0.25 * (1 - m) : 1)), h: b * 0.5 + t * 0.3, r: 0.85 };
        }, 4),
    ),
    leaves: (dark, light, s) =>
        bake(512, 512, (u, v) => {
            const a = vn(u * 70, v * 70, 70, 70, s), b = vn(u * 140, v * 140, 140, 140, s + 1), m = fbm(u, v, 4, 4, 3, s + 2);
            const leaf = sstep(0.42, 0.62, a * 0.65 + b * 0.35);
            return { c: mixc(dark, light, leaf * (0.6 + 0.6 * m)).map((q) => q * (0.55 + 0.45 * leaf)), h: leaf, r: 0.75 };
        }, 6),
    bark: lazy(() =>
        bake(256, 256, (u, v) => {
            const f = Math.abs(Math.sin(u * TAU * 9 + fbm(u, v, 4, 2, 3, 111) * 6));
            return { c: [0.32, 0.27, 0.22].map((c) => c * (0.6 + 0.5 * f)), h: f, r: 0.95 };
        }, 6),
    ),
    stone: lazy(() => img(256, 256, (u, v) => [0.7, 0.68, 0.64].map((c) => c * (0.8 + 0.25 * fbm(u, v, 16, 16, 4, 113) - (vn(u * 90, v * 90, 90, 90, 115) > 0.85 ? 0.15 : 0))))),
    sky: lazy(() =>
        img(1024, 256, (u, v) => {
            const e = (1 - v) * 98 - 8, a = u * TAU, ce = Math.cos(e * D2R);
            const d = [ce * Math.cos(a), Math.sin(e * D2R), ce * Math.sin(a)], ang = Math.acos(clamp(-dot(d, SUN), -1, 1));
            let c = e < 0 ? [0.96, 0.7, 0.42] : mixc(mixc([1, 0.68, 0.34], [0.96, 0.8, 0.58], sstep(0, 16, e)), [0.52, 0.64, 0.8], sstep(16, 85, e));
            c = mixc(c, [1, 0.72, 0.38], 0.85 * Math.exp(-((ang / 0.45) ** 2)) + 0.55 * Math.exp(-((ang / 1.6) ** 2)));
            const cl = sstep(0.56, 0.78, fbm(u, v * 1.6, 14, 3, 5, 121)) * sstep(3, 12, e) * (1 - sstep(35, 60, e));
            return mixc(c, mixc([1, 0.86, 0.68], [1, 0.74, 0.46], Math.exp(-((ang / 0.8) ** 2))), cl * 0.7);
        }),
    ),

    // tree silhouettes with soft haze; alpha cuts the outline
    treeline: (col, s) =>
        img(1024, 128, (u, v) => {
            const x = u * 36 + 0.6 * fbm(u, 0, 6, 1, 2, s + 7), bump = Math.sqrt(Math.max(0, 1 - ((fract(x) - 0.5) * 2) ** 2));
            const top = 0.62 - 0.32 * fbm(u, 0, 6, 1, 4, s) - 0.14 * bump * (0.6 + 0.8 * hash(Math.floor(x), 0, s));
            return [...col.map((c) => c * (0.82 + 0.25 * (1 - v) + 0.05 * fbm(u, v, 48, 6, 2, s + 5))), v > top ? 1 : 0];
        }, 4),
    contact: lazy(() =>
        img(128, 128, (u, v) => {
            const f = (t) => sstep(0, 0.32, Math.min(t, 1 - t));
            return [0, 0, 0, 0.62 * f(u) * f(v)];
        }, 4),
    ),
    aoWall: lazy(() =>
        img(256, 256, (u, v) => {
            const o = (d, a, r) => 1 - a * Math.exp(-d / r);
            const g = o(u * 4, 0.38, 0.3) * o((1 - u) * 4, 0.38, 0.3) * o((1 - v) * 2.6, 0.42, 0.25) * o(v * 2.6, 0.3, 0.3);
            return [g, g, g];
        }),
    ),
    aoFloor: lazy(() =>
        img(256, 256, (u, v) => {
            const o = (d) => 1 - 0.4 * Math.exp(-d / 0.25);
            const g = o(u * 4) * o((1 - u) * 4) * o(v * 3.75) * o((1 - v) * 3.75);
            return [g, g, g];
        }),
    ),
};

// ---------- png ----------

const CRC = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc = (b) => {
    let c = ~0;
    for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
    return ~c >>> 0;
};
const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
};
const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// each row takes whichever filter leaves the smallest residuals, the usual png heuristic
const png = (t) => {
    if (t.png) return t.png;
    const { w, h, ch, d } = t, row = w * ch, raw = Buffer.alloc((row + 1) * h), out = new Uint8Array(row);
    for (let y = 0; y < h; y++) {
        let best = 0, bs = Infinity;
        for (let f = 0; f < 5; f++) {
            let s = 0;
            for (let i = 0; i < row; i++) {
                const r = filt(d, y, i, row, ch, f);
                s += r < 128 ? r : 256 - r;
            }
            if (s < bs) {
                bs = s;
                best = f;
            }
        }
        raw[y * (row + 1)] = best;
        for (let i = 0; i < row; i++) out[i] = filt(d, y, i, row, ch, best);
        raw.set(out, y * (row + 1) + 1);
    }
    const hd = Buffer.alloc(13);
    hd.writeUInt32BE(w, 0);
    hd.writeUInt32BE(h, 4);
    hd.set([8, ch == 4 ? 6 : 2, 0, 0, 0], 8);
    return (t.png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hd), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
};
const filt = (d, y, i, row, ch, f) => {
    const x = d[y * row + i], a = i >= ch ? d[y * row + i - ch] : 0, b = y ? d[(y - 1) * row + i] : 0, c = y && i >= ch ? d[(y - 1) * row + i - ch] : 0;
    switch (f) {
        case 0:
            return x;
        case 1:
            return (x - a) & 255;
        case 2:
            return (x - b) & 255;
        case 3:
            return (x - ((a + b) >> 1)) & 255;
        default:
            return (x - paeth(a, b, c)) & 255;
    }
};

// ---------- meshes ----------

const M = () => ({ p: [], n: [], t: [], i: [] });
const P = (m, k) => [m.p[k * 3], m.p[k * 3 + 1], m.p[k * 3 + 2]];

const grid = (nu, nv, f) => {
    const m = M();
    for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
            const v = f(i / nu, j / nv);
            m.p.push(...v.p);
            m.n.push(...(v.n ?? [0, 1, 0]));
            m.t.push(...(v.t ?? [i / nu, j / nv]));
        }
    }
    for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
            const a = j * (nu + 1) + i, c = a + nu + 1;
            m.i.push(a, c, a + 1, a + 1, c, c + 1);
        }
    }
    return m;
};

// winds each triangle to face away from point c, or along its vertex normals when c is omitted
const orient = (m, c) => {
    for (let k = 0; k < m.i.length; k += 3) {
        const a = m.i[k], b = m.i[k + 1], d = m.i[k + 2], pa = P(m, a), pb = P(m, b), pd = P(m, d);
        const f = cross(sub(pb, pa), sub(pd, pa));
        const ref = c ? sub(pa.map((x, q) => (x + pb[q] + pd[q]) / 3), c) : [0, 1, 2].map((q) => m.n[a * 3 + q] + m.n[b * 3 + q] + m.n[d * 3 + q]);
        if (dot(f, ref) < 0) {
            m.i[k + 1] = d;
            m.i[k + 2] = b;
        }
    }
    return m;
};

// area-weighted normals, welded across coincident vertices so uv seams stay smooth
const smooth = (m) => {
    const nv = m.p.length / 3, ks = new Array(nv), acc = new Map();
    for (let k = 0; k < nv; k++) ks[k] = `${Math.round(m.p[k * 3] * 1e4)},${Math.round(m.p[k * 3 + 1] * 1e4)},${Math.round(m.p[k * 3 + 2] * 1e4)}`;
    for (let k = 0; k < m.i.length; k += 3) {
        const v = [m.i[k], m.i[k + 1], m.i[k + 2]], [a, b, d] = v.map((q) => P(m, q)), f = cross(sub(b, a), sub(d, a));
        for (const q of v) {
            const s = acc.get(ks[q]);
            if (s) {
                s[0] += f[0];
                s[1] += f[1];
                s[2] += f[2];
            } else acc.set(ks[q], [...f]);
        }
    }
    for (let k = 0; k < nv; k++) {
        const n = norm(acc.get(ks[k]) ?? [0, 1, 0]);
        m.n[k * 3] = n[0];
        m.n[k * 3 + 1] = n[1];
        m.n[k * 3 + 2] = n[2];
    }
    return m;
};

const rotv = (v, r) => {
    let [x, y, z] = v, c = Math.cos(r[0] * D2R), s = Math.sin(r[0] * D2R);
    [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(r[1] * D2R);
    s = Math.sin(r[1] * D2R);
    [x, z] = [x * c + z * s, -x * s + z * c];
    c = Math.cos(r[2] * D2R);
    s = Math.sin(r[2] * D2R);
    [x, y] = [x * c - y * s, x * s + y * c];
    return [x, y, z];
};

// scale, rotate (degrees; x, then y, then z), then translate
const xf = (m, { s = 1, r = [0, 0, 0], t = [0, 0, 0] } = {}) => {
    const S = typeof s == 'number' ? [s, s, s] : s;
    for (let k = 0; k < m.p.length; k += 3) {
        const p = add(rotv([m.p[k] * S[0], m.p[k + 1] * S[1], m.p[k + 2] * S[2]], r), t);
        const n = norm(rotv([m.n[k] / S[0], m.n[k + 1] / S[1], m.n[k + 2] / S[2]], r));
        for (let z = 0; z < 3; z++) {
            m.p[k + z] = p[z];
            m.n[k + z] = n[z];
        }
    }
    if (S[0] * S[1] * S[2] < 0) {
        for (let k = 0; k < m.i.length; k += 3) [m.i[k + 1], m.i[k + 2]] = [m.i[k + 2], m.i[k + 1]];
    }
    return m;
};

const merge = (...ms) => {
    const m = M(), two = ms.some((x) => x.u2);
    if (two) m.u2 = [];
    for (const x of ms) {
        const o = m.p.length / 3;
        m.p = m.p.concat(x.p);
        m.n = m.n.concat(x.n);
        m.t = m.t.concat(x.t);
        m.i = m.i.concat(x.i.map((q) => q + o));
        if (two) m.u2 = m.u2.concat(x.u2 ?? Array.from({ length: (x.p.length / 3) * 2 }, () => 0.5));
    }
    return m;
};

// rounded box: each face is a grid on the cube, pulled onto the inner box plus a radius, so edges get even arcs
const rbox = (w, h, d, r, o = {}) => {
    const H = [w / 2, h / 2, d / 2], seg = o.seg ?? 4, sc = o.uv ?? 1, g = 'xyz'.indexOf(o.g ?? 'x');
    r = Math.min(r, ...H.map((x) => x * 0.98));
    const dv = Array.isArray(o.div) ? o.div : [o.div ?? 1, o.div ?? 1, o.div ?? 1];
    const ax = (k) => {
        const q = H[k] - r, e = Array.from({ length: seg + 1 }, (_, i) => r * Math.tan((i / seg) * (Math.PI / 4)));
        const mid = Array.from({ length: Math.max(dv[k] - 1, 0) }, (_, i) => -q + (2 * q * (i + 1)) / dv[k]);
        return [...e.slice().reverse().map((x) => -q - x), ...mid, ...e.map((x) => q + x)];
    };
    const parts = [];
    for (let f = 0; f < 3; f++) {
        for (const s of [-1, 1]) {
            const a = (f + 1) % 3, b = (f + 2) % 3, A = ax(a), B = ax(b), u = f == g ? (g + 1) % 3 : g, v = 3 - f - u;
            parts.push(
                grid(A.length - 1, B.length - 1, (i, j) => {
                    const c = [];
                    c[f] = s * H[f];
                    c[a] = A[Math.round(i * (A.length - 1))];
                    c[b] = B[Math.round(j * (B.length - 1))];
                    const inn = c.map((x, k) => clamp(x, -(H[k] - r), H[k] - r)), n = norm(sub(c, inn));
                    let p = inn.map((x, k) => x + n[k] * r);
                    const t = o.uvf ? o.uvf(p, n) : [p[u] * sc, p[v] * sc];
                    if (o.disp) {
                        const q = o.disp(p, n);
                        p = p.map((x, k) => x + n[k] * q);
                    }
                    return { p, n, t };
                }),
            );
        }
    }
    const m = orient(merge(...parts));
    return o.disp ? smooth(m) : m;
};

// lathe: profile [r, y] from bottom to top; a repeated point makes a crease
const lathe = (pr, o = {}) => {
    const seg = o.seg ?? 40, L = [0];
    for (let k = 1; k < pr.length; k++) L.push(L[k - 1] + Math.hypot(pr[k][0] - pr[k - 1][0], pr[k][1] - pr[k - 1][1]));
    const same = (a, b) => b && a[0] == b[0] && a[1] == b[1];
    const nr = pr.map((q, k) => {
        const prev = pr[k - 1] ?? q, next = pr[k + 1] ?? q;
        const [p0, p1] = same(q, next) ? [prev, q] : same(q, prev) ? [q, next] : [prev, next];
        const t = norm([p1[0] - p0[0], p1[1] - p0[1], 0]);
        return [t[1], -t[0]];
    });
    return orient(
        grid(seg, pr.length - 1, (i, j) => {
            const k = Math.round(j * (pr.length - 1)), a = i * TAU, [r, y] = pr[k], [nx, ny] = nr[k];
            return { p: [r * Math.cos(a), y, r * Math.sin(a)], n: norm([nx * Math.cos(a), ny, nx * Math.sin(a)]), t: [i * (o.us ?? 1), L[k] * (o.vs ?? 1)] };
        }),
    );
};

// tube along a polyline with parallel-transported frames; rad may vary along it (0..1)
const tube = (pts, rad, o = {}) => {
    const sides = o.sides ?? 10, n = pts.length;
    const T = pts.map((_, k) => norm(sub(pts[Math.min(k + 1, n - 1)], pts[Math.max(k - 1, 0)])));
    let N = norm(cross(T[0], Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const fr = T.map((t) => {
        N = norm(sub(N, t.map((c) => c * dot(N, t))));
        return [N, cross(t, N)];
    });
    const R = typeof rad == 'function' ? rad : () => rad;
    let L = 0;
    const len = pts.map((p, k) => (L += k ? Math.hypot(...sub(p, pts[k - 1])) : 0));
    return orient(
        grid(sides, n - 1, (i, j) => {
            const k = Math.round(j * (n - 1)), a = i * TAU, [n1, b1] = fr[k];
            const nn = n1.map((c, q) => c * Math.cos(a) + b1[q] * Math.sin(a)), r = R(j);
            return { p: pts[k].map((c, q) => c + nn[q] * r), n: nn, t: [i * (o.us ?? 1), len[k] * (o.vs ?? 1)] };
        }),
    );
};

// icosphere pushed out by f(dir) -> radius, for foliage, flowers and stones
const ico = (lv, f, uvk = 1) => {
    const g = (1 + Math.sqrt(5)) / 2;
    const v = [[-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0], [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g], [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]].map(norm);
    let fs = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < lv; s++) {
        const cache = new Map();
        const mid = (a, b) => {
            const k = a < b ? `${a},${b}` : `${b},${a}`;
            if (!cache.has(k)) {
                v.push(norm(v[a].map((c, i) => c + v[b][i])));
                cache.set(k, v.length - 1);
            }
            return cache.get(k);
        };
        fs = fs.flatMap(([a, b, c]) => {
            const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
            return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
        });
    }
    const m = M();
    for (const d of v) {
        const p = d.map((c) => c * f(d));
        m.p.push(...p);
        m.n.push(...d);
        m.t.push((p[0] + p[2] * 0.7) * uvk, p[1] * uvk);
    }
    m.i = fs.flat();
    return smooth(orient(m, [0, 0, 0]));
};

const quad = (w, d, o = {}) =>
    grid(o.nu ?? 1, o.nv ?? 1, (i, j) => ({ p: [mix(-w / 2, w / 2, i), 0, mix(-d / 2, d / 2, j)], n: [0, 1, 0], t: o.uv ? [mix(-w / 2, w / 2, i) * o.uv, mix(-d / 2, d / 2, j) * o.uv] : [i, j] }));
const up = (m) => orient(m);

// world-space planar uvs for architecture, so textures keep their scale across every wall
const wuv = (m, tile) => {
    for (let k = 0; k < m.p.length / 3; k++) {
        const p = P(m, k), n = [m.n[k * 3], m.n[k * 3 + 1], m.n[k * 3 + 2]].map(Math.abs);
        const [a, b] = n[0] > 0.5 ? [p[2], p[1]] : n[1] > 0.5 ? [p[0], p[2]] : [p[0], p[1]];
        m.t[k * 2] = a / tile;
        m.t[k * 2 + 1] = -b / tile;
    }
    return m;
};
const ao = (m, f) => {
    m.u2 = [];
    for (let k = 0; k < m.p.length / 3; k++) m.u2.push(...(f(P(m, k), [m.n[k * 3], m.n[k * 3 + 1], m.n[k * 3 + 2]]) ?? [0.5, 0.5]));
    return m;
};
const box = (x0, y0, z0, x1, y1, z1, r = 0.003, o = {}) => xf(rbox(x1 - x0, y1 - y0, z1 - z0, r, { seg: 1, ...o }), { t: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] });

// ---------- soft goods ----------

// a stuffed pillow: two puffed halves meeting at a piped seam, pinched at the corners
const pillow = (W, D, T, seed, tile) => {
    const edge = (a, b) => [((a * D) / 2) * (1 - 0.07 * (1 - b * b)), 0, ((b * W) / 2) * (1 - 0.05 * (1 - a * a))];
    const half = (s) =>
        smooth(
            orient(
                grid(40, 32, (i, j) => {
                    const a = i * 2 - 1, b = j * 2 - 1, [x, , z] = edge(a, b);
                    const fill = Math.sqrt(Math.max(0, (1 - a ** 4) * (1 - b ** 4)));
                    const lump = 1 + 0.09 * Math.sin(a * 3.1 + seed) * Math.sin(b * 2.3 + seed * 2);
                    const crease = 0.007 * Math.sin(a * b * 11 + seed) * (a * b) ** 2 + 0.003 * Math.sin(b * 19 + a * 3 + seed);
                    return { p: [x, s * (T / 2) * fill * lump * (s > 0 ? 1 : 0.7) + crease * fill, z], t: [x / tile, z / tile] };
                }),
                [0, 0, 0],
            ),
        );
    const loop = [];
    for (const [a0, b0, a1, b1] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
        for (let k = 0; k < 24; k++) loop.push(edge(mix(a0, a1, k / 24), mix(b0, b1, k / 24)));
    }
    loop.push(loop[0]);
    return merge(half(1), half(-1), tube(loop, 0.0055, { sides: 6, vs: 1 / tile }));
};

// cloth draped over a mattress top: rolls over a rounded edge, then hangs with folds that deepen as it falls
const drape = (o) => {
    const { s0, s1, W, y0, R, drop, foot, off = 0, loft, fold = 0.022, ph = 0, fl = 0.3, tile } = o;
    const S1 = s1 + (foot ? drop : 0), Tm = W + drop, Rr = R + off, q = (Math.PI / 2) * Rr;
    const at = (s, t) => {
        const ex = Math.max(0, s - s1), ez = Math.max(0, Math.abs(t) - W), e = Math.hypot(ex, ez);
        const bx = Math.min(s, s1), bz = clamp(t, -W, W), y = y0 + loft(bx, bz) + off;
        if (!e) return [s, y, t];
        const dx = ex / e, dz = (Math.sign(t) * ez) / e;
        const [h, v] = e < q ? [Rr * Math.sin(e / Rr), Rr * (1 - Math.cos(e / Rr))] : [Rr + (e - q) * fl, Rr + (e - q)];
        const c = ex && ez ? s1 + Math.atan2(ex, ez) * 0.3 : ez ? s : s1 + 0.47 + (W - Math.abs(t));
        const f = fold * sstep(q, q + 0.25, e) * Math.sin(c * 27 + 1.8 * Math.sin(c * 6.1 + ph) + ph);
        return [bx + dx * (h + f), Math.max(y - v, 0.04), bz + dz * (h + f)];
    };
    const m = grid(o.nu ?? 100, o.nv ?? 90, (i, j) => {
        const s = mix(s0, S1, i), t = mix(-Tm, Tm, j);
        return { p: at(s, t), t: [s / tile, t / tile] };
    });
    return { m: smooth(orient(m, [0, 0.2, 0])), at, Tm };
};
const edgeTube = (f, Tm, r, tile) => tube(Array.from({ length: 81 }, (_, k) => f(mix(-Tm, Tm, k / 80))), r, { sides: 8, vs: 1 / tile });

// ---------- materials ----------

const mat = (name, o) => ({ name, ...o });
const wn = lazy(() => mat('walnut', { c: T.walnut().c, n: T.walnut().n, rt: T.walnut().r, ns: 0.6 }));
const an = lazy(() => mat('ash', { c: T.ash().c, n: T.ash().n, rt: T.ash().r, ns: 0.6 }));
const MAT = {
    paint: mat('white paint', { color: [0.93, 0.92, 0.89, 1], rough: 0.42 }),
    brass: mat('brass', { color: [0.78, 0.58, 0.3, 1], rough: 0.28 }),
    linen: lazy(() => mat('white linen', { c: T.linen().c, n: T.linen().n, ns: 0.8, rough: 0.9 })),
};

// ---------- glb ----------

const tangents = (m) => {
    const nv = m.p.length / 3, tn = new Float64Array(nv * 3), bt = new Float64Array(nv * 3), out = [];
    for (let k = 0; k < m.i.length; k += 3) {
        const [a, b, c] = [m.i[k], m.i[k + 1], m.i[k + 2]], e1 = sub(P(m, b), P(m, a)), e2 = sub(P(m, c), P(m, a));
        const du1 = m.t[b * 2] - m.t[a * 2], dv1 = m.t[b * 2 + 1] - m.t[a * 2 + 1], du2 = m.t[c * 2] - m.t[a * 2], dv2 = m.t[c * 2 + 1] - m.t[a * 2 + 1];
        const det = du1 * dv2 - du2 * dv1;
        if (Math.abs(det) < 1e-12) continue;
        const r = 1 / det;
        for (const q of [a, b, c]) {
            for (let z = 0; z < 3; z++) {
                tn[q * 3 + z] += (e1[z] * dv2 - e2[z] * dv1) * r;
                bt[q * 3 + z] += (e2[z] * du1 - e1[z] * du2) * r;
            }
        }
    }
    for (let k = 0; k < nv; k++) {
        const n = [m.n[k * 3], m.n[k * 3 + 1], m.n[k * 3 + 2]], t0 = [tn[k * 3], tn[k * 3 + 1], tn[k * 3 + 2]];
        let t = sub(t0, n.map((c) => c * dot(n, t0)));
        if (Math.hypot(...t) < 1e-9) t = cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
        t = norm(t);
        out.push(...t, dot(cross(n, t), [bt[k * 3], bt[k * 3 + 1], bt[k * 3 + 2]]) < 0 ? -1 : 1);
    }
    return out;
};

const bounds = (ms) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of ms) {
        for (let k = 0; k < m.p.length; k++) {
            lo[k % 3] = Math.min(lo[k % 3], m.p[k]);
            hi[k % 3] = Math.max(hi[k % 3], m.p[k]);
        }
    }
    return [lo, hi];
};

const glb = (name, parts) => {
    const groups = new Map();
    for (const [m, mt] of parts) groups.set(mt, [...(groups.get(mt) ?? []), m]);
    const bin = [], json = {
        asset: { version: '2.0', generator: 'garden-bedroom build-glb' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name, mesh: 0 }],
        meshes: [{ name, primitives: [] }],
        materials: [],
        textures: [],
        images: [],
        samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
        accessors: [],
        bufferViews: [],
        buffers: [{ byteLength: 0 }],
    };
    let off = 0;
    const view = (buf, target) => {
        json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(target && { target }) });
        const pad = (4 - (buf.length % 4)) % 4;
        bin.push(buf, Buffer.alloc(pad));
        off += buf.length + pad;
        return json.bufferViews.length - 1;
    };
    const acc = (arr, type, size, ctype, target, mm) => {
        json.accessors.push({ bufferView: view(Buffer.from(arr.buffer), target), componentType: ctype, count: arr.length / size, type, ...mm });
        return json.accessors.length - 1;
    };
    const texIdx = new Map();
    const tex = (t) => {
        if (!texIdx.has(t)) {
            json.images.push({ bufferView: view(png(t)), mimeType: 'image/png' });
            json.textures.push({ sampler: 0, source: json.images.length - 1 });
            texIdx.set(t, json.textures.length - 1);
        }
        return { index: texIdx.get(t) };
    };
    let emissive = false;
    for (const [mt0, ms] of groups) {
        const mt = typeof mt0 == 'function' ? mt0() : mt0, m = merge(...ms), nv = m.p.length / 3;
        const [lo, hi] = bounds([m]);
        const at = {
            POSITION: acc(new Float32Array(m.p), 'VEC3', 3, 5126, 34962, { min: lo, max: hi }),
            NORMAL: acc(new Float32Array(m.n), 'VEC3', 3, 5126, 34962),
            TEXCOORD_0: acc(new Float32Array(m.t), 'VEC2', 2, 5126, 34962),
        };
        if (mt.n) at.TANGENT = acc(new Float32Array(tangents(m)), 'VEC4', 4, 5126, 34962);
        if (mt.ao) at.TEXCOORD_1 = acc(new Float32Array(m.u2 ?? Array.from({ length: nv * 2 }, () => 0.5)), 'VEC2', 2, 5126, 34962);
        const pbr = { baseColorFactor: mt.color ?? [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: mt.rt ? 1 : (mt.rough ?? 0.8) };
        if (mt.c) pbr.baseColorTexture = tex(mt.c);
        if (mt.rt) pbr.metallicRoughnessTexture = tex(mt.rt);
        const out = { name: mt.name, pbrMetallicRoughness: pbr };
        if (mt.n) out.normalTexture = { ...tex(mt.n), scale: mt.ns ?? 1 };
        if (mt.ao) out.occlusionTexture = { ...tex(mt.ao), texCoord: 1 };
        if (mt.e || mt.ef) {
            out.emissiveFactor = mt.ef ?? [1, 1, 1];
            if (mt.e) out.emissiveTexture = tex(mt.e);
            if (mt.es) {
                out.extensions = { KHR_materials_emissive_strength: { emissiveStrength: mt.es } };
                emissive = true;
            }
        }
        if (mt.double) out.doubleSided = true;
        if (mt.blend) out.alphaMode = 'BLEND';
        if (mt.mask) Object.assign(out, { alphaMode: 'MASK', alphaCutoff: 0.5 });
        json.materials.push(out);
        json.meshes[0].primitives.push({ attributes: at, indices: acc(new Uint32Array(m.i), 'SCALAR', 1, 5125, 34963), material: json.materials.length - 1 });
    }
    if (emissive) json.extensionsUsed = ['KHR_materials_emissive_strength'];
    const B = Buffer.concat(bin);
    json.buffers[0].byteLength = B.length;
    let J = Buffer.from(JSON.stringify(json));
    J = Buffer.concat([J, Buffer.alloc((4 - (J.length % 4)) % 4, 0x20)]);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(12 + 8 + J.length + 8 + B.length, 8);
    const ch = (b, type) => {
        const h = Buffer.alloc(8);
        h.writeUInt32LE(b.length, 0);
        h.writeUInt32LE(type, 4);
        return Buffer.concat([h, b]);
    };
    const file = Buffer.concat([head, ch(J, 0x4e4f534a), ch(B, 0x004e4942)]);

    // structural self-check: header, chunk lengths and every view inside the binary chunk
    const jl = file.readUInt32LE(12), bl = file.readUInt32LE(20 + jl), back = JSON.parse(file.subarray(20, 20 + jl).toString());
    if (file.readUInt32LE(8) != file.length || 28 + jl + bl != file.length || back.bufferViews.some((v) => v.byteOffset + v.byteLength > bl)) throw new Error(`${name}: malformed glb`);
    writeFileSync(join(OUT, `${name}.glb`), file);
    const [lo, hi] = bounds(parts.map(([m]) => m)), nv = parts.reduce((t, [m]) => t + m.p.length / 3, 0);
    console.log(`${name.padEnd(10)} ${(file.length / 1048576).toFixed(2).padStart(6)} MB  ${String(nv).padStart(7)} verts  ${json.images.length} images  [${lo.map((x) => x.toFixed(2))}] → [${hi.map((x) => x.toFixed(2))}]`);
};

// ---------- pieces ----------

mkdirSync(OUT, { recursive: true });

// room: interior faces at x ±2, z -1.75 (window wall) and z 2, floor y 0, ceiling 2.6
{
    const plaster = mat('plaster', { c: T.plaster().c, n: T.plaster().n, ns: 0.15, rough: 0.92, ao: T.aoWall() });
    const sage = mat('sage limewash', { c: T.sage(), n: T.plaster().n, ns: 0.15, rough: 0.92, ao: T.aoWall() });
    const ceil = mat('ceiling', { c: T.plaster().c, n: T.plaster().n, ns: 0.1, rough: 0.95, ao: T.aoFloor() });
    const oak = mat('oak boards', { c: T.oak().c, n: T.oak().n, rt: T.oak().r, ns: 0.35, ao: T.aoFloor() });
    const onWall = (p, n) => {
        const v = p[1] / 2.6;
        if (n[0] > 0.5 && Math.abs(p[0] + 2) < 1e-3) return [(p[2] + 1.75) / 3.75, 1 - v];
        if (n[0] < -0.5 && Math.abs(p[0] - 2) < 1e-3) return [(p[2] + 1.75) / 3.75, 1 - v];
        if (n[2] > 0.5 && Math.abs(p[2] + 1.75) < 1e-3) return [(p[0] + 2) / 4, 1 - v];
        if (n[2] < -0.5 && Math.abs(p[2] - 2) < 1e-3) return [(p[0] + 2) / 4, 1 - v];
    };
    const flat = (p, n) => (Math.abs(n[1]) > 0.5 ? [(p[0] + 2) / 4, (p[2] + 1.75) / 3.75] : undefined);
    // every room surface is one-sided and faces inward, so a camera that strays behind a wall or the ceiling sees through it
    const rect = (o, a, b, n) => orient(grid(1, 1, (i, j) => ({ p: o.map((c, k) => c + a[k] * i + b[k] * j), n })));
    const wall = (...a) => ao(wuv(rect(...a), 1.6), onWall);

    // invisible closed boxes behind the sunward walls and the ceiling still cast the sun's shadow, so light only enters at the window
    const blocker = mat('sun blocker', { color: [0, 0, 0, 0], blend: true, rough: 1 });
    glb('room', [
        [ao(wuv(rect([-2, 0, -1.75], [4, 0, 0], [0, 0, 3.75], [0, 1, 0]), 2), flat), oak],
        [ao(wuv(rect([-2, 2.6, -1.75], [4, 0, 0], [0, 0, 3.75], [0, -1, 0]), 1.6), flat), ceil],
        [wall([-2, 0, -1.75], [0, 0, 3.75], [0, 2.6, 0], [1, 0, 0]), sage],
        [
            merge(
                wall([2, 0, -1.75], [0, 0, 3.75], [0, 2.6, 0], [-1, 0, 0]),
                wall([-2, 0, 2], [4, 0, 0], [0, 2.6, 0], [0, 0, -1]),
                wall([-2, 0, -1.75], [2.3, 0, 0], [0, 2.6, 0], [0, 0, 1]),
                wall([1.5, 0, -1.75], [0.5, 0, 0], [0, 2.6, 0], [0, 0, 1]),
                wall([0.3, 0, -1.75], [1.2, 0, 0], [0, 0.9, 0], [0, 0, 1]),
                wall([0.3, 2.2, -1.75], [1.2, 0, 0], [0, 0.4, 0], [0, 0, 1]),
                wall([0.3, 0.9, -1.9], [0, 0, 0.15], [0, 1.3, 0], [1, 0, 0]),
                wall([1.5, 0.9, -1.9], [0, 0, 0.15], [0, 1.3, 0], [-1, 0, 0]),
                wall([0.3, 2.2, -1.9], [1.2, 0, 0], [0, 0, 0.15], [0, -1, 0]),
                wall([0.3, 0.9, -1.9], [1.2, 0, 0], [0, 0, 0.15], [0, 1, 0]),
            ),
            plaster,
        ],
        [merge(box(-2, 0, -1.75, -1.984, 0.1, 2, 0.005, { seg: 3 }), box(-1.984, 0, -1.75, 2, 0.1, -1.734, 0.005, { seg: 3 }), box(1.984, 0, -1.734, 2, 0.1, 2, 0.005, { seg: 3 }), box(-1.984, 0, 1.984, 1.984, 0.1, 2, 0.005, { seg: 3 })), MAT.paint],
        [merge(box(2, -0.05, -1.9, 2.15, 2.75, 2.15, 0.001, { seg: 1 }), box(-2.15, 2.6, -1.9, 2.15, 2.75, 2.15, 0.001, { seg: 1 }), box(-2.15, -0.05, -1.9, 0.3, 2.6, -1.75, 0.001, { seg: 1 }), box(1.5, -0.05, -1.9, 2, 2.6, -1.75, 0.001, { seg: 1 }), box(0.3, -0.05, -1.9, 1.5, 0.9, -1.75, 0.001, { seg: 1 }), box(0.3, 2.2, -1.9, 1.5, 2.6, -1.75, 0.001, { seg: 1 })), blocker],
    ]);
}

// window: origin at the centre of the 1.2 x 1.3 m opening, on the inside face of the wall; the wall runs to z -0.15
{
    const P2 = [];
    const bar = (x0, y0, z0, x1, y1, z1, r = 0.004) => P2.push(box(x0, y0, z0, x1, y1, z1, r, { seg: 2 }));
    bar(-0.6, -0.65, -0.11, -0.54, 0.65, -0.04);
    bar(0.54, -0.65, -0.11, 0.6, 0.65, -0.04);
    bar(-0.54, 0.59, -0.11, 0.54, 0.65, -0.04);
    bar(-0.54, -0.65, -0.11, 0.54, -0.59, -0.04);

    // two casements, each split into four lites by glazing bars
    for (const s of [-1, 1]) {
        const x0 = s < 0 ? -0.54 : 0.004, x1 = s < 0 ? -0.004 : 0.54, xm = (x0 + x1) / 2;
        bar(x0, -0.59, -0.1, x0 + 0.045, 0.59, -0.05);
        bar(x1 - 0.045, -0.59, -0.1, x1, 0.59, -0.05);
        bar(x0 + 0.045, 0.545, -0.1, x1 - 0.045, 0.59, -0.05);
        bar(x0 + 0.045, -0.59, -0.1, x1 - 0.045, -0.53, -0.05);
        bar(xm - 0.011, -0.53, -0.085, xm + 0.011, 0.545, -0.06, 0.003);
        bar(x0 + 0.045, 0.06, -0.085, x1 - 0.045, 0.082, -0.06, 0.003);
    }
    P2.push(xf(lathe([[0, 0], [0.012, 0], [0.014, 0.01], [0.006, 0.018], [0.006, 0.05], [0, 0.05]], { seg: 16 }), { r: [90, 0, 0], t: [-0.02, 0, -0.05] }));
    bar(-0.7, -0.685, -0.13, 0.7, -0.65, 0.06, 0.008);
    bar(-0.64, -0.75, 0, 0.64, -0.685, 0.018);
    bar(-0.67, -0.65, 0, -0.6, 0.72, 0.02);
    bar(0.6, -0.65, 0, 0.67, 0.72, 0.02);
    bar(-0.7, 0.65, 0, 0.7, 0.72, 0.022);
    glb('window', P2.map((m) => [m, MAT.paint]));
}

// curtains: rod and two gathered linen panels either side of the opening; origin as the window's, y at the floor
{
    const lin = mat('oat linen', { c: T.linenOat(), n: T.linen().n, ns: 0.6, rough: 0.92, double: true });
    const panel = (x0, x1, ph) =>
        smooth(
            orient(
                grid(80, 40, (i, j) => {
                    const x = mix(x0, x1, i), y = mix(2.38, 0.02, j), xc = (x0 + x1) / 2;
                    const z = 0.11 + (0.028 + 0.012 * j) * Math.sin(i * TAU * 6 + ph + 0.4 * Math.sin(i * 9 + ph)) + 0.01 * j * Math.sin(j * 4 + ph);
                    return { p: [x + (x - xc) * 0.12 * j * j, y, z], t: [(i * (x1 - x0) * 2.1) / 0.3, (2.38 - y) / 0.3] };
                }),
                [0, 1.2, -1],
            ),
        );
    const rod = xf(lathe([[0, 0], [0.012, 0], [0.012, 2.0], [0, 2.0]], { seg: 16 }), { r: [0, 0, -90], t: [-1.0, 2.42, 0.11] });
    const fin = (x) => xf(lathe([[0, 0], [0.016, 0.004], [0.022, 0.02], [0.016, 0.036], [0.004, 0.044], [0, 0.046]], { seg: 20 }), { r: [0, 0, x < 0 ? 90 : -90], t: [x, 2.42, 0.11] });
    const brk = (x) => box(x - 0.008, 2.405, 0, x + 0.008, 2.435, 0.11, 0.003, { seg: 2 });
    glb('curtains', [
        [panel(-1.0, -0.64, 0.3), lin],
        [panel(0.64, 1.0, 1.9), lin],
        [merge(rod, fin(-1.0), fin(1.0), brk(-0.9), brk(0.9)), MAT.brass],
    ]);
}

// bed: x runs head (-) to foot (+), origin at the floor under the frame's centre
{
    const lin = MAT.linen, blue = mat('blue linen', { c: T.linenBlue(), n: T.linen().n, ns: 0.8, rough: 0.9 });
    const rust = mat('rust linen', { c: T.linenRust(), n: T.linen().n, ns: 0.8, rough: 0.9 });
    const knit = mat('ochre knit', { c: T.knit().c, n: T.knit().n, ns: 1, rough: 0.95, double: true });
    const duv = mat('linen duvet', { c: T.linen().c, n: T.linen().n, ns: 0.8, rough: 0.92, double: true });
    const boucle = mat('sage boucle', { c: T.boucle().c, n: T.boucle().n, ns: 0.9, rough: 0.95 });
    const leg = (x, z) => xf(lathe([[0, 0], [0.018, 0], [0.019, 0.006], [0.022, 0.06], [0.027, 0.075], [0.027, 0.085], [0.024, 0.09], [0.028, 0.17], [0, 0.17]], { seg: 20, us: 0.2, vs: 2 }), { t: [x, 0, z] });
    const frame = merge(
        xf(rbox(2.125, 0.16, 0.05, 0.012, { uv: 1 / 0.6, g: 'x' }), { t: [0.0225, 0.25, 0.79] }),
        xf(rbox(2.125, 0.16, 0.05, 0.012, { uv: 1 / 0.6, g: 'x' }), { t: [0.0225, 0.25, -0.79] }),
        xf(rbox(0.05, 0.16, 1.63, 0.012, { uv: 1 / 0.6, g: 'z' }), { t: [1.06, 0.25, 0] }),
        leg(-1.0, 0.79), leg(-1.0, -0.79), leg(1.06, 0.79), leg(1.06, -0.79),
    );
    const head = xf(
        rbox(0.09, 1.08, 1.7, 0.04, {
            div: [1, 24, 84],
            uv: 1 / 0.2,
            g: 'z',
            disp: (p, n) => (n[0] > 0 ? -0.013 * (1 - Math.pow(Math.abs(Math.sin((Math.PI * (p[2] + 0.85)) / (1.7 / 7))), 0.5)) * n[0] ** 2 : 0),
        }),
        { t: [-1.045, 0.71, 0] },
    );
    const mattress = xf(rbox(1.98, 0.24, 1.52, 0.05, { uv: 1 / 0.3 }), { t: [0, 0.43, 0] });
    const loft = (s, t) => 0.045 + 0.014 * Math.sin(s * 4.2 + 0.6) * Math.cos(t * 3.1) + 0.006 * Math.sin(s * 11 + t * 7.3) - 0.012 * (t / 0.76) ** 4 + 0.01 * Math.exp(-((s - 0.35) ** 2 + (t + 0.25) ** 2) / 0.04);
    const base = { W: 0.76, y0: 0.55, R: 0.06, drop: 0.36, loft, tile: 0.3 };
    const duvet = drape({ ...base, s0: -0.22, s1: 0.99, foot: true });
    const turn = drape({ ...base, s0: -0.22, s1: 0.12, foot: false, off: 0.035, nu: 30 });
    const roll = edgeTube((t) => duvet.at(-0.22, t).map((c, k) => (c + turn.at(-0.22, t)[k]) / 2), duvet.Tm, 0.021, 0.3);
    const hem = edgeTube((t) => add(turn.at(0.12, t), [0, -0.006, 0]), turn.Tm, 0.008, 0.3);
    const throwT = drape({ ...base, s0: 0.5, s1: 0.92, drop: 0.46, foot: false, off: 0.024, fold: 0.018, ph: 2.2, fl: 0.36, tile: 0.25, nu: 40 });
    const throwHems = merge(...[0.5, 0.92].map((s) => edgeTube((t) => throwT.at(s, t), throwT.Tm, 0.009, 0.25)));
    const pil = (W, D, T, seed, x, y, z, rz, ry, tile = 0.3) => xf(pillow(W, D, T, seed, tile), { r: [0, ry, rz], t: [x, y, z] });
    glb('bed', [
        [frame, an],
        [head, boucle],
        [mattress, lin],
        [merge(duvet.m, turn.m, roll, hem), duv],
        [merge(pil(0.68, 0.5, 0.2, 1, -0.8, 0.8, 0.35, -68, 3), pil(0.68, 0.5, 0.2, 2.3, -0.8, 0.8, -0.35, -68, -4)), lin],
        [merge(pil(0.62, 0.45, 0.16, 3.7, -0.5, 0.74, 0.32, -42, -6), pil(0.62, 0.45, 0.16, 5.1, -0.5, 0.74, -0.31, -40, 5)), blue],
        [pil(0.5, 0.3, 0.13, 6.2, -0.25, 0.73, 0.02, -30, 2, 0.25), rust],
        [merge(throwT.m, throwHems), knit],
    ]);
}

// a cloth-bound book lying flat: boards, rounded spine and an inset page block; spine on -z
const book = (L, W, Th, cover) => [
    [merge(xf(rbox(L, 0.003, W, 0.0012, { uv: 1 / 0.1 }), { t: [0, 0.0015, 0] }), xf(rbox(L, 0.003, W, 0.0012, { uv: 1 / 0.1 }), { t: [0, Th - 0.0015, 0] }), xf(rbox(L, Th, 0.006, 0.0028, { uv: 1 / 0.1 }), { t: [0, Th / 2, -W / 2 + 0.003] })), cover],
    [xf(rbox(L - 0.008, Th - 0.006, W - 0.01, 0.001, { uvf: (p, n) => (Math.abs(n[1]) > 0.5 ? [p[0] * 10, p[2] * 10] : [(p[0] + p[2]) * 10, p[1] / 0.06]) }), { t: [0, Th / 2, 0.001] }), mat('pages', { c: T.pages(), rough: 0.8 })],
];
const place = (parts, o) => parts.map(([m, mt]) => [xf(m, o), mt]);
const COVERS = [mat('green cloth', { c: T.cloth([0.22, 0.32, 0.27], 131), rough: 0.7 }), mat('rust cloth', { c: T.cloth([0.6, 0.27, 0.19], 133), rough: 0.7 }), mat('navy cloth', { c: T.cloth([0.17, 0.21, 0.32], 135), rough: 0.7 }), mat('ochre cloth', { c: T.cloth([0.78, 0.6, 0.33], 137), rough: 0.7 })];

// bedside table: front faces +x, top at 0.58
{
    const tleg = (x, z) => xf(lathe([[0, 0], [0.011, 0], [0.016, 0.14], [0, 0.14]], { seg: 16, us: 0.15, vs: 2 }), { r: [z * -40, 0, x * 40], t: [x, 0, z] });
    const front = (y) => xf(rbox(0.012, 0.19, 0.42, 0.003, { g: 'z', uv: 1 / 0.6 }), { t: [0.203, y, 0] });
    const knob = (y) => xf(lathe([[0, 0], [0.006, 0], [0.006, 0.012], [0.014, 0.018], [0.012, 0.026], [0, 0.027]], { seg: 16 }), { r: [0, 0, -90], t: [0.209, y, 0] });
    glb('nightstand', [
        [merge(xf(rbox(0.4, 0.415, 0.46, 0.008, { g: 'z', uv: 1 / 0.6 }), { t: [0, 0.3475, 0] }), xf(rbox(0.42, 0.026, 0.48, 0.006, { g: 'z', uv: 1 / 0.6 }), { t: [0, 0.567, 0] }), tleg(0.17, 0.2), tleg(0.17, -0.2), tleg(-0.17, 0.2), tleg(-0.17, -0.2)), wn],
        [merge(front(0.255), front(0.455)), an],
        [merge(knob(0.255), knob(0.455)), MAT.brass],
        ...place(book(0.22, 0.15, 0.028, COVERS[0]), { r: [0, 18, 0], t: [0.04, 0.58, 0.1] }),
    ]);
}

// lamp: stoneware gourd, brass neck and harp, glowing linen drum shade; origin at its foot
{
    const glow = mat('lit linen shade', { c: T.linen().c, e: T.linen().c, ef: [1, 0.74, 0.47], es: 1.6, rough: 0.9, double: true });
    const shade = lathe([[0.17, 0.36], [0.145, 0.58]], { seg: 48, us: 3, vs: 3 });
    const ring = (r, y) => tube(Array.from({ length: 49 }, (_, k) => [r * Math.cos((k / 48) * TAU), y, r * Math.sin((k / 48) * TAU)]), 0.004, { sides: 6 });
    const harp = merge(...[0, 1, 2].map((k) => tube([[0, 0.43, 0], [0.145 * Math.cos((k * TAU) / 3), 0.575, 0.145 * Math.sin((k * TAU) / 3)]], 0.0025, { sides: 6 })));
    glb('lamp', [
        [lathe([[0, 0], [0.055, 0], [0.062, 0.008], [0.062, 0.008], [0.085, 0.06], [0.096, 0.12], [0.086, 0.19], [0.052, 0.25], [0.026, 0.28], [0.021, 0.29], [0, 0.29]], { seg: 48, us: 2, vs: 3 }), mat('stoneware', { c: T.ceramic(), rough: 0.25 })],
        [merge(lathe([[0, 0.288], [0.018, 0.288], [0.018, 0.3], [0.01, 0.31], [0.008, 0.42], [0.013, 0.43], [0.013, 0.44], [0, 0.445]], { seg: 24 }), harp, ring(0.145, 0.58), ring(0.17, 0.36)), MAT.brass],
        [shade, glow],
        [xf(ico(2, () => 0.03), { t: [0, 0.47, 0] }), mat('bulb', { color: [1, 0.95, 0.85, 1], ef: [1, 0.82, 0.6], es: 3, rough: 0.2 })],
    ]);
}

// desk: walnut top 1.2 x 0.6 at 0.75, splayed round legs with brass feet; front faces +z
{
    const legs = [], feet = [];
    for (const [x, z] of [[-0.52, -0.22], [0.52, -0.22], [-0.52, 0.22], [0.52, 0.22]]) {
        const o = { r: [-Math.sign(z) * 4, 0, Math.sign(x) * 4], t: [x, 0.68, z] };
        legs.push(xf(lathe([[0, -0.68], [0.016, -0.68], [0.016, -0.68], [0.03, 0], [0, 0]], { seg: 20, us: 0.15, vs: 1.5 }), o));
        feet.push(xf(lathe([[0, -0.685], [0.0165, -0.685], [0.0175, -0.64], [0, -0.64]], { seg: 20 }), o));
    }
    const drawer = xf(rbox(0.5, 0.055, 0.008, 0.003, { uv: 1 / 0.6 }), { t: [0, 0.68, 0.254] });
    const pull = tube([[-0.06, 0.668, 0.258], [-0.06, 0.668, 0.272], [0.06, 0.668, 0.272], [0.06, 0.668, 0.258]], 0.004, { sides: 8 });
    glb('desk', [
        [merge(xf(rbox(1.2, 0.032, 0.6, 0.008, { div: [6, 1, 3], uv: 1 / 1.0 }), { t: [0, 0.734, 0] }), xf(rbox(1.1, 0.08, 0.5, 0.004, { uv: 1 / 1.0 }), { t: [0, 0.678, 0] }), ...legs), wn],
        [drawer, an],
        [merge(pull, ...feet), MAT.brass],
    ]);
}

// laptop: aluminium base, hinge and lid open at 110 degrees with a lit screen; front faces +z
{
    const al = mat('aluminium', { color: [0.76, 0.77, 0.79, 1], rough: 0.32 });
    const H = [0, 0.012, -0.1075], lid = { r: [-110, 0, 0], t: H };
    const screen = orient(
        grid(1, 1, (i, j) => ({ p: [mix(-0.14, 0.14, i), -0.0032, mix(0.012, 0.192, j)], n: [0, -1, 0], t: [i, 1 - j] })),
    );
    glb('laptop', [
        [merge(xf(rbox(0.31, 0.012, 0.215, 0.005, { seg: 3 }), { t: [0, 0.006, 0] }), xf(xf(rbox(0.31, 0.006, 0.215, 0.004, { seg: 3 }), { t: [0, 0.003, 0.1075] }), lid)), al],
        [up(grid(1, 1, (i, j) => ({ p: [mix(-0.145, 0.145, i), 0.01205, mix(-0.1, 0.1, j)], n: [0, 1, 0], t: [i, j] }))), mat('keyboard', { c: T.keyboard(), rough: 0.4 })],
        [xf(screen, lid), mat('screen', { color: [0.02, 0.02, 0.025, 1], e: T.screen(), ef: [1, 1, 1], es: 0.9, rough: 0.1 })],
        [xf(lathe([[0, 0], [0.006, 0], [0.006, 0.25], [0, 0.25]], { seg: 12 }), { r: [0, 0, -90], t: [-0.125, 0.009, -0.103] }), mat('hinge', { color: [0.18, 0.18, 0.19, 1], rough: 0.5 })],
    ]);
}

// books stacked on the desk
glb('books', [
    ...place(book(0.26, 0.19, 0.034, COVERS[2]), { r: [0, -6, 0] }),
    ...place(book(0.23, 0.16, 0.026, COVERS[1]), { r: [0, 9, 0], t: [0.005, 0.034, 0.004] }),
    ...place(book(0.2, 0.14, 0.02, COVERS[3]), { r: [0, -2, 0], t: [-0.01, 0.06, -0.006] }),
]);

// mug of coffee
glb('mug', [
    [merge(lathe([[0, 0], [0.036, 0], [0.039, 0.004], [0.039, 0.004], [0.041, 0.09], [0.0405, 0.094], [0.037, 0.094], [0.036, 0.09], [0.035, 0.012], [0, 0.012]], { seg: 36 }), tube(Array.from({ length: 17 }, (_, k) => { const a = -Math.PI / 2 + (k / 16) * Math.PI; return [0.039 + 0.026 * Math.cos(a), 0.05 + 0.028 * Math.sin(a), 0]; }), 0.0055, { sides: 10 })), mat('teal glaze', { color: [0.2, 0.36, 0.38, 1], rough: 0.12 })],
    [lathe([[0.036, 0.072], [0, 0.072]], { seg: 24 }), mat('coffee', { color: [0.12, 0.07, 0.04, 1], rough: 0.05 })],
]);

// snake plant in a terracotta pot
{
    const r = rng(7), leaves = [];
    for (let k = 0; k < 8; k++) {
        const a = r() * TAU, d = r() * 0.03, h = 0.24 + r() * 0.2, lean = (r() - 0.5) * 16, tw = r() * 180;
        leaves.push(
            xf(
                orient(grid(4, 20, (i, j) => {
                    const w = 0.026 * Math.sin(Math.PI * Math.min(1, j * 0.92 + 0.08)) * (1 - j * 0.35), x = (i - 0.5) * w, c = 0.006 * Math.cos((i - 0.5) * Math.PI);
                    return { p: [x, j * h, c + 0.03 * j * j], n: [0, 0, 1], t: [i, j] };
                }), [0, 0.2, -0.2]),
                { r: [lean, tw, 0], t: [d * Math.cos(a), 0.118, d * Math.sin(a)] },
            ),
        );
    }
    glb('plant', [
        [lathe([[0, 0], [0.048, 0], [0.05, 0.004], [0.05, 0.004], [0.062, 0.115], [0.07, 0.117], [0.07, 0.117], [0.071, 0.138], [0.064, 0.138], [0.064, 0.138], [0.058, 0.12], [0, 0.12]], { seg: 36, us: 2, vs: 5 }), mat('terracotta', { c: T.terracotta(), rough: 0.9 })],
        [lathe([[0.058, 0.121], [0, 0.121]], { seg: 24, vs: 5 }), mat('soil', { c: T.soil(), rough: 1 })],
        [smooth(merge(...leaves)), mat('sansevieria', { c: T.sansevieria(), rough: 0.45, double: true })],
    ]);
}

// lounge chair: walnut frame with paddle arms, caramel leather seat and back cushions; faces -z, back at +z
{
    const leather = mat('caramel leather', { c: T.leather().c, n: T.leather().n, rt: T.leather().r, ns: 0.7 });

    // a cushion puffed out across the face whose normal runs along axis k
    const cushion = (w, h, d, k, amt) => {
        const H = [w / 2, h / 2, d / 2], [a, b] = [0, 1, 2].filter((q) => q != k);
        return rbox(w, h, d, 0.035, { div: [16, 16, 16], uv: 1 / 0.25, disp: (p, n) => amt * Math.max(0, 1 - (p[a] / H[a]) ** 2) * Math.max(0, 1 - (p[b] / H[b]) ** 2) * Math.abs(n[k]) });
    };
    const frame = [];
    for (const x of [-0.315, 0.315]) {
        const sx = Math.sign(x);
        frame.push(xf(lathe([[0, -0.565], [0.015, -0.565], [0.015, -0.565], [0.022, 0], [0, 0]], { seg: 18, us: 0.15, vs: 1.5 }), { r: [6, 0, sx * 3], t: [x, 0.565, -0.29] }));
        frame.push(tube([[x, 0, 0.335], [x, 0.3, 0.295], [x, 0.56, 0.3], [x, 0.72, 0.335], [x, 0.87, 0.395]], (j) => 0.022 - 0.006 * j, { sides: 14, vs: 1 / 0.6 }));
        frame.push(xf(rbox(0.075, 0.026, 0.66, 0.012, { g: 'z', div: [1, 1, 8], uv: 1 / 0.6 }), { t: [x, 0.578, -0.025] }));
        frame.push(xf(rbox(0.035, 0.05, 0.62, 0.008, { g: 'z', uv: 1 / 0.6 }), { t: [x, 0.27, 0] }));
    }
    frame.push(xf(rbox(0.66, 0.05, 0.035, 0.008, { uv: 1 / 0.6 }), { t: [0, 0.27, -0.3] }));
    frame.push(xf(rbox(0.66, 0.05, 0.035, 0.008, { uv: 1 / 0.6 }), { t: [0, 0.27, 0.3] }));
    frame.push(tube(Array.from({ length: 11 }, (_, k) => { const x = mix(-0.315, 0.315, k / 10); return [x, 0.85, 0.385 + 0.03 * (1 - (x / 0.315) ** 2)]; }), 0.017, { sides: 12, vs: 1 / 0.6 }));
    glb('chair', [
        [merge(...frame), wn],
        [merge(xf(cushion(0.58, 0.1, 0.56, 1, 0.02), { r: [4, 0, 0], t: [0, 0.345, -0.02] }), xf(cushion(0.56, 0.44, 0.09, 2, 0.022), { r: [16, 0, 0], t: [0, 0.64, 0.255] })), leather],
    ]);
}

// rug: 2.4 x 1.7 m flatweave with knotted fringe on the short ends
{
    const r = rng(11), fr = [];
    for (const s of [-1, 1]) {
        for (let k = 0; k < 56; k++) {
            const z = -0.8 + (k / 55) * 1.6, l = 0.06 + r() * 0.025, w = (r() - 0.5) * 0.02;
            fr.push(tube([[s * 1.2, 0.004, z], [s * (1.2 + l * 0.5), 0.003, z + w * 0.4], [s * (1.2 + l), 0.0025, z + w]], 0.0022, { sides: 4 }));
        }
    }
    glb('rug', [
        [xf(rbox(2.4, 0.012, 1.7, 0.004, { seg: 2, uvf: (p) => [(p[0] + 1.2) / 2.4, (p[2] + 0.85) / 1.7] }), { t: [0, 0.006, 0] }), mat('wool rug', { c: T.rug().c, n: T.rug().n, ns: 0.45, rough: 0.98 })],
        [merge(...fr), mat('wool fringe', { color: [0.86, 0.81, 0.71, 1], rough: 0.95 })],
    ]);
}

// framed print: hangs on the wall behind it (x = 0), facing +x
{
    const fm = [[0, 0.31, 0, 0.04, 0.86], [0, -0.31, 0, 0.04, 0.86], [0, 0, 0.41, 0.66, 0.04], [0, 0, -0.41, 0.66, 0.04]];
    glb('print', [
        [merge(...fm.map(([, y, z, h, w]) => xf(rbox(0.03, h, w, 0.005, { seg: 3, g: h > w ? 'y' : 'z', uv: 1 / 0.6 }), { t: [0.015, y, z] }))), wn],
        [xf(rbox(0.004, 0.58, 0.78, 0.0005, { seg: 1 }), { t: [0.01, 0, 0] }), mat('mat board', { color: [0.95, 0.94, 0.91, 1], rough: 0.9 })],
        [up(grid(1, 1, (i, j) => ({ p: [0.0125, mix(0.21, -0.21, j), mix(-0.3, 0.3, i)], n: [1, 0, 0], t: [1 - i, j] }))), mat('print', { c: T.art(), rough: 0.85 })],
    ]);
}

// contact shadow: a soft dark quad laid under furniture so it sits on the floor
glb('contact', [[up(quad(1, 1)), mat('contact shadow', { color: [0, 0, 0, 1], c: T.contact(), blend: true, rough: 1 })]]);

// garden, layered for the view through the window (about -8 to +12 degrees from the camera): sunlit lawn and border,
// a low box hedge, mid trees, far trees fading into warm haze, then two hazy tree lines under the sky
{
    const G = -0.15, r = rng(5);
    const HAZE = [0.94, 0.72, 0.48];
    const lawn = smooth(orient(grid(80, 60, (i, j) => {
        const x = mix(-30, 30, i), z = mix(-60, -1, j), far = sstep(4, 14, -z);
        return { p: [x, G + 0.25 * n3([x * 0.1, 0, z * 0.1], 2) * far, z], t: [x / 3, z / 3] };
    }), [0, -50, -20]));

    // backlit leaves glow: emission stands in for light passing through them and for sky bounce
    const grass = mat('lawn', { c: T.grass().c, n: T.grass().n, ns: 0.8, rough: 0.9, e: T.grass().c, ef: [0.5, 0.46, 0.3] });
    const hedgeT = T.leaves([0.12, 0.22, 0.08], [0.4, 0.52, 0.2], 141), hedgeM = mat('box hedge', { c: hedgeT.c, n: hedgeT.n, ns: 1, rough: 0.8, e: hedgeT.c, ef: [0.5, 0.48, 0.32] });
    const nearT = T.leaves([0.16, 0.26, 0.1], [0.5, 0.6, 0.24], 151), nearM = mat('mid foliage', { c: nearT.c, n: nearT.n, ns: 0.6, rough: 0.8, e: nearT.c, ef: [0.72, 0.68, 0.46] });
    const farT = T.leaves([0.46, 0.5, 0.38], [0.74, 0.74, 0.58], 155), farM = mat('far foliage', { color: [0.25, 0.25, 0.25, 1], c: farT.c, rough: 1, e: farT.c, ef: [0.95, 0.8, 0.6], es: 1.05 });
    const acerT = T.leaves([0.24, 0.07, 0.06], [0.56, 0.2, 0.13], 161), acerM = mat('acer leaves', { c: acerT.c, n: acerT.n, ns: 1, rough: 0.8, e: acerT.c, ef: [0.55, 0.42, 0.32] });
    const bark = mat('bark', { c: T.bark().c, n: T.bark().n, ns: 1, rough: 0.95, e: T.bark().c, ef: [0.3, 0.27, 0.22] });
    const farBark = mat('far bark', { color: [0.2, 0.2, 0.2, 1], c: T.bark().c, rough: 1, e: T.bark().c, ef: [0.85, 0.8, 0.7], es: 1.2 });
    const out = { near: [], far: [], acer: [], trunks: [], farTrunks: [] };
    const tree = (x, z, h, cs, crowns, trunks, s, rad = 0.17) => {
        const bend = [r() - 0.5, 0, r() - 0.5].map((c) => c * 0.6);
        trunks.push(tube(Array.from({ length: 8 }, (_, k) => [x + bend[0] * (k / 7) ** 2, G + (k / 7) * h, z + bend[2] * (k / 7) ** 2]), (j) => rad * (1 - 0.55 * j) * (1 + 0.4 * Math.exp(-j * 12)), { sides: 12, us: 1, vs: 1 / 1.5 }));
        for (const [cx, cy, cz, cr] of cs) {
            trunks.push(tube([[x + bend[0], G + h * 0.85, z + bend[2]], [x + cx * 0.7, G + cy - cr * 0.3, z + cz * 0.7]], (j) => rad * 0.45 * (1 - 0.6 * j), { sides: 8 }));
            crowns.push(xf(ico(3, (d) => cr * (1 + 0.2 * n3(d.map((c) => c * 2.2), s) + 0.08 * n3(d.map((c) => c * 6), s + 3)), 1 / 1.5), { s: [1, 0.82, 1], t: [x + cx, G + cy, z + cz] }));
        }
    };
    tree(-2.7, -13.5, 1.2, [[0.1, 1.8, 0, 0.9], [0.7, 1.55, 0.2, 0.62], [-0.5, 1.6, -0.1, 0.66], [0.2, 2.3, 0, 0.55]], out.acer, out.trunks, 5, 0.08);
    tree(-1.6, -23, 2.4, [[0, 3.4, 0, 1.65], [1.1, 3.0, 0.4, 1.2], [-1.0, 3.2, -0.2, 1.3], [0.3, 4.3, -0.3, 1.05]], out.near, out.trunks, 1);
    tree(-6.8, -19.5, 2.4, [[0, 3.2, 0, 1.6], [0.9, 2.9, 0.3, 1.1], [-0.3, 4.1, 0, 1.0]], out.near, out.trunks, 3);
    tree(5.5, -21, 3.0, [[0, 4.0, 0, 2.1], [-1.1, 3.6, 0.5, 1.5], [0.4, 5.1, 0, 1.4]], out.near, out.trunks, 4);
    tree(1.2, -34, 3.6, [[0, 5.2, 0, 3.0], [-1.8, 4.6, 0.5, 2.2], [1.9, 4.8, -0.2, 2.3]], out.far, out.farTrunks, 2, 0.22);
    tree(-4.8, -38, 3.4, [[0, 5.0, 0, 3.2], [1.8, 4.4, 0.3, 2.2], [-1.6, 4.3, 0, 2.1]], out.far, out.farTrunks, 6, 0.22);
    tree(-10.5, -31, 3.2, [[0, 4.6, 0, 2.8], [1.4, 4.0, 0.3, 2]], out.far, out.farTrunks, 7, 0.2);
    const flowers = { lav: [], white: [], pink: [], green: [] };
    for (let k = 0; k < 52; k++) {
        const x = -8 + r() * 12, z = -11.4 + r() * 0.6, rr = 0.12 + r() * 0.12, kind = ['lav', 'white', 'pink', 'green', 'green'][Math.floor(r() * 5)];
        flowers[kind].push(xf(ico(2, (d) => rr * (1 + 0.18 * n3(d.map((c) => c * 5), k % 7))), { s: [1, 0.8, 1], t: [x, G + 0.06 + rr * 0.6, z] }));
    }
    const fm = (name, rgb) => mat(name, { color: [...rgb, 1], rough: 0.7, ef: rgb.map((c) => c * 0.45) });
    const bath = xf(lathe([[0, 0], [0.16, 0], [0.16, 0.05], [0.09, 0.08], [0.07, 0.2], [0.065, 0.55], [0.09, 0.62], [0.28, 0.66], [0.3, 0.7], [0.27, 0.71], [0.22, 0.68], [0, 0.67]], { seg: 32, us: 2, vs: 2 }), { t: [0.1, G, -12.6] });
    const border = xf(rbox(13, 0.1, 0.9, 0.04, { uv: 1 / 1 }), { t: [-2, G + 0.02, -11.1] });
    const hedge = xf(rbox(18, 0.9, 0.7, 0.25, { div: [110, 6, 5], uv: 1 / 1.2, disp: (p) => 0.04 * n3(p.map((c) => c * 3), 1) + 0.02 * n3(p.map((c) => c * 9), 4) }), { t: [-2, G + 0.45, -16.5] });
    const line = (R, h, a0, a1) => orient(grid(160, 1, (i, j) => { const a = mix(a0, a1, i) * D2R; return { p: [R * Math.cos(a), G - 0.3 + j * h, R * Math.sin(a) - 2], n: [-Math.cos(a), 0, -Math.sin(a)], t: [i * 5, 1 - j] }; }));
    const sil = (name, col, s, es) => mat(name, { color: [0, 0, 0, 1], c: T.treeline([0, 0, 0], s), e: T.treeline(col, s), ef: [1, 1, 1], es, mask: true, double: true, rough: 1 });
    glb('garden', [
        [lawn, grass],
        [hedge, hedgeM],
        [merge(...out.near), nearM],
        [merge(...out.far), farM],
        [merge(...out.acer), acerM],
        [merge(...out.trunks), bark],
        [merge(...out.farTrunks), farBark],
        [merge(...flowers.lav), fm('lavender', [0.6, 0.5, 0.82])],
        [merge(...flowers.white), fm('white phlox', [0.95, 0.93, 0.88])],
        [merge(...flowers.pink), fm('pink cosmos', [0.92, 0.56, 0.62])],
        [merge(...flowers.green), fm('border shrub', [0.26, 0.42, 0.18])],
        [bath, mat('stone', { c: T.stone(), rough: 0.85, e: T.stone(), ef: [0.4, 0.38, 0.34] })],
        [border, mat('soil', { c: T.soil(), rough: 1, e: T.soil(), ef: [0.3, 0.3, 0.3] })],
        [line(36, 6, 200, 340), sil('near tree line', [0.68, 0.62, 0.44], 171, 1.1)],
        [line(54, 8.5, 195, 345), sil('far tree line', HAZE, 181, 1.3)],
    ]);
}

// sky: a dome glowing warm toward the low sun, emissive only so the lights leave it alone
glb('sky', [
    [
        orient(grid(96, 40, (i, j) => {
            const e = mix(-8, 90, j) * D2R, a = i * TAU, R = 95;
            return { p: [R * Math.cos(e) * Math.cos(a), R * Math.sin(e), R * Math.cos(e) * Math.sin(a)], n: [-Math.cos(e) * Math.cos(a), -Math.sin(e), -Math.cos(e) * Math.sin(a)], t: [i, 1 - j] };
        })),
        mat('sky', { color: [0, 0, 0, 1], e: T.sky(), ef: [1, 1, 1], es: 1.45, rough: 1, double: true }),
    ],
]);
