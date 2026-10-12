// viewer shell: the gallery at /code/artifacts and one artifact at /code/artifact/<id>.
// the artifact runs in a sandboxed frame on its own origin; everything it sends is untrusted.
const THEME_KEY = 'spatial-artifacts.theme';
const SEND_KEY = 'spatial-artifacts.send';
// the new-comment box: px from its anchor point and the page edges
const DRAFT_GAP = 8;
// a drawn area's capture, as a data: url; the daemon caps the decoded bytes at 1 MB
const IMAGE_MAX_CHARS = 1400000;
// reference images a comment or reply carries, and the long side, px, larger ones are scaled down to
const ATTACH_MAX = 4;
const ATTACH_PX = 1568;
// reload this long after a thread's working window ends
const STATUS_SLACK_MS = 500;
const PANEL_KEY = 'spatial-artifacts.panel';
const PANEL_W_KEY = 'spatial-artifacts.panel-width';
// the sidebar's width while dragged, px: its least, the least it leaves the page, and an arrow key's step
const PANEL_MIN = 280;
const FRAME_MIN = 320;
const PANEL_STEP = 16;
const THEMES = ['system', 'light', 'dark'];
const VIEW_KEY = 'spatial-artifacts.gallery-view';
const ANCHOR_RE = /^#[A-Za-z0-9._~-]{1,200}$/;
const INSIDE_MAX = 16;
// a touch screen taps to comment: no drag-drawn areas and no keyboard shortcuts
const TOUCH = matchMedia('(pointer: coarse)').matches;
// the header's presence circle: whether a Claude session linked to this artifact is there to hear comments
const PRESENCE = {
    watching: ['Claude is watching', 'Comments you send to Claude reach its session right away.'],
    open: ['Claude session open, not watching', 'Comments you send to Claude reach it with your next message there.'],
    none: [
        'No Claude session',
        'Paste this page’s URL into a Claude session to connect it; comments you send to Claude wait until then.',
    ],
};
const SANDBOX =
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-pointer-lock';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    home: 'M4 10.5L12 4l8 6.5|M6 9v11h12V9|M10 20v-5h4v5',
    chevron: 'M6 9l6 6 6-6',
    copy: 'M9 9h11v11H9z|M15 5V4H4v11h1',
    pin: 'M12 17v5|M9 3h6|M10 3v7l-4 4v3h12v-3l-4-4V3',
    shapes: 'M12 3l4 7H8z|M4 14h6v6H4z|M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    kebab: 'M12 5.5h.01|M12 12h.01|M12 18.5h.01',
    grid: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
    list: 'M9 6h11|M9 12h11|M9 18h11|M4.5 6h.01|M4.5 12h.01|M4.5 18h.01',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z|M20 20l-4-4',
    page: 'M14 3H6v18h12V7z|M14 3v4h4',
    shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z',
    external: 'M14 4h6v6|M20 4l-9 9|M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    comment: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z',
    panel: 'M4 5h16v14H4z|M15 5v14',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M12 2.5v2|M12 19.5v2|M5.3 5.3l1.4 1.4|M17.3 17.3l1.4 1.4|M2.5 12h2|M19.5 12h2|M5.3 18.7l1.4-1.4|M17.3 6.7l1.4-1.4',
    moon: 'M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z',
    system: 'M4 5h16v11H4z|M9 20h6|M12 16v4',
    trash: 'M4 7h16|M10 11v6|M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    close: 'M6 6l12 12|M18 6L6 18',
    reopen: 'M4 12a8 8 0 1 0 2.4-5.7L4 8.5|M4 4v4.5h4.5',
    reply: 'M9 14l-5-5 5-5|M4 9h10a6 6 0 0 1 6 6v4',

    // artifact icons: what a publish's `icon` word draws
    chart: 'M4 4v16h16|M8 16v-5|M12 16V8|M16 16v-3',
    calendar: 'M4 6h16v14H4z|M4 10h16|M8 3v4|M16 3v4',
    recipe: 'M7 3v18|M4 3v5a3 3 0 0 0 6 0V3|M17 21V3c-2.5 1-4 3.5-4 7v3h4',
    code: 'M8 7l-5 5 5 5|M16 7l5 5-5 5|M14 4l-4 16',
    map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z|M9 4v14|M15 6v14',
    table: 'M4 4h16v16H4z|M4 10h16|M4 15h16|M10 4v16',
    image: 'M4 4h16v16H4z|M4 16l5-5 4 4 3-3 4 4|M15.5 8.5h.01',
    game: 'M6 8h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.5 1.7L15 13H9l-1.5 1.7A3 3 0 0 1 2 13v-1a4 4 0 0 1 4-4z|M8 10v3|M6.5 11.5h3|M15 11h.01|M17.5 12.5h.01',
    music: 'M9 18V5l11-2v13|M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    video: 'M3 6h13v12H3z|M16 10l5-3v10l-5-3',
    book: 'M4 19V5a2 2 0 0 1 2-2h14v14H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14',
    todo: 'M4 6l1.5 1.5L8 5|M4 12l1.5 1.5L8 11|M4 18l1.5 1.5L8 17|M11 6h9|M11 12h9|M11 18h9',
    bed: 'M3 5v15|M3 16h18v4|M21 16v-3a3 3 0 0 0-3-3h-8v6|M6.5 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z|M4 7.5l8 4.5 8-4.5|M12 12v9',
    slides: 'M3 4h18|M4 4v11h16V4|M12 15v5|M9 20h6',
    form: 'M8 3h8v3H8z|M8 5H5v16h14V5h-3|M8 12h8|M8 16h5',
    mail: 'M3 5h18v14H3z|M3 6l9 7 9-7',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M4 21a8 8 0 0 1 16 0',
    money: 'M12 3v18|M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 7v5l3 2',
    star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z',
    idea: 'M9 18h6|M10 21h4|M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z',
    settings: 'M4 6h10|M18 4v4|M18 6h2|M4 12h4|M10 10v4|M12 12h8|M4 18h12|M18 16v4|M18 18h2',
    palette:
        'M12 3a9 9 0 0 0 0 18 2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.3h2.4A3.6 3.6 0 0 0 21 10.8C21 6.5 17 3 12 3z|M7.5 11h.01|M9.5 7h.01|M14.5 7h.01',
    heart: 'M12 20s-8-4.6-8-10.2A4.8 4.8 0 0 1 12 7a4.8 4.8 0 0 1 8 2.8C20 15.4 12 20 12 20z',
    cart: 'M3 4h2l2.4 11h10.2L20 8H6.2|M9 20h.01|M17 20h.01',
    diagram: 'M9 3h6v5H9z|M3 16h6v5H3z|M15 16h6v5h-6z|M12 8v4|M6 16v-4h12v4',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M3 12h18|M12 3a14 14 0 0 1 0 18|M12 3a14 14 0 0 0 0 18',
};

// an artifact's `icon` word, or a near word for it, to its glyph; any other word draws `page`
const ARTIFACT_ICONS = {
    page: 'doc document file report notes note text article memo writeup summary',
    chart: 'chart graph dashboard analytics stats data plot metrics',
    calendar: 'calendar schedule date event agenda',
    recipe: 'recipe food cook cooking kitchen meal restaurant',
    code: 'code dev terminal api script developer',
    map: 'map travel route trip location place',
    table: 'table spreadsheet sheet grid database',
    image: 'image photo picture gallery art illustration',
    game: 'game play puzzle arcade',
    music: 'music audio sound song',
    video: 'video film movie',
    book: 'book guide docs learn education story reading',
    todo: 'todo checklist tasks task tracker list',
    bed: 'bed bedroom hotel sleep',
    home: 'home house room interior',
    cube: 'cube 3d model scene box',
    slides: 'slides slide deck presentation',
    form: 'form survey poll quiz signup',
    mail: 'mail email letter newsletter',
    comment: 'chat message comment feedback',
    user: 'user profile person people team contact',
    money: 'money budget finance price pricing cost invoice',
    clock: 'clock time timer',
    star: 'star favorite review rating',
    idea: 'idea brainstorm lightbulb',
    settings: 'settings config tool tools',
    palette: 'palette color colors theme brand design',
    heart: 'heart health love',
    cart: 'cart shop store shopping',
    diagram: 'diagram flow flowchart architecture network',
    globe: 'globe web website world',
};
const ICON_OF = new Map(Object.entries(ARTIFACT_ICONS).flatMap(([k, words]) => words.split(' ').map((w) => [w, k])));
const glyph = (word) => {
    const w = String(word ?? '')
        .trim()
        .toLowerCase();
    return ICON_OF.get(w) ?? ICON_OF.get(w.replace(/s$/, '')) ?? 'page';
};

// filled glyphs: the claude spark, and the comment bubble while comment mode is on
const FILLED = {
    claude: [
        '0 0 100 100',
        'm19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z',
    ],
    commentOn: ['0 0 24 24', 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z'],
};

const root = document.documentElement;
const theme = () => {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'system';
};
const applyTheme = (t) => (t === 'system' ? delete root.dataset.theme : (root.dataset.theme = t));
applyTheme(theme());

const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) {
            continue;
        }
        if (k === 'class') {
            el.className = v;
        } else if (k.startsWith('on')) {
            el.addEventListener(k.slice(2), v);
        } else if (k === 'value' || k === 'checked' || k === 'disabled') {
            el[k] = v;
        } else {
            el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    el.append(...kids.flat(9).filter((x) => x != null && x !== false));
    return el;
};

