import { HLJS_SRC, MARKED_SRC, MERMAID_SRC, TITLE_SCAN_BYTES } from './constants.ts';

// the publish skeleton, byte for byte what the original tool wraps a page in
const RESET =
    ':root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}';
const RESET_NO_COVER =
    ':root{color-scheme:light}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}';
const HEAD = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${RESET}</style></head><body>`;
const HEAD_NO_COVER = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><style>${RESET_NO_COVER}</style></head><body>`;
const TAIL = '</body></html>';

const RUNTIME_OPEN = '<!-- frame-runtime -->';
const RUNTIME_CLOSE = '<!-- /frame-runtime -->';
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

const MERMAID_RUNTIME = `<script src="${MERMAID_SRC}"></script><script>(()=>{const dark=()=>{const t=document.documentElement.dataset.theme;return t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches};const blocks=[...document.querySelectorAll('pre.mermaid')];blocks.forEach(b=>{b.dataset.src=b.textContent});const render=async()=>{if(!window.mermaid)return;mermaid.initialize({startOnLoad:false,theme:dark()?'dark':'default',securityLevel:'strict'});for(const b of blocks){b.removeAttribute('data-processed');b.innerHTML='';b.textContent=b.dataset.src;b.classList.add('mermaid-diagram')}try{await mermaid.run({nodes:blocks})}catch(e){console.error('mermaid: '+(e&&e.message||e))}};render();matchMedia('(prefers-color-scheme: dark)').addEventListener('change',render);new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']})})()</script>`;

// hljs token colors are inlined: the frame csp refuses cdn stylesheets
const HLJS_CSS = `<style>.hljs{color:#24292e;background:transparent}.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#d73a49}.hljs-string,.hljs-attr .hljs-string,.hljs-regexp{color:#032f62}.hljs-number,.hljs-literal,.hljs-attr,.hljs-variable{color:#005cc5}.hljs-title,.hljs-title.function_,.hljs-section{color:#6f42c1}.hljs-comment,.hljs-quote{color:#6a737d;font-style:italic}.hljs-built_in,.hljs-name,.hljs-tag{color:#22863a}.hljs-meta{color:#735c0f}@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .hljs{color:#c9d1d9}:root:not([data-theme=light]) .hljs-keyword,:root:not([data-theme=light]) .hljs-selector-tag,:root:not([data-theme=light]) .hljs-type{color:#ff7b72}:root:not([data-theme=light]) .hljs-string,:root:not([data-theme=light]) .hljs-regexp{color:#a5d6ff}:root:not([data-theme=light]) .hljs-number,:root:not([data-theme=light]) .hljs-literal,:root:not([data-theme=light]) .hljs-attr,:root:not([data-theme=light]) .hljs-variable{color:#79c0ff}:root:not([data-theme=light]) .hljs-title,:root:not([data-theme=light]) .hljs-section{color:#d2a8ff}:root:not([data-theme=light]) .hljs-comment{color:#8b949e}:root:not([data-theme=light]) .hljs-built_in,:root:not([data-theme=light]) .hljs-name,:root:not([data-theme=light]) .hljs-tag{color:#7ee787}}:root[data-theme=dark] .hljs{color:#c9d1d9}:root[data-theme=dark] .hljs-keyword,:root[data-theme=dark] .hljs-selector-tag,:root[data-theme=dark] .hljs-type{color:#ff7b72}:root[data-theme=dark] .hljs-string,:root[data-theme=dark] .hljs-regexp{color:#a5d6ff}:root[data-theme=dark] .hljs-number,:root[data-theme=dark] .hljs-literal,:root[data-theme=dark] .hljs-attr,:root[data-theme=dark] .hljs-variable{color:#79c0ff}:root[data-theme=dark] .hljs-title,:root[data-theme=dark] .hljs-section{color:#d2a8ff}:root[data-theme=dark] .hljs-comment{color:#8b949e}:root[data-theme=dark] .hljs-built_in,:root[data-theme=dark] .hljs-name,:root[data-theme=dark] .hljs-tag{color:#7ee787}</style>`;
const HLJS_RUNTIME = `${HLJS_CSS}<script src="${HLJS_SRC}"></script><script>window.hljs&&document.querySelectorAll('code[class*="language-"]').forEach(c=>hljs.highlightElement(c))</script>`;

