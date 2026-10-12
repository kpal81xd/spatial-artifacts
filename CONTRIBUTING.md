# Contributing

Development uses [Bun](https://bun.sh); the plugin itself runs on Node 22.18+ with no runtime dependencies.

```bash
bun install
bun run test
bun run typecheck  # both tsc projects
bun run lint       # prettier --check, eslint and both tsc projects
bun run lint-fix   # prettier --write and eslint --fix
```

## Dev mode

`bun run dev` (or `bun <repo>/scripts/dev.ts` from another project) starts Claude with this checkout's plugin in place
of the installed one. Arguments after it go to Claude.

- It runs its own daemon on port 47329, so installed sessions keep working.
- Each launch replaces `~/.spatial-artifacts-dev` with a fresh copy of `~/.spatial-artifacts`. You test on real artifacts
  without writing to them, and changes are gone at the next launch.
- Each launch restarts the dev daemon, so changes under `server/` take effect. Changes under `web/` show on a page
  reload.

To run a working copy in Codex, point the `spatial` MCP server at `plugins/spatial-artifacts/server/mcp.ts` in a local
`.codex/config.toml` (git-ignored). Set `SPATIAL_ARTIFACTS_DIR` and `SPATIAL_ARTIFACTS_PORT` on it as `scripts/dev.ts`
does, or it shares the installed plugin's daemon and data.

## Notes

- Lint uses `eslint-plugin-import-x` instead of `eslint-plugin-import`, which doesn't support ESLint 10.
- Bun blocks `unrs-resolver`'s install script (see `bun pm untrusted`); the import resolver works without it.
- Use conventional commit titles (`feat:`, `fix:`, `docs:`, `chore:` …) for commits and pull requests.