const icon = (name) => {
    const s = document.createElementNS(SVG_NS, 'svg');
    const f = FILLED[name];
    if (f) {
        for (const [k, v] of Object.entries({
            viewBox: f[0],
            width: 16,
            height: 16,
            fill: 'currentColor',
            'aria-hidden': 'true',
        })) {
            s.setAttribute(k, v);
        }
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', f[1]);
        s.append(p);
        return s;
    }
    for (const [k, v] of Object.entries({
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
    })) {
        s.setAttribute(k, v);
    }
    for (const d of ICONS[name].split('|')) {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        s.append(p);
    }
    return s;
};

const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!Number.isFinite(s)) {
        return '';
    }
    if (s < 45) {
        return 'just now';
    }
    if (s < 3600) {
        return `${Math.max(1, Math.round(s / 60))}m ago`;
    }
    if (s < 86400) {
        return `${Math.round(s / 3600)}h ago`;
    }
    if (s < 7 * 86400) {
        return `${Math.round(s / 86400)}d ago`;
    }
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    });
};
const time = (iso) => h('time', { datetime: iso, title: new Date(iso).toLocaleString(), 'data-ago': true }, ago(iso));
setInterval(() => document.querySelectorAll('time[data-ago]').forEach((t) => (t.textContent = ago(t.dateTime))), 30000);

const tryCatch = (p) =>
    p.then(
        (r) => [null, r],
        (e) => [e],
    );
const api = async (path, method = 'GET', body) => {
    const r = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body && JSON.stringify(body),
    });
    if (!r.ok) {
        throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
    }
    return r.json();
};

const toast = (msg, kind) => {
    const t = h('div', { class: `toast${kind ? ` ${kind}` : ''}`, role: 'status' }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.classList.add('out'), 2800);
    setTimeout(() => t.remove(), 3200);
};

// a pasted, dropped or picked image as a data: url the daemon takes: a png, jpeg or webp that fits passes unchanged,
// anything else the browser decodes is scaled to ATTACH_PX and sent as a jpeg; null when it can't be read or made fit
const fitImage = async (file) => {
    const [e, bmp] = await tryCatch(createImageBitmap(file));
    if (e) {
        return null;
    }
    const side = Math.max(bmp.width, bmp.height);
    if (/^image\/(png|jpeg|webp)$/.test(file.type) && side <= ATTACH_PX && file.size * 1.4 < IMAGE_MAX_CHARS) {
        bmp.close();
        const r = new FileReader();
        return new Promise((done) => {
            r.onload = () => done(r.result);
            r.onerror = () => done(null);
            r.readAsDataURL(file);
        });
    }
    const k = Math.min(1, ATTACH_PX / side);
    const c = document.createElement('canvas');
    [c.width, c.height] = [Math.round(bmp.width * k), Math.round(bmp.height * k)];
    const g = c.getContext('2d');

    // a jpeg has no transparency: see-through pixels go white rather than black
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return (
        [0.9, 0.8, 0.65, 0.5].map((q) => c.toDataURL('image/jpeg', q)).find((u) => u.length <= IMAGE_MAX_CHARS) ?? null
    );
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const debounce = (fn, ms) => {
    let t;
    return () => (clearTimeout(t), (t = setTimeout(fn, ms)));
};

const setTheme = (t) => {
    localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
};

// one menu open at a time; it closes on a pick, Esc, a click elsewhere or focus moving into the frame
let closeMenu = null;
const openMenu = (trigger, kids, cls = '') => {
    closeMenu?.();
    const m = h('div', { class: `menu ${cls}`, role: 'menu' }, kids);
    document.body.append(m);
    const r = trigger.getBoundingClientRect();
    const x = cls.includes('end') ? r.right - m.offsetWidth : r.left;
    m.style.left = `${Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${r.bottom + 4}px`;
    trigger.setAttribute('aria-expanded', 'true');
    const items = () => [...m.querySelectorAll('.menu-item')];
    const off = (e) => {
        if (!m.contains(e.target) && !trigger.contains(e.target)) {
            close();
        }
    };
    const key = (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
            trigger.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const all = items();
            const k = all.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
            all.at(k % all.length)?.focus();
        }
    };
    const close = () => {
        m.remove();
        trigger.setAttribute('aria-expanded', 'false');
        removeEventListener('pointerdown', off, true);
        removeEventListener('keydown', key, true);
        removeEventListener('blur', close);
        closeMenu = null;
    };
    addEventListener('pointerdown', off, true);
    addEventListener('keydown', key, true);
    addEventListener('blur', close);
    closeMenu = close;
    items()[0]?.focus();
    return m;
};

const menuItem = (label, onPick, o = {}) =>
    h(
        o.href ? 'a' : 'button',
        {
            type: o.href ? null : 'button',
            href: o.href,
            target: o.target,
            rel: o.target && 'noopener noreferrer',
            class: `menu-item${o.danger ? ' danger' : ''}`,
            role: o.checked === undefined ? 'menuitem' : 'menuitemradio',
            'aria-checked': o.checked === undefined ? null : String(o.checked),
            onclick: (e) => {
                if (!o.keep) {
                    closeMenu?.();
                }
                onPick?.(e);
            },
        },
        o.icon && icon(o.icon),
        h('span', {}, label),
        o.end && h('span', { class: 'end' }, o.end),
    );
const menuSep = () => h('div', { class: 'menu-sep', role: 'separator' });

// delete asks once more inside the menu that offered it
const confirmDelete = (m, title, onDelete) =>
    m.replaceChildren(
        h(
            'div',
            { class: 'menu-head' },
            `Delete “${title}”? Its versions, comments and data go too. This can’t be undone.`,
        ),
        menuItem('Delete artifact', onDelete, { icon: 'trash', danger: true }),
        menuItem('Cancel', null),
    );

const themeItems = (onPick) => [
    h('div', { class: 'menu-label' }, 'Theme'),
    ...THEMES.map((t) =>
        menuItem(
            `${t[0].toUpperCase()}${t.slice(1)}`,
            () => {
                setTheme(t);
                onPick?.(t);
            },
            { checked: theme() === t },
        ),
    ),
];

const notice = (title, text, link) =>
    h(
        'div',
        { class: 'notice' },
        h('h2', {}, title),
        text && h('p', {}, text),
        link && h('a', { class: 'btn', href: '/code/artifacts' }, 'All artifacts'),
    );

// gallery

