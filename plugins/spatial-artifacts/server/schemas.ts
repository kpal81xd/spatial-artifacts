// input schemas of the four tools: split-toolset field names, limits and describe texts
import {
    DB_BATCH_MAX,
    DB_QUERY_MAX,
    DB_STR_MAX,
    DB_WHERE_MAX,
    LIST_DEFAULT,
    LIST_MAX,
    MAX_FILE_PATHS,
    MAX_PUBLISH_FILES,
    MAX_READ_PATHS,
    PREVIEW_MAX_WIDTHS,
} from './constants.ts';

type S = Record<string, unknown>;
const str = (description: string, extra: S = {}) => ({ type: 'string', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });
const obj = (properties: S, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
});

const SEG = String.raw`(?!\.\.?(?:/|$))[A-Za-z0-9_\-.~:@+]{1,200}`;
const COLLECTION = `^${SEG}(?:/${SEG}){0,14}$`;
const DOC_ID = `^${SEG}$`;

export const ARTIFACT = obj({
    action: {
        type: 'string',
        enum: ['publish', 'list', 'read', 'delete', 'open', 'pin', 'unpin', 'quickstart'],
        description:
            "Which operation to run: 'publish', 'list', 'read', 'delete', 'open', 'pin', 'unpin' or 'quickstart'; without it the call publishes. **Calls** in the tool description covers each and its inputs; notes here only add exceptions.",
    },
    file_path: str(
        'publish: the page on disk Claude puts online (.html, or .md solely when a skill asks for it). With `asset: true`, it is instead the local file to upload. Absent any other title, the basename becomes the title, so keep it brief and distinctive.',
    ),
    asset: bool(
        "publish with `url`: when true, `file_path` (or every entry of `file_paths`) is stored in that artifact's asset store rather than becoming its page — or, given `from_url` and `asset_ids` instead of `file_path`, the server copies those assets over from another artifact (details under **Calls**).",
    ),
    from_url: str('Publish with `asset: true` only, instead of `file_path`: URL of the SOURCE artifact.', {
        maxLength: 512,
    }),
    asset_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string', pattern: '^[0-9a-f]{32}$' },
        description:
            'Only with `asset: true` and `from_url` on a publish: 1–10 non-repeating asset ids of the source artifact, taken from an upload result or its `scope: "assets"` listing.',
    },
    file_paths: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_FILE_PATHS,
        items: { type: 'string', minLength: 1, maxLength: 1024 },
        description: `publish with \`asset: true\` only: up to ${MAX_FILE_PATHS} local image, video, PDF, font, stylesheet or script files to upload in one call under one approval, in place of \`file_path\`. A text file (CSV, Markdown, JSON, plain text) goes in a call of its own.`,
    },
    favicon: str('Deprecated; Claude omits it and uses `icon`.', { minLength: 1, maxLength: 32 }),
    icon: str(
        "A single brief, generic word for the browser-tab icon of the artifact (e.g. chart, calendar, recipe, map or code) that plainly signals the content, never a brand or product name. Claude sets it on the first publish of every page; on a redeploy it leaves the field out so the current icon stays, sending a different one only at the person's request.",
        { maxLength: 40 },
    ),
    files: {
        anyOf: [
            {
                type: 'array',
                maxItems: MAX_PUBLISH_FILES,
                items: obj(
                    { path: { type: 'string', minLength: 1, maxLength: 512 }, contentType: { type: 'string' } },
                    ['path'],
                ),
            },
            {
                type: 'object',
                additionalProperties: {
                    anyOf: [
                        { type: 'string', minLength: 1, maxLength: 512 },
                        obj(
                            { from: { type: 'string', minLength: 1, maxLength: 512 }, contentType: { type: 'string' } },
                            ['from'],
                        ),
                        obj(
                            {
                                artifact: { type: 'string', minLength: 1, maxLength: 512 },
                                path: { type: 'string', minLength: 1, maxLength: 512 },
                                ver: { type: 'string', minLength: 1, maxLength: 64 },
                            },
                            ['artifact', 'path'],
                        ),
                        { type: 'null' },
                    ],
                },
            },
        ],
        description:
            'Extra files published next to the page, in map form {"published/path": "source/path" | {from, contentType} | {artifact, path, ver?} | null}. Each key is exactly the path the HTML uses for that file. Sources are paths on disk; pass {from, contentType} if the media type cannot be guessed from the published file\'s extension. An {artifact, path} source duplicates a file another Artifact already published (never for an HTML or XML document; a publish may draw on 4 source Artifact versions at most). On an update, null deletes that path and unmentioned files stay. In the plain list form, each file is published under the path as spelled. Every source has to sit inside Claude\'s scratchpad directory or the working directory. A root-level `preflight.js` is reserved and gets run against open pages whenever Claude publishes an update, and must be a JavaScript module no larger than 8 KiB with a function as its default export, otherwise the publish is rejected.',
    },
    overwrite_unread: {
        type: 'array',
        maxItems: 256,
        items: { type: 'string', minLength: 1, maxLength: 512 },
        description:
            'For a publish to an existing artifact that uses `files` or `root`: published paths this call is allowed to overwrite or delete even though this session never read or listed them. Every other path the call affects must be one you published yourself, saw among its listed files, or fetched by `path`, and it must be unchanged since — if not, the call sends nothing and the refusal lists every such path. Put a path in this list solely if the user wanted it replaced sight unseen; it never covers a path modified since your read.',
    },
    pin: bool(
        'Publish only: when true, the artifact is pinned in the gallery as soon as the publish succeeds. Claude sets it solely if the person requested pinning.',
    ),
    page: bool(
        'Read only: true makes a read return the rendered page where it would otherwise return something else. Local reads always give back the page, so it has no effect here.',
    ),
    intent: {
        type: 'string',
        enum: ['document', 'slides', 'design', 'other'],
        description:
            "Quickstart only (required there): what is being built — 'document' (text people read or co-edit), 'slides' (a deck or a single slide), 'design' (a visual design, a prototype or a 3D scene), 'other' (anything outside those, or when unsure).",
    },
    design_systems: bool(
        'quickstart only: false when a design system was declined or is already in hand. No design systems are stored locally.',
    ),
    type_url: str(
        'Artifact types do not exist in this local toolset; passing one returns how to build the page instead.',
        { maxLength: 2048 },
    ),
    type: str('list only: an Artifact type name. This local toolset has no types, so the listing is empty.', {
        maxLength: 200,
    }),
    type_query: str("list with scope 'types' only. This local toolset has no types.", { maxLength: 200 }),
    auto_open: {
        type: 'string',
        enum: ['at_create', 'after_first_write'],
        description: 'Only with `type_url`, which this local toolset does not have.',
    },
    root: str(
        "Folder that relative `files` sources resolve from, like a bundler's root; it never alters published paths. It may be absolute, inside Claude's scratchpad directory or the working directory, or relative to the working directory. Valid only together with `files`.",
        { minLength: 1, maxLength: 1024 },
    ),
    limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIST_MAX,
        description: `list only: how many artifacts to return at most (default ${LIST_DEFAULT}).`,
    },
    scope: {
        type: 'string',
        enum: ['mine', 'shared', 'all', 'types', 'files', 'assets'],
        description:
            "list: picks the listing. Without it you get 'mine'; the alternatives are 'shared', 'all', 'types', 'files' (needs `url`) and 'assets' (needs `url`; continue it with `after`). **Calls** has the details.",
    },
    title: str(
        'publish: title used when the HTML file lacks a <title> element. Make it a name rather than a summary; Claude keeps it unchanged on every redeploy.',
    ),
    description: str("publish: a single sentence shown as the gallery card's subtitle.", { maxLength: 1000 }),
    label: str(
        'Optional name for this particular publish, 60 characters at most (e.g. "Draft to legal"): a handful of words rather than a description.',
        { maxLength: 60 },
    ),
    url: str(
        'URL of an artifact that already exists (http://localhost:<port>/code/artifact/<uuid>). When publishing, it names the artifact updated in place; Claude leaves it out for a brand-new artifact and for a redeploy within this conversation (the tool description explains updating one made in an earlier conversation). With read, delete and any other call accepting a URL, it names the artifact that call acts upon.',
    ),
    prompt: str(
        'read: what Claude needs from the artifact. Local artifacts are always returned in full, so this is ignored.',
    ),
    force: bool(
        'publish: an overwrite of last resort that **discards** any newer version already published. If a conflict occurs, Claude instead folds its edits into the newer content returned with the rejection and republishes. Claude sets true solely when the person explicitly told it to throw away that particular version.',
    ),
    out_dir: str(
        "read with `path`: folder the fetched file is written to, by default this artifact's own folder under ~/.spatial-artifacts/reads. Published files are saved at <out_dir>/<published path>, and an asset under its id followed by the extension for its type.",
        { maxLength: 4096 },
    ),
    path: str(
        `read: the published path of the file within the artifact, spelled exactly as a 'files' listing showed it ("index.html" means the page itself). The file gets saved locally, the result tells you where, and short text files come back with their contents. Alternatively it may be the id of an uploaded asset (32 hex characters, taken from an upload result or an 'assets' listing), in which case that asset gets saved locally. delete: id of the single asset to remove.`,
        { maxLength: 512 },
    ),
    paths: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_READ_PATHS,
        items: { type: 'string', maxLength: 512 },
        description: `read: a batch of published paths used instead of \`path\`, at most ${MAX_READ_PATHS} per call. Every file is saved just as it would be for a lone \`path\`; the result reports, per file, where it was stored or why reading it failed, and includes the contents of small text files as long as they fit.`,
    },
    after: str(
        "Only for list with scope 'assets': the `next` value an earlier listing returned, to get the following page.",
        {
            pattern: '^[A-Za-z0-9_=-]{1,4096}$',
        },
    ),
    capabilities: {
        type: 'object',
        description:
            'publish: runtime capabilities the page declares, written as {name: config}. Claude first loads the `spatial-capabilities` skill, then passes this. On a redeploy Claude leaves the field out so the page keeps its current capabilities; {} removes them all.',
    },
    contract: {
        anyOf: [
            { type: 'string', const: 'latest' },
            { type: 'string', pattern: '^(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,4})\\.(0|[1-9]\\d{0,5})$' },
        ],
        description:
            "publish: which runtime version the artifact uses. If absent, the current version stays (the default); 'latest' moves to the newest, and a specific version pins it or rolls it back. Since this alters how the live page behaves, Claude includes it solely when the author explicitly wants that change.",
    },
});

