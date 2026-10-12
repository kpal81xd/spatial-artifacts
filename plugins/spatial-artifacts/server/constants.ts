import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env['SPATIAL_ARTIFACTS_DIR'] ?? join(homedir(), '.spatial-artifacts');
export const PORT = Number(process.env['SPATIAL_ARTIFACTS_PORT'] ?? 47328);
export const HOST = '127.0.0.1';
export const AUTO_OPEN = process.env['SPATIAL_ARTIFACTS_AUTO_OPEN'] !== '0';

// the 3d scene runtime: served to every page from the plugin, never copied into one, so a fix reaches published scenes
export const SCENE_DIR = join(import.meta.dirname, '..', 'skills', 'spatial-3d-design', 'template');
export const SCENE_ROUTE = '/_frame/scene/';
export const SCENE_FILES = ['scene-runtime.mjs', 'scene-core.mjs'];

export const MAX_PAGE_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BINARY_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_PUBLISH_BYTES = 64 * 1024 * 1024;
export const MAX_VERSION_BYTES = 256 * 1024 * 1024;
export const MAX_PUBLISH_FILES = 255;
export const MAX_VERSION_FILES = 511;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_SVG_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ASSET_FILES = 500;
export const MAX_ASSET_STORE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILE_PATHS = 25;
export const MAX_READ_PATHS = 256;
export const TITLE_SCAN_BYTES = 8192;
export const LIST_DEFAULT = 25;
export const LIST_MAX = 50;
export const REPLY_MAX_BYTES = 4096;
export const ENVELOPE_CHARS = 16000;

// a drawn comment area quotes at most this many covered elements (a 3d part list runs long)
export const REGION_INSIDE_MAX = 16;

// more anchors one comment can hold, Shift+clicked in after the first
export const ANCHOR_ALSO_MAX = 8;

// a thread Claude picked up shows as working this long without a reply, as claude.ai tracks a summon
export const CLAUDE_WORK_MS = 10 * 60 * 1000;

// each session's mcp server checks in this often with the artifacts it links to (its comment monitor polls faster);
// a check-in older than the ttl counts as gone
export const PRESENCE_MS = 5000;
export const PRESENCE_TTL_MS = 12000;

// a comment's captures from a page (a 3d scene's canvas) and its attached images: the largest stored size of each, and
// how many one read hands Claude
export const COMMENT_IMAGE_MAX_BYTES = 1024 * 1024;
export const COMMENT_IMAGES_PER_READ = 8;

// reference images a viewer attaches to one comment or reply (pasted, dropped or picked), stored like captures
export const COMMENT_ATTACH_MAX = 4;
export const COMMENT_IMAGE_TYPES: Record<string, string> = {
    'image/webp': 'webp',
    'image/png': 'png',
    'image/jpeg': 'jpg',
};
export const DIAG_MAX_BYTES = 65536;
export const DIAG_MAX_ENTRIES = 500;
export const DB_BATCH_MAX = 50;
export const DB_QUERY_DEFAULT = 100;
export const DB_QUERY_MAX = 1000;
export const DB_WHERE_MAX = 10;
export const DB_STR_MAX = 262144;
export const DB_RESULT_CHARS = 300000;
export const DB_DOC_MAX_BYTES = 1024 * 1024;
export const DB_BATCH_MAX_BYTES = 1024 * 1024;
export const DB_MAX_DOCS = 100000;
export const COMMENT_MAX_BYTES = 16384;
export const PREVIEW_MAX_WIDTHS = 3;
export const PREVIEW_SHOT_MAX_HEIGHT = 1568;
export const PREVIEW_DEFAULT_WIDTHS = [1280, 390];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ASSET_ID_RE = /^[0-9a-f]{32}$/;
export const VER_RE = /^[0-9a-f]{12}$/;
const SEG = String.raw`(?!\.\.?(?:/|$))[A-Za-z0-9_\-.~:@+]{1,200}`;
export const DOC_ID_RE = new RegExp(`^${SEG}$`);
export const COLLECTION_RE = new RegExp(`^${SEG}(?:/${SEG}){0,14}$`);
export const FIELD_RE = /^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$/u;
export const CURSOR_RE = /^[A-Za-z0-9_=-]{1,4096}$/;
export const CONTRACT_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;
export const PROFILE_ID_RE = /^u_[A-Za-z0-9_]{22}$/;
export const CONTRACT_VERSION = '1.0.0';
// the original's whole roster; `self` is the former name of `artifact`, and `permissions` is built in, never declared
export const CAPABILITIES = ['artifact', 'assets', 'comments', 'db', 'downloads', 'files', 'room', 'self', 'user'];

// what the viewer allows a page to do as them, asked in the viewer and stored per artifact
export const GRANT_RE = /^(comments|files)$/;

export const PAGE_EXTS = ['.html', '.htm', '.md'];

// published supporting files: extension -> media type (reference c0173)
export const FILE_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.geojson': 'application/geo+json',
    '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.wasm': 'application/wasm',
};

export const ASSET_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.ts': 'text/plain',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
};

// text assets each need their own upload call, like the original
export const TEXT_ASSET_EXTS = ['.csv', '.md', '.markdown', '.json', '.txt'];

export const CDN_SCRIPT_HOSTS = [
    'https://cdnjs.cloudflare.com',
    'https://cdn.jsdelivr.net/npm/',
    'https://unpkg.com',
    'https://cdn.tailwindcss.com',
    'https://code.jquery.com',
];

export const FRAME_CSP = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${CDN_SCRIPT_HOSTS.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
].join('; ');

export const PERMISSIONS_POLICY =
    'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), payment=(), usb=(), serial=(), bluetooth=()';

export const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist/mermaid.min.js';
export const HLJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js';
export const MARKED_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.12/marked.min.js';