// list sections: today, then days of this month, then months
const dayGroup = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return 'Today';
    }
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString(undefined, {
        month: 'long',
        year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
};

const gallery = () => {
    document.title = 'Artifacts';
    const body = h('div', { class: 'gallery-body' });
    const search = h('input', {
        class: 'search',
        type: 'search',
        placeholder: 'Search artifacts',
        'aria-label': 'Search artifacts',
        hidden: true,
        oninput: () => render(),
        onkeydown: (e) => {
            if (e.key === 'Escape') {
                search.value = '';
                search.hidden = true;
                render();
            }
        },
    });
    let view = localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
    let list = [];

    const viewBtn = h('button', {
        type: 'button',
        class: 'iconbtn',
        onclick: () => setView(view === 'list' ? 'grid' : 'list'),
    });
    const setView = (v) => {
        view = v;
        localStorage.setItem(VIEW_KEY, v);
        viewBtn.replaceChildren(icon(v === 'list' ? 'grid' : 'list'));
        viewBtn.title = v === 'list' ? 'Grid view' : 'List view';
        viewBtn.setAttribute('aria-label', viewBtn.title);
        render();
    };

    const pin = async (a) => {
        const [e] = await tryCatch(api(`/api/a/${a.id}/pin`, 'POST', { on: !a.pinned }));
        if (e) {
            toast(`Couldn’t ${a.pinned ? 'unpin' : 'pin'}: ${e.message}`, 'error');
        }
    };
    const remove = async (a) => {
        const [e] = await tryCatch(api(`/api/a/${a.id}`, 'DELETE'));
        if (e) {
            return toast(`Couldn’t delete: ${e.message}`, 'error');
        }
        list = list.filter((x) => x.id !== a.id);
        render();
        toast('Artifact deleted');
    };
    const actions = (a) => (e) => {
        const m = openMenu(
            e.currentTarget,
            [
                menuItem(a.pinned ? 'Unpin' : 'Pin', () => pin(a), { icon: 'pin' }),
                menuItem('Copy link', () => copyLink(`${location.origin}/code/artifact/${a.id}`), { icon: 'copy' }),
                menuItem('Delete', () => confirmDelete(m, a.title, () => remove(a)), {
                    icon: 'trash',
                    danger: true,
                    keep: true,
                }),
            ],
            'sm end',
        );
    };

    const pinBtn = (a) =>
        h(
            'button',
            {
                type: 'button',
                class: `iconbtn pin-btn${a.pinned ? ' on' : ''}`,
                title: a.pinned ? 'Unpin' : 'Pin',
                'aria-label': `${a.pinned ? 'Unpin' : 'Pin'} ${a.title}`,
                'aria-pressed': String(!!a.pinned),
                onclick: () => pin(a),
            },
            icon('pin'),
        );
    const kebab = (a) =>
        h(
            'button',
            {
                type: 'button',
                class: 'iconbtn kebab',
                title: 'More',
                'aria-label': `More actions for ${a.title}`,
                'aria-haspopup': 'menu',
                onclick: actions(a),
            },
            icon('kebab'),
        );
    const link = (a) => h('a', { class: 'stretch', href: `/code/artifact/${a.id}` }, a.title || 'Untitled');
    const meta = (a) => [
        a.openThreads ? h('span', { class: 'open-count' }, plural(a.openThreads, 'open comment')) : null,
        a.openThreads ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
        h('span', {}, 'Updated ', time(a.updatedAt)),
    ];

    const row = (a) =>
        h(
            'li',
            { class: 'row-item', 'data-id': a.id },
            h('span', { class: 'tile', title: a.icon }, icon(glyph(a.icon))),
            h('span', { class: 'row-title' }, link(a)),
            h('span', { class: 'row-end' }, h('span', { class: 'row-meta' }, pinBtn(a), meta(a)), kebab(a)),
        );

    const card = (a) =>
        h(
            'li',
            { class: 'card', 'data-id': a.id },
            h('div', { class: 'thumb', 'aria-hidden': 'true' }, icon(glyph(a.icon))),
            h(
                'div',
                { class: 'card-body' },
                h('span', { class: 'badge', title: a.icon }, h('span', {}, icon(glyph(a.icon)))),
                h('h2', { class: 'card-title' }, link(a)),
                a.description && h('p', { class: 'card-desc' }, a.description),
                h('div', { class: 'card-meta' }, meta(a), pinBtn(a)),
            ),
            kebab(a),
        );

    const sections = (items) => {
        const groups = new Map();
        for (const a of items) {
            const g = a.pinned ? 'Pinned' : dayGroup(a.updatedAt);
            groups.set(g, [...(groups.get(g) ?? []), a]);
        }
        return [...groups].map(([g, xs]) =>
            h(
                'section',
                { class: 'group' },
                h('h2', {}, g),
                h('ul', { class: view === 'list' ? 'rows' : 'cards' }, xs.map(view === 'list' ? row : card)),
            ),
        );
    };

    const render = () => {
        const q = search.value.trim().toLowerCase();
        const items = list.filter((a) => !q || `${a.title} ${a.description ?? ''}`.toLowerCase().includes(q));
        body.replaceChildren(
            ...(items.length
                ? sections(items)
                : [
                      list.length
                          ? notice('No matches', `Nothing is titled “${search.value.trim()}”.`)
                          : notice('No artifacts yet', 'Ask Claude for a page and it appears here once published.'),
                  ]),
        );
    };

    const load = async () => {
        const [e, r] = await tryCatch(api('/api/artifacts'));
        if (e) {
            return body.replaceChildren(notice('Couldn’t load artifacts', e.message));
        }

        // pinned first, then newest
        list = r.sort(
            (a, b) => (b.pinned ?? '').localeCompare(a.pinned ?? '') || b.updatedAt.localeCompare(a.updatedAt),
        );
        render();
    };

    const searchBtn = h(
        'button',
        {
            type: 'button',
            class: 'iconbtn',
            title: 'Search',
            'aria-label': 'Search',
            onclick: () => {
                search.hidden = false;
                search.focus();
            },
        },
        icon('search'),
    );
    const themeBtn = h(
        'button',
        {
            type: 'button',
            class: 'iconbtn',
            title: 'Theme',
            'aria-label': 'Theme',
            'aria-haspopup': 'menu',
            onclick: (e) => openMenu(e.currentTarget, themeItems(), 'sm end'),
        },
        icon('system'),
    );

    setView(view);
    document.body.classList.add('gallery-page');
    document
        .getElementById('app')
        .replaceChildren(
            h(
                'main',
                { class: 'gallery' },
                h('header', { class: 'gallery-head' }, h('h1', {}, 'Artifacts')),
                h(
                    'div',
                    { class: 'gallery-tools' },
                    h('div', { class: 'spacer' }),
                    search,
                    searchBtn,
                    viewBtn,
                    themeBtn,
                ),
                body,
            ),
        );
    load();
    const refresh = debounce(load, 150);
    const es = new EventSource('/api/events');
    for (const ev of ['version', 'comments', 'deleted', 'pinned']) {
        es.addEventListener(ev, refresh);
    }
};

const copyLink = async (url) => {
    const [e] = await tryCatch(navigator.clipboard.writeText(url));
    toast(e ? 'Couldn’t copy the link' : 'Link copied', e ? 'error' : undefined);
};

// viewer

const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
const cleanAnchor = (a) => {
    if (!a || typeof a !== 'object') {
        return undefined;
    }
    const out = { path: str(a.path, 1024), label: str(a.label, 128), snippet: str(a.snippet, 200) };
    const quote = str(a.span && a.span.quote, 512);
    if (quote) {
        out.span = { quote };
    }
    const g = a.region;
    const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
    if (!quote && g && [g.x0, g.y0, g.x1, g.y1].every(unit) && g.x0 < g.x1 && g.y0 < g.y1) {
        out.region = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
        const inside = Array.isArray(a.inside)
            ? a.inside
                  .map((v) => str(v, 200))
                  .filter(Boolean)
                  .slice(0, INSIDE_MAX)
            : [];
        if (inside.length) {
            out.inside = inside;
        }
    }
    if (a.at && unit(a.at.x) && unit(a.at.y)) {
        out.at = { x: a.at.x, y: a.at.y };
    }
    if (
        typeof a.image === 'string' &&
        a.image.length <= IMAGE_MAX_CHARS &&
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(a.image)
    ) {
        out.image = a.image;
    }
    return JSON.parse(JSON.stringify(out));
};

// more anchors Shift+clicked into one comment, each cleaned like the first
const ALSO_MAX = 8;
const cleanAlso = (v) =>
    (Array.isArray(v) ? v.slice(0, ALSO_MAX) : [])
        .map((x) => cleanAnchor(x))
        .filter((x) => x?.path)
        .map(({ path, label, snippet, image }) => JSON.parse(JSON.stringify({ path, label, snippet, image })));

// the page reports where a draft's box goes, in its own viewport px
const validAt = (a) =>
    a && Number.isFinite(a.x) && Number.isFinite(a.y) ? { x: a.x, y: a.y, shown: a.shown === true } : null;

const viewer = async (id) => {
    const app = document.getElementById('app');
    const [err, meta] = await tryCatch(api(`/api/a/${id}`));
    if (err) {
        return app.replaceChildren(notice('Artifact not found', 'It may have been deleted.', true));
    }

    const S = {
        meta,
        view: null,
        loaded: null,
        latest: meta.ver,
        saving: new Set(),
        threads: [],
        mode: false,
        panel: localStorage.getItem(PANEL_KEY),
        draft: null,
        draftText: '',
        draftAt: null,
        draftImages: [],
        replies: new Map(),
        replyImages: new Map(),
        active: null,
        confirm: null,
        showResolved: false,
        send: localStorage.getItem(SEND_KEY) !== '0',
        gone: false,
    };
    const hash = ANCHOR_RE.test(location.hash) ? location.hash : '';
    const shown = () => S.view ?? S.meta.ver;
    const seqOf = (ver) => S.meta.versions.find((v) => v.ver === ver)?.seq;

    const frame = h('iframe', {
        title: meta.title,
        sandbox: SANDBOX,
        allow: 'fullscreen; screen-wake-lock',
        referrerpolicy: 'no-referrer',
    });
    const post = (msg) => !S.gone && frame.contentWindow?.postMessage({ da: 1, ...msg }, S.meta.frameOrigin);

    // header

    const title = h('span', { class: 'title' });
    const verTag = h('span', { class: 'ver' });
    const titleBtn = h(
        'button',
        { type: 'button', class: 'title-btn', 'aria-haspopup': 'menu', onclick: (e) => titleMenu(e.currentTarget) },
        title,
        verTag,
        icon('chevron'),
    );
    const modeBtn = h(
        'button',
        {
            type: 'button',
            class: 'split-main',
            'aria-pressed': 'false',
            'aria-keyshortcuts': 'C',
            'aria-label': 'Comment on this artifact',
            title: 'Comment on this artifact',
            onclick: () => setMode(!S.mode),
        },
        icon('comment'),
    );
    const countEl = h('span', { class: 'badge-count' });
    const panelBtn = h(
        'button',
        {
            type: 'button',
            class: 'split-more',
            title: 'More comment options',
            'aria-label': 'More comment options',
            'aria-haspopup': 'menu',
            onclick: (e) =>
                openMenu(
                    e.currentTarget,
                    [menuItem(S.panel ? 'Hide all comments' : 'Show all comments', () => setPanel(!S.panel))],
                    'sm end',
                ),
        },
        countEl,
        icon('chevron'),
    );
    const openLink = h(
        'a',
        {
            class: 'iconbtn',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Open in new tab',
            'aria-label': 'Open in new tab',
        },
        icon('external'),
    );
    const presenceText = h('span', { class: 'sr-only' });
    const presenceEl = h('span', { class: 'presence', role: 'status' }, icon('claude'), presenceText);
    const setPresence = (s) => {
        const [label, detail] = PRESENCE[s] ?? PRESENCE.none;
        presenceEl.dataset.state = PRESENCE[s] ? s : 'none';
        presenceEl.title = `${label}. ${detail}`;
        presenceText.textContent = label;
    };
    setPresence(meta.presence);
    const permBtn = h(
        'button',
        {
            type: 'button',
            class: 'iconbtn',
            title: 'Permissions',
            'aria-label': 'Permissions',
            onclick: () => openPerms(),
        },
        icon('shield'),
    );
    const header = h(
        'header',
        { class: 'bar', 'aria-label': 'Artifact controls' },
        h(
            'div',
            { class: 'bar-left' },
            h(
                'a',
                { class: 'iconbtn', href: '/code/artifacts', title: 'All artifacts', 'aria-label': 'All artifacts' },
                icon('home'),
            ),
            titleBtn,
        ),
        h(
            'div',
            { class: 'bar-right' },
            presenceEl,
            h('span', { class: 'split' }, modeBtn, panelBtn),
            permBtn,
            openLink,
        ),
    );

    const pickVersion = (ver) => {
        S.view = ver === S.meta.ver ? null : ver;
        loadFrame();
    };
    const titleMenu = (trigger) => {
        const vs = [...S.meta.versions].reverse();
        const m = openMenu(trigger, [
            h(
                'div',
                { class: 'menu-head' },
                h('div', {}, 'Artifact by you'),
                h('div', {}, `Updated ${ago(S.meta.updatedAt)}`),
            ),
            vs.length > 1 && [
                menuSep(),
                h('div', { class: 'menu-label' }, 'Versions'),
                vs.map((v) =>
                    menuItem(
                        [`Version ${v.seq}`, v.label && ` — ${v.label}`, v.by === 'page' && ' (saved from the page)']
                            .filter(Boolean)
                            .join(''),
                        () => pickVersion(v.ver),
                        { checked: v.ver === shown(), end: v.ver === S.meta.ver ? 'Latest' : ago(v.at) },
                    ),
                ),
            ],
            menuSep(),
            menuItem('Open in new tab', null, { icon: 'external', href: openLink.href, target: '_blank' }),
            menuItem('Copy link', () => copyLink(location.href), { icon: 'copy' }),
            menuItem(S.meta.pinned ? 'Unpin' : 'Pin', () => pinArtifact(), { icon: 'pin' }),
            menuItem('All artifacts', null, { icon: 'shapes', href: '/code/artifacts' }),
            menuSep(),
            themeItems((t) => post({ type: 'theme', theme: t })),
            menuSep(),
            menuItem('Delete artifact', () => confirmDelete(m, S.meta.title, deleteArtifact), {
                icon: 'trash',
                danger: true,
                keep: true,
            }),
        ]);
    };
    const pinArtifact = async () => {
        const [e, r] = await tryCatch(api(`/api/a/${id}/pin`, 'POST', { on: !S.meta.pinned }));
        if (e) {
            return toast(`Couldn’t ${S.meta.pinned ? 'unpin' : 'pin'}: ${e.message}`, 'error');
        }
        S.meta.pinned = r.pinned ? new Date().toISOString() : undefined;
        toast(r.pinned ? 'Pinned to the top of All artifacts' : 'Unpinned');
    };
    const deleteArtifact = async () => {
        const [e] = await tryCatch(api(`/api/a/${id}`, 'DELETE'));
        if (e) {
            toast(`Couldn’t delete: ${e.message}`, 'error');
        }
    };

    const renderHeader = () => {
        title.textContent = S.meta.title;
        titleBtn.title = S.meta.title;
        document.title = S.meta.title;

        // the tab icon is the artifact's icon word, drawn in clay
        const paths = ICONS[glyph(S.meta.icon)].split('|').map((d) => `<path d='${d}'/>`);
        document.querySelector('link[rel=icon]').href =
            `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='${SVG_NS}' viewBox='0 0 24 24' fill='none' stroke='#d97757' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${paths.join('')}</svg>`)}`;
        frame.title = S.meta.title;
        verTag.textContent = S.view ? `v${seqOf(S.view)}` : '';
        openLink.href = `${S.meta.frameOrigin}/v/${shown()}/`;
        permBtn.hidden = !consentable().length;
    };

    // consent: what the page may do as the viewer is asked here, in the viewer's own UI, and described from the artifact's
    // declaration as the daemon stores it, never from words the page sends. one dialog at a time

    const consentable = () => {
        const c = S.meta.capabilities ?? {};
        const out = [];
        if (c.comments && c.comments.composer_only !== true) {
            out.push('comments');
        }
        if (c.files) {
            out.push('files');
        }
        if (c.sample) {
            out.push('sample');
        }
        for (const x of Array.isArray(c.mcp?.servers) ? c.mcp.servers : []) {
            if (typeof x?.server === 'string') {
                out.push(`mcp:${x.server}`);
            }
        }
        return out;
    };
    const describe = (name) => {
        const c = S.meta.capabilities ?? {};
        if (name === 'comments') {
            return ['Comment as you', 'Post, resolve and delete comment threads on this artifact from the page.'];
        }
        if (name === 'files') {
            return ['Read project files', `Read files in ${c.files?.project || 'the project'} (never .git).`];
        }
        if (name === 'sample') {
            return [
                'Ask Claude',
                'Send prompts to Claude from the page. Each request is billed to your Anthropic API key.',
            ];
        }
        const srv = name.slice(4);
        const tools = (c.mcp?.servers ?? []).find((x) => x?.server === srv)?.tools ?? [];
        return [
            `Use ${srv.replace(/^host:/, '')}`,
            `Call these tools of your local MCP server ${srv.replace(/^host:/, '')} as you: ${tools.join(', ')}.`,
        ];
    };

    let askBox = null;
    const ask = (title, lines, yes = 'Allow', no = 'Don’t allow') =>
        new Promise((ok) => {
            if (askBox) {
                return ok('busy');
            }
            const done = (v) => {
                askBox?.remove();
                askBox = null;
                removeEventListener('keydown', esc, true);
                ok(v);
            };
            const esc = (e) => e.key === 'Escape' && (e.stopPropagation(), done('dismiss'));
            addEventListener('keydown', esc, true);
            const allow = h('button', { type: 'button', class: 'btn primary sm', onclick: () => done('allow') }, yes);
            askBox = h(
                'div',
                { class: 'save-box ask-box', role: 'alertdialog', 'aria-label': title },
                h('p', { class: 'save-name' }, title),
                ...lines.map((l) => (typeof l === 'string' ? h('p', {}, l) : l)),
                h(
                    'div',
                    { class: 'row' },
                    h('button', { type: 'button', class: 'btn ghost sm', onclick: () => done('deny') }, no),
                    allow,
                ),
            );
            document.body.append(askBox);
            allow.focus();
        });

    const setGrant = (name, on) => api(`/api/a/${id}/grants`, 'POST', { name, on });

    const onConsent = async (m) => {
        const want = (Array.isArray(m.names) ? m.names : []).filter(
            (n) => typeof n === 'string' && consentable().includes(n),
        );
        const [, g] = await tryCatch(api(`/api/a/${id}/grants`));
        const have = g?.grants ?? {};
        const asked = want.filter((n) => !(n in have));
        const states = Object.fromEntries(want.map((n) => [n, n in have ? 'granted' : 'prompt']));
        if (asked.length) {
            const lines = asked.map((n) => {
                const [t, d] = describe(n);
                return h('p', {}, h('b', {}, t), ` — ${d}`);
            });
            const v = await ask(`Allow “${S.meta.title}” to:`, [
                ...lines,
                h('p', { class: 'meta' }, 'Change this any time from the shield in the header.'),
            ]);
            for (const n of asked) {
                if (v === 'allow') {
                    const [e] = await tryCatch(setGrant(n, true));
                    states[n] = e ? 'prompt' : 'granted';
                } else {
                    states[n] = v === 'deny' ? 'denied' : v === 'busy' ? 'busy' : 'dismissed';
                }
            }
        }
        post({ type: 'consent-result', id: m.id, states });
    };

    // the page asks the viewer to confirm one action; what is shown comes from the request's kind, with the page's text quoted
    const quote = (v, n = 600) => h('pre', { class: 'ask-quote' }, String(v ?? '').slice(0, n));
    const onConfirm = async (m) => {
        let v = 'deny';
        if (m.kind === 'mcp-call') {
            v = await ask(
                `“${S.meta.title}” wants to run ${String(m.tool).slice(0, 128)} on ${String(m.server)
                    .replace(/^host:/, '')
                    .slice(0, 128)}`,
                [
                    'This tool is not marked read-only, so it may change things. Its input:',
                    quote(JSON.stringify(m.input ?? {}, null, 1), 1200),
                ],
                'Run it',
                'Cancel',
            );
            if (v === 'allow') {
                // the approval is the daemon's, for this exact call; the page only carries it
                const [e, r] = await tryCatch(
                    api(`/api/a/${id}/mcp-approve`, 'POST', { server: m.server, tool: m.tool, input: m.input }),
                );
                return post({
                    type: 'confirm-result',
                    id: m.id,
                    result: e ? 'error' : 'allow',
                    token: r?.token,
                    message: e?.message,
                });
            }
        } else if (m.kind === 'to-claude') {
            const label = typeof m.data?.label === 'string' ? m.data.label.slice(0, 120) : '';
            v = await ask(
                `Send this to Claude from “${S.meta.title}”${label ? ` — ${label}` : ''}?`,
                [
                    'Claude’s session linked to this artifact receives it as data from the page:',
                    quote(JSON.stringify(m.data, null, 1), 1200),
                ],
                'Send',
                'Cancel',
            );
            if (v === 'allow') {
                const [e, r] = await tryCatch(
                    api(`/api/a/${id}/to-claude`, 'POST', { data: m.data, presence: m.presence }),
                );
                return post({
                    type: 'confirm-result',
                    id: m.id,
                    result: e || r.error ? 'error' : 'allow',
                    code: r?.error?.code ?? (e ? 'upstream_error' : undefined),
                    message: r?.error?.message ?? e?.message,
                    sendId: r?.id,
                });
            }
        } else if (m.kind === 'file-download') {
            // the name and size come from the daemon, not the page
            const [e, st] = await tryCatch(api(`/api/a/${id}/files/stat?path=${encodeURIComponent(String(m.path))}`));
            if (e || st.error) {
                return post({
                    type: 'confirm-result',
                    id: m.id,
                    result: 'error',
                    code: st?.error?.code ?? 'unavailable',
                    message: st?.error?.message ?? e?.message,
                });
            }
            v = await ask(
                `Save a project file from “${S.meta.title}”?`,
                [h('p', { class: 'save-name' }, st.path, h('span', { class: 'meta' }, ` · ${st.size} bytes`))],
                'Save',
                'Cancel',
            );
            if (v === 'allow') {
                const a = h('a', {
                    href: `/api/a/${id}/files/raw?path=${encodeURIComponent(st.path)}`,
                    download: st.path.split('/').pop(),
                });
                document.body.append(a);
                a.click();
                a.remove();
            }
        }
        post({ type: 'confirm-result', id: m.id, result: v });
    };

    // the Permissions panel: every consentable capability the artifact declares, with its state, to allow or revoke
    let permsBox = null;
    const openPerms = async (fromPage = false) => {
        if (permsBox) {
            return false;
        }
        const [, g] = await tryCatch(api(`/api/a/${id}/grants`));
        const have = { ...(g?.grants ?? {}) };
        const rows = h('div', { class: 'perm-rows' });
        const draw = () =>
            rows.replaceChildren(
                ...consentable().map((n) => {
                    const [t, d] = describe(n);
                    const on = n in have;
                    return h(
                        'div',
                        { class: 'perm-row' },
                        h('div', {}, h('b', {}, t), h('p', { class: 'meta' }, d)),
                        h(
                            'button',
                            {
                                type: 'button',
                                class: `btn sm ${on ? 'ghost' : 'primary'}`,
                                onclick: async () => {
                                    const [e] = await tryCatch(setGrant(n, !on));
                                    if (e) {
                                        return toast(`Couldn’t change it: ${e.message}`, 'error');
                                    }
                                    if (on) {
                                        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- grants are keyed by capability
                                        delete have[n];
                                    } else {
                                        have[n] = {};
                                    }
                                    draw();
                                },
                            },
                            on ? 'Revoke' : 'Allow',
                        ),
                    );
                }),
            );
        draw();
        const close = () => {
            permsBox?.remove();
            permsBox = null;
            removeEventListener('keydown', esc, true);
            if (fromPage) {
                post({ type: 'manage-closed' });
            }
        };
        const esc = (e) => e.key === 'Escape' && (e.stopPropagation(), close());
        addEventListener('keydown', esc, true);
        permsBox = h(
            'div',
            { class: 'save-box perms-box', role: 'dialog', 'aria-label': 'Permissions' },
            h('p', { class: 'save-name' }, 'Permissions'),
            consentable().length ? rows : h('p', {}, 'This artifact asks for nothing that needs your permission.'),
            h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost sm', onclick: close }, 'Done')),
        );
        document.body.append(permsBox);
        return true;
    };

    // downloads: the page offers a file and the viewer confirms its final name and size here; one prompt at a time
    let saveBox = null;
    const askSave = (m) => {
        const reply = (x) => post({ type: 'download-result', id: m.id, ...x });
        if (!(m.blob instanceof Blob) || typeof m.filename !== 'string' || !m.filename) {
            return reply({ code: 'bad_request', message: 'no file' });
        }
        if (saveBox) {
            return reply({ code: 'rate_limited', message: 'a save prompt is already open' });
        }
        const name = m.filename.replace(/[\\/]/g, '_').slice(0, 240);
        const close = (x) => {
            saveBox?.remove();
            saveBox = null;
            reply(x);
        };
        const save = () => {
            const a = h('a', { href: URL.createObjectURL(m.blob), download: name });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            close({ status: 'saved' });
        };
        const b = m.blob.size;
        const size =
            b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} bytes`;
        const yes = h('button', { type: 'button', class: 'btn primary sm', onclick: save }, 'Save');
        saveBox = h(
            'div',
            { class: 'save-box', role: 'alertdialog', 'aria-label': 'Save a file from this artifact' },
            h('p', {}, 'This artifact offers a file to save:'),
            h('p', { class: 'save-name' }, name, h('span', { class: 'meta' }, ` · ${size}`)),
            h(
                'div',
                { class: 'row' },
                h(
                    'button',
                    {
                        type: 'button',
                        class: 'btn ghost sm',
                        onclick: () => close({ code: 'declined', message: 'the viewer declined the save' }),
                    },
                    'Cancel',
                ),
                yes,
            ),
        );
        document.body.append(saveBox);
        yes.focus();

        // the page stops waiting after two minutes, so the prompt goes too
        const box = saveBox;
        setTimeout(() => saveBox === box && close({ code: 'declined', message: 'the save prompt expired' }), 120000);
    };

    // frame

    const hint = h(
        'div',
        { class: 'mode-hint', hidden: true },
        ...(TOUCH
            ? ['Tap an element to comment']
            : [
                  'Click an element or drag across an area to comment',
                  h('kbd', {}, 'C'),
                  'or',
                  h('kbd', {}, 'Esc'),
                  'when done',
              ]),
    );
    // a new comment is written in a box at its anchor in the page; the sidebar only notes the draft
    const pop = h('section', { class: 'draft-pop', hidden: true, role: 'dialog', 'aria-label': 'New comment' });
    const frameWrap = h('div', { class: 'frame-wrap' }, frame, hint, pop);

    // the page asks for full screen; the frame goes with its comment box and hint, so commenting still works there
    // safari before 16.4 has only the prefixed api, and an iphone has none: the frame then fills the window instead
    const native = () => (document.fullscreenElement ?? document.webkitFullscreenElement) === frameWrap;
    const isFull = () => native() || frameWrap.classList.contains('filled');
    const fill = (on) => {
        frameWrap.classList.toggle('filled', on);
        post({ type: 'fullscreen', on });
    };
    const setFull = async (on) => {
        if (!on) {
            if (native()) {
                return tryCatch(
                    Promise.resolve((document.exitFullscreen ?? document.webkitExitFullscreen).call(document)),
                );
            }
            return fill(false);
        }
        const req = frameWrap.requestFullscreen ?? frameWrap.webkitRequestFullscreen;
        const [e] = req ? await tryCatch(Promise.resolve(req.call(frameWrap))) : [true];
        if (e) {
            fill(true);
        }
    };
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
        document.addEventListener(ev, () => post({ type: 'fullscreen', on: isFull() }));
    }

    const loadFrame = () => {
        const t = theme();
        S.loaded = shown();
        frame.src = `${S.meta.frameOrigin}/v/${S.loaded}/${t === 'system' ? '' : `?theme=${t}`}${hash}`;
        renderHeader();
    };

    // before the frame reloads to a new version, the page waits for a quiet moment, runs that version's preflight.js and keeps
    // its hot snapshot; a page whose runtime does not acknowledge within ACK_MS (it crashed) reloads at once, and none waits past READY_MS
    const ACK_MS = 1500;
    const READY_MS = 40000;
    let reloadWait = null;
    const beforeReload = (v) =>
        new Promise((ok) => {
            const done = () => (clearTimeout(a), clearTimeout(r), (reloadWait = null), ok());
            const a = setTimeout(done, ACK_MS);
            const r = setTimeout(done, READY_MS);
            reloadWait = { ver: v.ver, ack: () => clearTimeout(a), done };
            post({ type: 'before-reload', ver: v.ver });
        });

    const onVersion = async (save) => {
        const own = S.saving.delete(save);
        const [e, m] = await tryCatch(api(`/api/a/${id}`));
        if (e || S.gone || m.ver === S.latest) {
            return;
        }
        S.latest = m.ver;
        const v = m.versions.at(-1);

        // the frame already shows what it just saved
        if (own && S.view === null) {
            S.meta = m;
            S.loaded = m.ver;
            renderHeader();
        } else if (S.view === null) {
            await beforeReload(v);
            if (S.latest !== m.ver) {
                return;
            }
            S.meta = m;
            loadFrame();
            toast(`Updated to version ${v.seq}${v.by === 'page' ? ' (saved from the page)' : ''}`);
        } else {
            S.meta = m;
            renderHeader();
            toast(`Version ${v.seq} is available`);
        }
    };

    // comments panel

    const list = h('div', { class: 'threads' });
    const panelCount = h('span', { class: 'count' });

    // its left edge drags (or arrow keys step) the sidebar's width, kept across artifacts; a double-click resets it
    const setWidth = (w) => {
        if (w == null) {
            panel.style.removeProperty('--panel-w');
            localStorage.removeItem(PANEL_W_KEY);
        } else {
            const px = Math.round(Math.max(PANEL_MIN, Math.min(panel.parentElement.clientWidth - FRAME_MIN, w)));
            panel.style.setProperty('--panel-w', `${px}px`);
            localStorage.setItem(PANEL_W_KEY, String(px));
        }
        grip.setAttribute('aria-valuenow', String(panel.offsetWidth));
    };
    const grip = h('div', {
        class: 'panel-grip',
        role: 'separator',
        tabindex: 0,
        'aria-orientation': 'vertical',
        'aria-label': 'Resize comments',
        'aria-valuemin': PANEL_MIN,
        title: 'Drag to resize, double-click to reset',
        onpointerdown: (e) => {
            if (e.button !== 0) {
                return;
            }
            e.preventDefault();
            grip.setPointerCapture(e.pointerId);
            document.body.classList.add('resizing');
        },
        onpointermove: (e) =>
            grip.hasPointerCapture(e.pointerId) && setWidth(panel.getBoundingClientRect().right - e.clientX),
        onlostpointercapture: () => document.body.classList.remove('resizing'),
        ondblclick: () => setWidth(null),
        onkeydown: (e) => {
            const d = { ArrowLeft: PANEL_STEP, ArrowRight: -PANEL_STEP }[e.key];
            if (d) {
                e.preventDefault();
                setWidth(panel.offsetWidth + d);
            }
        },
    });
    const panel = h(
        'aside',
        { class: 'panel', 'aria-label': 'Comments' },
        grip,
        h(
            'div',
            { class: 'panel-head' },
            h('h2', {}, 'Comments'),
            panelCount,
            h('div', { class: 'spacer' }),
            h(
                'button',
                {
                    type: 'button',
                    class: 'iconbtn',
                    title: 'Close',
                    'aria-label': 'Close comments',
                    onclick: () => setPanel(false),
                },
                icon('close'),
            ),
        ),
        list,
    );

    const sorted = () => [...S.threads].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const numbers = () => new Map(sorted().map((t, i) => [t.id, i + 1]));

    const sendPins = () => {
        const n = numbers();
        post({
            type: 'pins',
            pins: S.panel
                ? S.threads
                      .filter((t) => !t.resolved_at && t.anchor?.path)
                      .map((t) => ({
                          tid: t.id,
                          n: n.get(t.id),
                          path: t.anchor.path,
                          region: t.anchor.region,
                          at: t.anchor.at,
                          snippet: t.anchor.snippet,
                          inside: t.anchor.inside,
                      }))
                : [],
        });

        // a page that places pins itself (comments customAnchors) hears every anchored thread, never its text
        post({
            type: 'threads',
            list: S.threads
                .filter((t) => t.anchor?.path)
                .map((t) => ({ tid: t.id, path: t.anchor.path, resolved: !!t.resolved_at, active: S.active === t.id })),
        });
    };

    const setPanel = (on) => {
        S.panel = !!on;
        localStorage.setItem(PANEL_KEY, S.panel ? '1' : '0');
        document.body.classList.toggle('panel-open', S.panel);
        sendPins();
    };

    // comment mode stays on across comments until the toggle, C or Esc turns it off
    const setMode = (on) => {
        S.mode = !!on;
        modeBtn.setAttribute('aria-pressed', String(S.mode));
        modeBtn.setAttribute('aria-label', S.mode ? 'Exit comment mode' : 'Comment on this artifact');
        modeBtn.title = S.mode ? 'Exit comment mode (C)' : 'Comment on this artifact (C)';
        modeBtn.replaceChildren(icon(S.mode ? 'commentOn' : 'comment'));
        if (!S.mode && S.draft) {
            closeDraft();
        }
        hint.hidden = !S.mode;
        post({ type: 'mode', on: S.mode });
        if (S.mode) {
            setPanel(true);
        }
        renderPanel();
    };

    const focusThread = (t, scroll) => {
        S.active = t.id;
        for (const el of list.querySelectorAll('.thread')) {
            el.classList.toggle('active', el.dataset.tid === t.id);
        }
        if (t.anchor?.path) {
            post({
                type: 'focus',
                tid: t.id,
                path: t.anchor.path,
                scroll,
                region: t.anchor.region,
                snippet: t.anchor.snippet,
                inside: t.anchor.inside,
                also: t.anchor.also,
            });
        }
    };

    const act = async (p, ok) => {
        const [e, r] = await tryCatch(p);
        if (e) {
            toast(e.message, 'error');
            return;
        }
        if (ok) {
            toast(ok);
        }
        await loadThreads();
        return r;
    };

    const setSend = (v) => {
        S.send = v;
        localStorage.setItem(SEND_KEY, v ? '1' : '0');
    };

    // a drawn area is tagged, with what it covers in the tag's tooltip
    const areaTag = (a) => [
        a?.region &&
            h(
                'span',
                { class: 'tag', title: a.inside?.join('\n') },
                a.inside?.length ? `Area · ${plural(a.inside.length, 'element')}` : 'Area',
            ),
        a?.also?.length > 0 &&
            h(
                'span',
                { class: 'tag', title: a.also.map((x) => x.label || x.snippet || x.path).join('\n') },
                `+${a.also.length} more`,
            ),
    ];

    // what a drawn area looked like: a thumbnail, shown larger on hover or focus in one floating preview,
    // since the comment box and the sidebar both clip their contents
    const preview = h('img', { class: 'shot-preview', alt: '', hidden: true });
    document.body.append(preview);
    let owner = null;

    // a rerender (submitting while hovering, a comment update) drops the thumbnail without a mouseleave, so the preview goes with it
    new MutationObserver(() => owner && !owner.isConnected && ((preview.hidden = true), (owner = null))).observe(
        document.body,
        { childList: true, subtree: true },
    );
    const shot = (src, title = 'What you saw here; Claude gets this image') => {
        const show = (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            owner = e.currentTarget;
            preview.src = src;
            preview.hidden = false;
            const [w, hgt] = [preview.offsetWidth, preview.offsetHeight];
            const left =
                r.left - w - DRAFT_GAP > 0
                    ? r.left - w - DRAFT_GAP
                    : Math.min(innerWidth - w - DRAFT_GAP, r.right + DRAFT_GAP);
            Object.assign(preview.style, {
                left: `${Math.max(DRAFT_GAP, left)}px`,
                top: `${Math.max(DRAFT_GAP, Math.min(innerHeight - hgt - DRAFT_GAP, r.top))}px`,
            });
        };
        const hide = () => ((preview.hidden = true), (owner = null));
        return h(
            'span',
            {
                class: 'shot',
                tabindex: 0,
                title,
                onmouseenter: show,
                onfocus: show,
                onmouseleave: hide,
                onblur: hide,
            },
            h('img', {
                src,
                alt: 'Captured view',
                onload: (e) =>
                    e.target.parentNode.matches(':hover, :focus') && show({ currentTarget: e.target.parentNode }),
            }),
        );
    };

    // a comment's captures side by side: its anchor's, then one per Shift-picked object that brought one
    const shots = (srcs, title) =>
        srcs.some(Boolean)
            ? h(
                  'div',
                  { class: 'shots' },
                  srcs.filter(Boolean).map((x) => shot(x, title)),
              )
            : '';

    // a comment box's reference images: `list` is the box's own array and `redraw` renders the box again. gives the
    // thumbnails (each with a remove button), the image button, and `wire`, which takes paste and drop on an element
    const attacher = (list, redraw) => {
        const add = async (files) => {
            const fs = [...files].filter((f) => f.type.startsWith('image/'));
            const room = ATTACH_MAX - list.length;
            if (fs.length > room) {
                toast(`A comment takes up to ${plural(ATTACH_MAX, 'image')}`);
            }
            const urls = await Promise.all(fs.slice(0, Math.max(0, room)).map(fitImage));
            if (urls.some((u) => !u)) {
                toast('That image couldn’t be attached', 'error');
            }
            list.push(...urls.filter(Boolean));
            redraw();
        };
        const pick = h('input', {
            type: 'file',
            accept: 'image/*',
            multiple: true,
            hidden: true,
            onchange: (e) => add(e.target.files),
        });
        const button = h(
            'button',
            {
                type: 'button',
                class: 'btn ghost attach',
                title: `Attach images (up to ${ATTACH_MAX}), or paste or drop them here`,
                'aria-label': 'Attach images',
                disabled: list.length >= ATTACH_MAX,
                onclick: () => pick.click(),
            },
            icon('image'),
            pick,
        );

        // '' rather than false: the new-comment box builds with replaceChildren, which would print false
        const strip = list.length
            ? h(
                  'div',
                  { class: 'shots attached' },
                  list.map((src, k) =>
                      h(
                          'span',
                          { class: 'pending' },
                          shot(src, 'Attached image; Claude gets it with the comment'),
                          h(
                              'button',
                              {
                                  type: 'button',
                                  class: 'unattach',
                                  title: 'Remove image',
                                  'aria-label': 'Remove image',
                                  onclick: () => (list.splice(k, 1), redraw()),
                              },
                              icon('close'),
                          ),
                      ),
                  ),
              )
            : '';
        const wire = (el, ta) => {
            ta.addEventListener('paste', (e) => {
                const fs = [...(e.clipboardData?.files ?? [])];
                if (fs.some((f) => f.type.startsWith('image/'))) {
                    e.preventDefault();
                    add(fs);
                }
            });
            el.addEventListener('dragover', (e) => {
                if (e.dataTransfer?.types.includes('Files')) {
                    e.preventDefault();
                    el.classList.add('dropping');
                }
            });
            el.addEventListener('dragleave', (e) => !el.contains(e.relatedTarget) && el.classList.remove('dropping'));
            el.addEventListener('drop', (e) => {
                el.classList.remove('dropping');
                if (e.dataTransfer?.files.length) {
                    e.preventDefault();
                    add(e.dataTransfer.files);
                }
            });
        };
        return { button, strip, wire };
    };

    const where = (a) => {
        const bits = [];
        if (a?.span?.quote) {
            bits.push(h('blockquote', { class: 'quote' }, a.span.quote));
        }
        if (a?.snippet) {
            bits.push(h('code', { class: 'snippet', title: a.snippet }, a.snippet));
        }
        return bits;
    };

    // a textarea with a send-to-claude checkbox; keeps its text across re-renders
    const editor = ({ key, placeholder, value, onInput, submit, cancel, label, images }) => {
        const ta = h('textarea', { rows: 3, placeholder, 'data-key': key, value });
        const box = h('input', { type: 'checkbox', checked: S.send });
        const go = h('button', { type: 'button', class: 'btn primary' });
        const sync = () => {
            go.replaceChildren(...(box.checked ? [icon('claude'), `${label} & send to Claude`] : [label]));
            go.disabled = !ta.value.trim();
        };
        const run = async () => {
            if (!ta.value.trim() || go.disabled) {
                return;
            }
            go.disabled = true;
            await submit(ta.value, box.checked);
            go.disabled = false;
        };
        ta.addEventListener('input', () => (onInput(ta.value), sync()));
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                run();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
            }
        });
        box.addEventListener('change', () => (setSend(box.checked), sync()));
        go.addEventListener('click', run);
        sync();
        const el = h(
            'div',
            { class: 'editor' },
            ta,
            images?.strip,
            h(
                'div',
                { class: 'editor-row' },
                images?.button,
                h('label', { class: 'check' }, box, 'Send to Claude'),
                h('div', { class: 'spacer' }),
                h('button', { type: 'button', class: 'btn ghost', onclick: cancel }, 'Cancel'),
                go,
            ),
        );
        images?.wire(el, ta);
        return el;
    };

    const draftNote = () =>
        h(
            'section',
            { class: 'composer', onclick: () => pop.querySelector('textarea')?.focus() },
            h(
                'div',
                { class: 'thread-head' },
                h('span', { class: 'num new' }, '+'),
                h('span', { class: 'where' }, S.draft.label || 'New comment'),
                h('div', { class: 'tags' }, areaTag(S.draft)),
            ),
            h('p', { class: 'hint' }, 'Writing a comment in the page…'),
        );

    // Enter repeats the last choice between Comment and Send to Claude; Shift+Enter is a new line; the corner grip resizes it
    const renderDraft = () => {
        post({ type: 'draft', open: !!S.draft, typed: !!S.draftText.trim() });
        document.body.classList.toggle('drafting', !!S.draft);
        if (!S.draft) {
            return ((pop.hidden = true), pop.replaceChildren());
        }
        const ta = h('textarea', {
            rows: 3,
            placeholder: 'Leave a comment…',
            'aria-label': 'Comment',
            value: S.draftText,
        });
        const plain = h('button', { type: 'button', class: `btn ${S.send ? 'ghost' : 'primary'}` }, 'Comment');
        const send = h(
            'button',
            { type: 'button', class: `btn ${S.send ? 'primary' : 'ghost'}` },
            icon('claude'),
            'Send to Claude',
        );
        const sync = () => {
            const off = !ta.value.trim();
            plain.disabled = off;
            send.disabled = off;
        };
        const run = async (toClaude) => {
            if (!ta.value.trim() || send.disabled) {
                return;
            }
            plain.disabled = true;
            send.disabled = true;
            setSend(toClaude);
            const { image, also, ...rest } = S.draft;
            const anchor = { ...rest, ...(also && { also: also.map(({ image: _, ...x }) => x) }) };
            const body = {
                text: ta.value,
                anchor,
                ver: shown(),
                toClaude,
                image,
                also_images: also?.map((x) => x.image ?? null),
                images: S.draftImages,
            };
            const t = await act(api(`/api/a/${id}/comments`, 'POST', body), toClaude ? 'Sent to Claude' : undefined);
            if (!t) {
                return sync();
            }
            S.active = t.id;
            closeDraft();
        };
        ta.addEventListener('input', () => {
            const was = !!S.draftText.trim();
            S.draftText = ta.value;
            sync();
            if (was !== !!S.draftText.trim()) {
                post({ type: 'draft', open: true, typed: !was });
            }
        });
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                run(S.send);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeDraft();
            }
        });
        plain.addEventListener('click', () => run(false));
        send.addEventListener('click', () => run(true));
        const att = attacher(S.draftImages, renderDraft);
        att.wire(ta, ta);
        pop.replaceChildren(
            h(
                'div',
                { class: 'thread-head' },
                h('span', { class: 'where' }, S.draft.label || 'New comment'),
                areaTag(S.draft),
            ),
            shots([S.draft.image, ...(S.draft.also ?? []).map((x) => x.image)]),
            ta,
            att.strip,
            h(
                'div',
                { class: 'editor-row' },
                att.button,
                h('button', { type: 'button', class: 'btn ghost', onclick: closeDraft }, 'Cancel'),
                h('div', { class: 'spacer' }),
                plain,
                send,
            ),
        );
        pop.hidden = false;
        placeDraft();
        sync();
        ta.focus();
    };

    // below the anchor point, flipped above it near the bottom, kept inside the page area
    // while the viewer drags the box's corner it only stays inside the page area, instead of snapping to its anchor
    let resizing = false;
    const placeDraft = () => {
        const at = S.draftAt;
        pop.style.visibility = at?.shown ? 'visible' : 'hidden';
        if (!at?.shown) {
            return;
        }
        const [w, hgt] = [frameWrap.clientWidth, frameWrap.clientHeight];
        const [pw, ph] = [pop.offsetWidth, pop.offsetHeight];
        const below = at.y + DRAFT_GAP;
        const [x, y] = resizing
            ? [pop.offsetLeft, pop.offsetTop]
            : [at.x, below + ph > hgt - DRAFT_GAP ? at.y - ph - DRAFT_GAP : below];
        pop.style.left = `${Math.max(DRAFT_GAP, Math.min(w - pw - DRAFT_GAP, x))}px`;
        pop.style.top = `${Math.max(DRAFT_GAP, Math.min(hgt - ph - DRAFT_GAP, y))}px`;
    };
    addEventListener('resize', placeDraft);

    // the box grows after it is placed (its capture loads, the viewer resizes it), so re-place it then
    new ResizeObserver(placeDraft).observe(pop);

    // a file dropped beside a comment box would open in this tab in place of the viewer, losing the draft
    for (const type of ['dragover', 'drop']) {
        addEventListener(type, (e) => e.dataTransfer?.types.includes('Files') && e.preventDefault());
    }
    pop.addEventListener('pointerdown', () => (resizing = true));
    addEventListener('pointerup', () => (resizing = false));

    const closeDraft = () => {
        // typing in the box took keyboard focus from the page; hand it back, so its keys (a 3d camera's W/A/S/D) work again
        if (pop.contains(document.activeElement)) {
            frame.focus();
        }
        S.draft = null;
        S.draftText = '';
        S.draftAt = null;
        S.draftImages = [];
        post({ type: 'focus', path: null });
        renderDraft();
        renderPanel();
    };

    // where Claude is on a thread sent to it, as a placeholder reply until it answers: queued for a session,
    // working, or overdue
    const pendingReply = (t) => {
        const s = !t.resolved_at && t.claude?.status;
        if (!s) {
            return null;
        }
        const text =
            s === 'working' ? 'Working on it…' : s === 'queued' ? 'Queued for a Claude session' : 'Hasn’t replied yet';
        return h(
            'li',
            { class: 'comment claude pending', role: 'status' },
            h('div', { class: 'comment-meta' }, h('span', { class: 'author' }, 'Claude')),
            h(
                'p',
                { class: 'text' },
                s === 'working' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('claude'),
                text,
            ),
        );
    };

    const replyImages = (tid) => S.replyImages.get(tid) ?? S.replyImages.set(tid, []).get(tid);

    const threadCard = (t, n) => {
        const base = `/api/a/${id}/comments/${t.id}`;
        const lastUser = t.comments.findLast((c) => c.author === 'user');
        const canSend = !t.resolved_at && lastUser && !lastUser.to_claude_at;
        const reply = S.replies.get(t.id);
        const head = h(
            'div',
            { class: 'thread-head' },
            h('span', { class: 'num' }, String(n)),
            h('span', { class: 'where' }, t.anchor?.label || (t.anchor?.path ? 'Element' : 'Page')),
            h(
                'div',
                { class: 'tags' },
                areaTag(t.anchor),
                t.ver && t.ver !== shown() && seqOf(t.ver) && h('span', { class: 'tag' }, `v${seqOf(t.ver)}`),
                t.resolved_at &&
                    h(
                        'span',
                        { class: 'tag' },
                        icon('check'),
                        t.resolved_by === 'claude' ? 'Resolved by Claude' : 'Resolved',
                    ),
            ),
        );
        const comments = h(
            'ol',
            { class: 'comments' },
            t.comments.map((c) =>
                h(
                    'li',
                    { class: `comment ${c.author}` },
                    h(
                        'div',
                        { class: 'comment-meta' },
                        h('span', { class: 'author' }, c.author === 'claude' ? 'Claude' : 'You'),
                        c.via === 'page' && h('span', { class: 'via' }, 'via the artifact'),
                        time(c.created_at),
                        c.to_claude_at && h('span', { class: 'sent' }, icon('claude'), 'Sent to Claude'),
                    ),
                    h('p', { class: 'text' }, c.text),
                    shots(
                        (c.images ?? []).map((_, k) => `/api/a/${id}/comments/${t.id}/attach/${c.id}/${k}`),
                        'Attached image; Claude gets it with the comment',
                    ),
                ),
            ),
            pendingReply(t),
        );
        const actions =
            S.confirm === t.id
                ? h(
                      'div',
                      { class: 'actions confirm' },
                      h('span', {}, 'Delete this thread?'),
                      h('div', { class: 'spacer' }),
                      h(
                          'button',
                          { type: 'button', class: 'btn ghost sm', onclick: () => ((S.confirm = null), renderPanel()) },
                          'Cancel',
                      ),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'btn danger sm',
                              onclick: () => ((S.confirm = null), act(api(base, 'DELETE'), 'Thread deleted')),
                          },
                          'Delete',
                      ),
                  )
                : h(
                      'div',
                      { class: 'actions' },
                      !t.resolved_at &&
                          h(
                              'button',
                              {
                                  type: 'button',
                                  class: 'act',
                                  onclick: () => (
                                      S.replies.set(t.id, reply ?? ''),
                                      renderPanel(),
                                      list.querySelector(`[data-key="r:${t.id}"]`)?.focus()
                                  ),
                              },
                              icon('reply'),
                              'Reply',
                          ),
                      canSend &&
                          h(
                              'button',
                              {
                                  type: 'button',
                                  class: 'act claude',
                                  onclick: () => act(api(`${base}/send`, 'POST'), 'Sent to Claude'),
                              },
                              icon('claude'),
                              'Send to Claude',
                          ),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'act',
                              onclick: () => act(api(`${base}/resolve`, 'POST', { resolved: !t.resolved_at })),
                          },
                          icon(t.resolved_at ? 'reopen' : 'check'),
                          t.resolved_at ? 'Reopen' : 'Resolve',
                      ),
                      h('div', { class: 'spacer' }),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'act danger',
                              title: 'Delete thread',
                              'aria-label': 'Delete thread',
                              onclick: () => ((S.confirm = t.id), renderPanel()),
                          },
                          icon('trash'),
                      ),
                  );
        const replyBox =
            reply !== undefined &&
            !t.resolved_at &&
            editor({
                key: `r:${t.id}`,
                label: 'Reply',
                placeholder: 'Reply…',
                value: reply,
                onInput: (v) => S.replies.set(t.id, v),
                cancel: () => (S.replies.delete(t.id), S.replyImages.delete(t.id), renderPanel()),
                images: attacher(replyImages(t.id), renderPanel),
                submit: async (text, toClaude) => {
                    const images = replyImages(t.id);
                    const r = await act(
                        api(base, 'POST', { text, toClaude, images }),
                        toClaude ? 'Sent to Claude' : undefined,
                    );
                    if (r) {
                        S.replies.delete(t.id);
                        S.replyImages.delete(t.id);
                        renderPanel();
                    }
                },
            });
        return h(
            'article',
            {
                class: `thread${S.active === t.id ? ' active' : ''}${t.resolved_at ? ' resolved' : ''}`,
                'data-tid': t.id,
                onclick: (e) => !e.target.closest('button, textarea, input, label, a') && focusThread(t, true),
            },
            head,
            where(t.anchor),
            shots([
                t.anchor?.image && `/api/a/${id}/comments/${t.id}/image`,
                ...(t.anchor?.also ?? []).map((x, i) => x.image && `/api/a/${id}/comments/${t.id}/image/${i + 1}`),
            ]),
            comments,
            actions,
            replyBox,
        );
    };

    const renderPanel = () => {
        // keep focus and caret in whichever editor the user is typing in
        const f = document.activeElement;
        const key = f?.dataset?.key;
        const sel = key && [f.selectionStart, f.selectionEnd];
        const n = numbers();
        const open = sorted().filter((t) => !t.resolved_at);
        const done = sorted().filter((t) => t.resolved_at);
        const kids = [];
        if (S.draft) {
            kids.push(draftNote());
        }
        if (S.mode && !S.draft) {
            kids.push(
                h(
                    'p',
                    { class: 'hint' },
                    TOUCH
                        ? 'Tap any element in the page to anchor a comment there.'
                        : 'Click any element in the page, or drag across an area of it, to anchor a comment there.',
                ),
            );
        }
        kids.push(...open.map((t) => threadCard(t, n.get(t.id))));
        if (!open.length && !S.draft && !S.mode) {
            kids.push(
                h(
                    'div',
                    { class: 'empty' },
                    h('p', {}, 'No open comments.'),
                    h(
                        'button',
                        { type: 'button', class: 'btn', onclick: () => setMode(true) },
                        icon('comment'),
                        'Comment on the page',
                    ),
                ),
            );
        }
        if (done.length) {
            const d = h(
                'details',
                { class: 'resolved-group', ontoggle: () => (S.showResolved = d.open) },
                h('summary', {}, `Resolved (${done.length})`),
                done.map((t) => threadCard(t, n.get(t.id))),
            );
            d.open = S.showResolved;
            kids.push(d);
        }
        list.replaceChildren(...kids);
        panelCount.textContent = open.length ? String(open.length) : '';
        countEl.textContent = open.length ? String(open.length) : '';
        if (key) {
            const el = list.querySelector(`[data-key="${CSS.escape(key)}"]`);
            if (el) {
                el.focus();
                el.setSelectionRange(...sel);
            }
        }
    };

    const loadThreads = async () => {
        const [e, r] = await tryCatch(api(`/api/a/${id}/comments`));
        if (e || S.gone) {
            return;
        }
        S.threads = r.threads;

        // "working" lapses to "waiting" at its deadline with no event, so reload then
        clearTimeout(S.statusTimer);
        const next = Math.min(...r.threads.map((t) => Date.parse(t.claude?.until ?? '')).filter(Number.isFinite));
        if (Number.isFinite(next)) {
            S.statusTimer = setTimeout(loadThreads, next - Date.now() + STATUS_SLACK_MS);
        }
        if (S.panel === null) {
            setPanel(r.threads.some((t) => !t.resolved_at) && innerWidth > 760);
        }
        renderPanel();
        sendPins();
    };

    // frame messages: only from this artifact's origin and this frame

    addEventListener('message', (e) => {
        if (e.origin !== S.meta.frameOrigin || e.source !== frame.contentWindow) {
            return;
        }
        const m = e.data;
        if (!m || m.da !== 1 || typeof m.type !== 'string') {
            return;
        }
        if (m.type === 'ready') {
            post({ type: 'theme', theme: theme() });
            post({ type: 'mode', on: S.mode });
            post({ type: 'fullscreen', on: isFull() });
            sendPins();
        } else if (m.type === 'anchor') {
            const a = cleanAnchor(m.anchor);
            if (!a?.path) {
                return;
            }
            const also = cleanAlso(m.also);
            if (also.length) {
                a.also = also;
            }
            S.draft = a;
            S.draftAt = validAt(m.at) ?? S.draftAt;
            setPanel(true);
            renderPanel();
            renderDraft();
        } else if (m.type === 'at') {
            if (!S.draft) {
                return;
            }
            S.draftAt = validAt(m.at);
            placeDraft();
        } else if (m.type === 'mode') {
            setMode(!!m.on);
        } else if (m.type === 'fullscreen') {
            setFull(m.on === true);
        } else if (m.type === 'dismiss') {
            dismiss();
        } else if (m.type === 'pin') {
            const t = S.threads.find((x) => x.id === m.tid);
            if (!t) {
                return;
            }
            setPanel(true);
            focusThread(t, false);
            list.querySelector(`[data-tid="${t.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else if (m.type === 'saving' && typeof m.save === 'string') {
            S.saving.add(m.save);
        } else if (m.type === 'reload-ack' && reloadWait?.ver === m.ver) {
            reloadWait.ack();
        } else if (m.type === 'reload-ready' && reloadWait?.ver === m.ver) {
            reloadWait.done();
        } else if (m.type === 'download') {
            askSave(m);
        } else if (m.type === 'consent') {
            onConsent(m);
        } else if (m.type === 'compose-check') {
            post({ type: 'compose-ok', id: m.id, ok: !(S.draft && S.draftText.trim()) });
        } else if (m.type === 'confirm') {
            onConfirm(m);
        } else if (m.type === 'manage') {
            openPerms(true).then((opened) => !opened && post({ type: 'manage-closed', refused: true }));
        }
    });

    // esc closes the draft first, then leaves comment mode; C toggles it when not typing (the page sends its own)
    const dismiss = () => {
        if (S.draft) {
            closeDraft();
        } else if (S.mode) {
            setMode(false);
        } else if (frameWrap.classList.contains('filled')) {
            fill(false);
        }
    };
    addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            return dismiss();
        }
        if (
            e.key.toLowerCase() === 'c' &&
            !e.repeat &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.target.closest?.('input, textarea, select, [contenteditable]')
        ) {
            setMode(!S.mode);
        }
    });

    const es = new EventSource(`/api/events/${id}`);
    es.addEventListener('version', (e) => onVersion(JSON.parse(e.data).save));
    es.addEventListener('comments', debounce(loadThreads, 100));
    es.addEventListener('presence', (e) => setPresence(JSON.parse(e.data).state));

    // a restarted daemon knows no sessions yet and sends no change, so reread on every (re)connect
    es.addEventListener('open', async () => {
        const [e, m] = await tryCatch(api(`/api/a/${id}`));
        if (!e) {
            setPresence(m.presence);
        }
    });
    es.addEventListener('deleted', () => {
        S.gone = true;
        es.close();
        document.title = 'Artifact deleted';
        document.body.classList.remove('viewer', 'panel-open');
        app.replaceChildren(notice('This artifact was deleted', null, true));
    });

    document.body.classList.add('viewer');
    app.replaceChildren(header, h('main', { class: 'stage' }, frameWrap, panel));
    const w = Number(localStorage.getItem(PANEL_W_KEY));
    if (w) {
        panel.style.setProperty('--panel-w', `${w}px`);
        grip.setAttribute('aria-valuenow', String(w));
    }
    if (S.panel !== null) {
        setPanel(S.panel === '1');
    }
    loadFrame();
    renderPanel();
    loadThreads();
};

const boot = () => {
    const m = location.pathname.match(/^\/code\/artifact\/([0-9a-f-]{36})\/?$/);
    if (m) {
        viewer(m[1]);
    } else {
        gallery();
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