export const COMMENTS = obj(
    {
        action: {
            type: 'string',
            enum: ['read', 'reply', 'resolve', 'watch'],
            description:
                "'read' returns the comment threads of the artifact named by `url` (`thread_id` limits it to one thread; `cursor` resumes a listing); 'reply' adds `text` to the thread given by `thread_id`; 'resolve' closes that thread as resolved; 'watch' handles this session's artifact watches — given a `url` it begins watching that artifact (`on: false` ends it), and without a `url` it lists the watches and rooms this session has.",
        },
        url: str("Artifact URL; required by every action but a 'watch' that only lists."),
        thread_id: str(
            'reply: which comment thread to answer in. resolve: which thread to close. read: limit the result to this single thread (a very long one may still be cut short by the size cap). Get thread ids from comment notifications or from action "read".',
        ),
        text: str('Only for reply: the reply, as plain text of 4096 UTF-8 bytes at most.'),
        cursor: str(
            'Only for read: when a listing ends on the line "more threads not listed", give the cursor value it names to show the threads left out.',
        ),
        acknowledge_duplicate: bool(
            'Only for reply: posts the reply even when each "sent to Claude" request in the thread is already followed by a Claude reply. If this is missing, that reply gets rejected as a likely duplicate. Set true solely for an intentional follow-up that contributes something new — never to repeat what the existing reply already covered.',
        ),
        on: bool('Only for watch: false ends the watch on the `url` artifact; true or omitted begins it.'),
        replies: bool(
            'Watch only: true turns automatic comment replies back on for the `url` artifact after they were paused or stopped — send it ONLY if the user explicitly asked for them to resume.',
        ),
    },
    ['action'],
);

