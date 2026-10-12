// starts claude in the current directory (`bun run dev` runs it from the repo root) with this working tree's
// spatial-artifacts plugin in place of an installed one. it runs its own daemon on port 47329 over a fresh copy of the
// real data in ~/.spatial-artifacts-dev, so it never writes to the installed plugin's data. any arguments go to claude
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const PLUGIN = join(import.meta.dirname, '..', 'plugins', 'spatial-artifacts');
const DATA = process.env['SPATIAL_ARTIFACTS_DIR'] ?? join(homedir(), '.spatial-artifacts');
const DEV_DATA = join(homedir(), '.spatial-artifacts-dev');
const DEV_PORT = '47329';
const SKIP = ['server.json', 'server.log'];

// claude code's own artifact tools would otherwise sit beside the plugin's
const OFF = ['Artifact', 'ArtifactComments', 'ArtifactData', 'ArtifactCheck'];

// a running dev daemon would keep serving the old copy and the old code
const pidFile = join(DEV_DATA, 'server.json');
if (existsSync(pidFile)) {
    spawnSync('kill', [String(JSON.parse(readFileSync(pidFile, 'utf8')).pid)], { stdio: 'ignore' });
}

mkdirSync(DATA, { recursive: true });
rmSync(DEV_DATA, { recursive: true, force: true });
cpSync(DATA, DEV_DATA, { recursive: true, filter: (p) => !SKIP.includes(basename(p)) });

const r = spawnSync('claude', ['--plugin-dir', PLUGIN, '--disallowedTools', ...OFF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, SPATIAL_ARTIFACTS_DIR: DEV_DATA, SPATIAL_ARTIFACTS_PORT: DEV_PORT },
});
process.exit(r.status ?? 1);