// the fixed document template for .md pages
const DOC_CSS = `:root{--bg:#faf9f5;--fg:#141413;--muted:#5e5d59;--rule:#e8e6dc;--code:#f0eee6;--accent:#c96442}@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1f1e1d;--fg:#f0eee6;--muted:#a3a198;--rule:#3d3c38;--code:#2b2a27;--accent:#d97757;color-scheme:dark}}:root[data-theme=dark]{--bg:#1f1e1d;--fg:#f0eee6;--muted:#a3a198;--rule:#3d3c38;--code:#2b2a27;--accent:#d97757;color-scheme:dark}body{background:var(--bg);color:var(--fg);font:16px/1.65 ui-serif,Georgia,"Times New Roman",serif}main{max-width:720px;margin:0 auto;padding:48px 20px 96px}h1,h2,h3,h4{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.25;margin:1.8em 0 .6em}h1{font-size:2em;margin-top:0}a{color:var(--accent)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.1em .35em;border-radius:4px}pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto}pre code{padding:0;background:none}blockquote{margin:1em 0;padding:0 1em;border-left:3px solid var(--rule);color:var(--muted)}table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid var(--rule);padding:6px 10px}hr{border:0;border-top:1px solid var(--rule);margin:2em 0}img{max-width:100%}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

const OVERLAY_RE = /<claude-overlay\b[^>]*>[\s\S]*?<\/claude-overlay>/gi;
const PRE_RE = /<pre\b((?:[^>"]|"[^"]*")*)>[\s\S]*?<\/pre>/gi;

// a rendered diagram goes back to the source the mermaid runtime kept in data-src
const unrender = (s: string) =>
    s.replace(PRE_RE, (m, attrs: string) => {
        const src = /\sdata-src="([^"]*)"/.exec(attrs)?.[1];
        if (src === undefined) {
            return m;
        }
        const rest = attrs.replace(/\s(?:data-src|data-processed)="[^"]*"/g, '').replace(/\s*\bmermaid-diagram\b/, '');
        return `<pre${rest}>${src
            .replace(/&quot;/g, '"')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</pre>`;
    });

/** strips a skeleton the page already carries: the exact one, or the live dom of a page that republished itself */
export const unwrap = (html: string) => {
    let s = html.replace(new RegExp(`${RUNTIME_OPEN}[\\s\\S]*?${RUNTIME_CLOSE}`, 'g'), '');
    for (const head of [HEAD, HEAD_NO_COVER]) {
        if (s.startsWith(head)) {
            s = s.slice(head.length);
            if (s.endsWith(TAIL)) {
                s = s.slice(0, -TAIL.length);
            }
            return s.replace(/^\n/, '').replace(/\n$/, '');
        }
    }

    // outerHTML: no doctype, quoted attributes, the runtime's overlay after <body>
    const i = [RESET, RESET_NO_COVER].map((r) => s.indexOf(`<style>${r}</style>`)).find((n) => n >= 0);
    const b = i === undefined ? null : /<body[^>]*>/i.exec(s.slice(i));
    if (i === undefined || !b) {
        return s;
    }
    s = s
        .slice(i + b.index + b[0].length)
        .replace(OVERLAY_RE, '')
        .replace(/<\/body>\s*<\/html>\s*$/i, '');
    return unrender(s).replace(/^\n/, '').replace(/\n$/, '');
};

/** title from a <title> in the first 8 KB, before any <svg> */
export const findTitle = (page: string) => {
    const head = page.slice(0, TITLE_SCAN_BYTES);
    const svg = head.search(/<svg[\s>]/i);
    const m = (svg >= 0 ? head.slice(0, svg) : head).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const t = m?.[1].replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 280) : undefined;
};

export const detect = (page: string) => ({
    mermaid: /<pre[^>]*class=["'][^"']*\bmermaid\b/i.test(page),
    highlight: /<code[^>]*class=["'][^"']*\blanguage-[a-z0-9+#-]+/i.test(page),
});

/** wraps an authored .html body fragment the way publish does */
export const wrapHtml = (source: string) => {
    const body = unwrap(source);
    const vp = body.match(/<meta[^>]+name=["']?viewport["']?[^>]*>/i)?.[0];
    const head = vp && !/viewport-fit=cover/i.test(vp) ? HEAD_NO_COVER : HEAD;
    const { mermaid, highlight } = detect(body);
    const rt = (mermaid ? MERMAID_RUNTIME : '') + (highlight ? HLJS_RUNTIME : '');
    return `${head}\n${body}\n${rt ? RUNTIME_OPEN + rt + RUNTIME_CLOSE : ''}${TAIL}`;
};

/** lays a .md page out in the fixed document template, rendered client side */
export const wrapMarkdown = (md: string, name: string) => {
    const title = md.match(/^#\s+(.+)$/m)?.[1].trim() ?? name;
    const src = JSON.stringify(md).replace(/</g, '\\u003c');
    const body = `<title>${esc(title)}</title><style>${DOC_CSS}</style><main id=doc></main><script src="${MARKED_SRC}"></script><script>(()=>{const md=${src};const el=document.getElementById('doc');if(!window.marked){el.textContent=md;el.style.whiteSpace='pre-wrap';return}el.innerHTML=marked.parse(md);el.querySelectorAll('pre>code.language-mermaid').forEach(c=>{const p=document.createElement('pre');p.className='mermaid';p.textContent=c.textContent;c.parentElement.replaceWith(p)})})()</script>`;
    const { highlight } = detect(md.replace(/```(\w+)/g, '<code class="language-$1">'));
    const mermaid = /```mermaid/.test(md);
    const rt = (mermaid ? MERMAID_RUNTIME : '') + (highlight ? HLJS_RUNTIME : '');
    return { html: `${HEAD}\n${body}\n${rt ? RUNTIME_OPEN + rt + RUNTIME_CLOSE : ''}${TAIL}`, title };
};

/** the frame runtime goes first in <head>, so theme and capture exist before page code runs */
export const injectRuntime = (html: string, tag: string) => {
    const i = html.indexOf('<head>');
    if (i >= 0) {
        return html.slice(0, i + 6) + tag + html.slice(i + 6);
    }
    return tag + html;
};