const writeEntry = obj(
    {
        op: { type: 'string', enum: ['set', 'update', 'delete'] },
        collection: { type: 'string', maxLength: 1000, pattern: COLLECTION },
        doc_id: { type: 'string', pattern: DOC_ID },
        data: { type: 'object' },
        file_path: { type: 'string' },
        if_version: { type: 'integer', minimum: 1 },
    },
    ['op', 'collection', 'doc_id'],
);

export const DATA = obj(
    {
        action: {
            type: 'string',
            enum: ['get', 'list', 'query', 'set', 'update', 'delete', 'str_replace', 'batch', 'profiles'],
            description:
                "Reads: 'get' (a single document: `collection` + `doc_id`), 'list' (one page of a collection: `collection`, optionally `query.limit`/`query.cursor`), 'query' (filtered results: `collection` + `query`), 'profiles' (display names of people: `ids` and nothing more). Writes: 'set' (replaces) or 'update' (merges), each taking `collection`, `doc_id` and one of `data` or `file_path`; 'str_replace' needs `collection`, `doc_id`, `field`, `old_str`, `new_str` and changes one exact, unique snippet within a string field without sending the whole field again (`replace_all` changes every occurrence); 'delete' takes `collection` + `doc_id`; 'batch' takes `writes`. All actions take the artifact's `url`.",
        },
        url: str('The artifact URL; required.'),
        writes: {
            type: 'array',
            minItems: 1,
            maxItems: DB_BATCH_MAX,
            items: writeEntry,
            description:
                "Only for action 'batch': the writes to perform as one unit, 1-50 entries shaped {op: 'set'|'update'|'delete', collection, doc_id; set/update entries take exactly one of data (an inline object) or file_path (a JSON file on disk); plus if_version — the document's `version` from your last read, mandatory for every entry whose document exists already (leave it out only when creating); if a pinned document has changed meanwhile, or an entry for an existing document has no pin, nothing in the batch is written and the result points to the first such entry}. No document may appear more than once, the full batch body may not exceed 1 MiB, and it commits entirely or not at all. Prefer one batch over separate calls when writing more than two or so documents.",
        },
        collection: {
            type: 'string',
            maxLength: 1000,
            pattern: COLLECTION,
            description:
                'Database collection path: "/"-separated segments, an odd number from 1 to 15 (letters, digits and _ - . ~ : @ + in each). Segments alternate collection and document: "boards/b1/columns" names a collection, and `doc_id` "c2" then addresses document "boards/b1/columns/c2". Data owned by one user lives in "data/users/<id>" (three segments), the collection of that user\'s documents; inside it, "data/users/<id>/decks" is a single document, with the collection "data/users/<id>/decks/cards" below it; "me" in place of <id> stands for the current user. Needed by every action other than \'batch\' and \'profiles\'.',
        },
        ids: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: { type: 'string' },
            description:
                'Only for action \'profiles\': the people to look up, 1-64 ids copied verbatim from a document or live event ("u_" plus 22 characters).',
        },
        doc_id: {
            type: 'string',
            pattern: DOC_ID,
            description:
                "Id of the document, a single path segment. Actions 'get', 'set', 'update', 'str_replace' and 'delete' need it; 'list' and 'query' reject it.",
        },
        query: {
            ...obj({
                where: {
                    type: 'array',
                    maxItems: DB_WHERE_MAX,
                    items: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 3,
                        prefixItems: [
                            { type: 'string' },
                            {
                                type: 'string',
                                enum: [
                                    'eq',
                                    'ne',
                                    'in',
                                    'not-in',
                                    'lt',
                                    'lte',
                                    'gt',
                                    'gte',
                                    'array-contains',
                                    '==',
                                    '!=',
                                    '<',
                                    '<=',
                                    '>',
                                    '>=',
                                ],
                            },
                            {},
                        ],
                    },
                },
                order_by: obj({ field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } }, [
                    'field',
                ]),
                limit: { type: 'integer', minimum: 1, maximum: DB_QUERY_MAX },
                cursor: { type: 'string', maxLength: 4096 },
            }),
            description:
                "Settings for action 'list' and 'query': to page through a collection use `cursor` (the `next_cursor` of an earlier result) and `limit` (1-1000, 100 if unset); filtering with `where` (triples of [field, operator, value]) and sorting with `order_by` work in 'query' alone. An `order_by` query is one page only: up to `limit` documents in that order, never with a `next_cursor` — so set `limit` to the number you actually want (1000 at most), or leave out `order_by` and follow `cursor` to read an entire collection.",
        },
        field: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description:
                "Only for action 'str_replace': the document's top-level string field to change, one plain key such as \"html\" (1-200 bytes; no quotes, brackets, slashes, backslashes, dots, control or invisible formatting characters; never a reserved __name__ key).",
        },
        old_str: {
            type: 'string',
            minLength: 1,
            maxLength: DB_STR_MAX,
            description:
                "Only for action 'str_replace': the text to swap out, exactly as it is stored in the field. It has to appear there exactly once; if not, no write happens and the result tells whether it was missing or not unique.",
        },
        new_str: {
            type: 'string',
            maxLength: DB_STR_MAX,
            description: "Only for action 'str_replace': the text replacing old_str (empty to delete old_str).",
        },
        replace_all: bool(
            "Only for action 'str_replace': swap all occurrences of old_str in the field rather than insisting on exactly one (default false). old_str still has to be present at least once.",
        ),
        if_version: {
            type: 'integer',
            minimum: 1,
            description:
                "For action 'set', 'update', 'str_replace' or 'delete' ('batch' instead pins each entry of `writes`): the document's `version` from your latest read of it (it comes with every document get, list or query returns, and with each set, update or str_replace result). Mandatory on any write to a document that exists already; leave it out only when creating a document. The write goes through only if the document's version is unchanged; otherwise no write happens, the result gives the current version — so just pin the write rather than re-reading beforehand to check. Writing to an existing document without if_version is refused until you have read it.",
        },
        data: {
            type: 'object',
            description:
                'For set and update: a JSON object holding the fields to write — send exactly one of `data` and `file_path`. During an update, any field whose value is `{"__delete__": true}` is deleted instead.',
        },
        file_path: str(
            'For set and update: a JSON file on disk whose top-level object becomes the document — use instead of inline `data`, so a big document need not travel through the conversation.',
        ),
        out_dir: str(
            "For get, list and query: if set, every document returned is saved as pretty-printed JSON at <out_dir>/<collection path>/<doc_id>.json (missing folders are created), and the result names those files rather than including the documents' contents — worth using when documents are big or numerous.",
            { maxLength: 4096 },
        ),
        as_level: {
            type: 'string',
            enum: ['view', 'interact', 'admin'],
            description:
                "Act at this access level rather than your own, checking which actions the page's rules allow such a user — 'view' is someone who may only look at the artifact, 'interact' any viewer who is signed in and can use the page, 'admin' anyone with edit rights. It only narrows your access, never widens it, and keeps your identity (`me` still means you); at 'view' no write succeeds, not even in your own data/users subtree. At a lower level, a write the rules reject comes back as not found and a rejected read comes back empty. Leave it out to act as yourself.",
        },
    },
    ['action'],
);

