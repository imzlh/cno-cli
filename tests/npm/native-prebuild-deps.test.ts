import { ok } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Deno.test({ name: 'native lifecycle deps: node-pty can resolve node-addon-api for node-gyp', timeout: 30000 }, () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cno-native-lifecycle-'));
    const lockDir = mkdtempSync(join(tmpdir(), 'cno-native-lock-'));
    try {
        const cached = spawnSync(process.execPath, [
            'cache',
            `--cache-dir=${cacheDir}`,
            `--lock-dir=${lockDir}`,
            'npm:node-pty',
        ], { encoding: 'utf8' });
        ok(cached.status === 0, cached.stderr || cached.stdout);

        const cwd = join(cacheDir, 'npm', 'node-pty@1.1.0');
        const result = spawnSync('node', ['-p', "require('node-addon-api').targets"], {
            cwd,
            encoding: 'utf8',
        });

        ok(result.status === 0, result.stderr || result.stdout);
        ok(result.stdout.includes('node_addon_api.gyp'), result.stdout);
    } finally {
        rmSync(cacheDir, { recursive: true, force: true });
        rmSync(lockDir, { recursive: true, force: true });
    }
});