export const CHECK = obj(
    {
        action: {
            type: 'string',
            enum: ['verify', 'preview'],
            description:
                "'verify' fetches the runtime diagnostics that viewers' browsers recorded for the current version of an artifact (uncaught errors, console output, failed resource loads, results of capability calls) — give `url`, or leave it out to check the latest publish from this session. An empty result may only mean nobody has opened that version yet; it is NOT proof that the page renders cleanly. 'preview' renders a page file on disk before you publish it — give `file_path` (a single .html file; files that would be published next to it don't get loaded), optionally `widths` (px viewport widths; 1280 and 390 unless set) and `themes` ('light' and/or 'dark'; both unless set) — and returns one screenshot for each width and theme (each limited to the page's top 1568 px) together with a checklist of layout and loading problems (horizontal overflow, clipped content, color variables defined for one theme only, loads that were blocked or are local-only, console and diagram errors). It uploads nothing.",
        },
        url: str("verify: URL of the artifact; omit it to check this session's latest publish."),
        file_path: str('preview: the local .html page to render.'),
        widths: {
            type: 'array',
            minItems: 1,
            maxItems: PREVIEW_MAX_WIDTHS,
            items: { type: 'integer', minimum: 320, maximum: 2560 },
            description:
                'Only for preview: viewport widths in CSS pixels to render (1280 and 390 if omitted; 3 at most).',
        },
        themes: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: { type: 'string', enum: ['light', 'dark'] },
            description:
                "Preview only: themes to render, 'light', 'dark' or both (the default); each drives the emulated prefers-color-scheme and the data-theme attribute of the page at once.",
        },
    },
    ['action'],
);
