import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const revision = process.env.CNO_POLYFILL_REVISION
    || execFileSync('git', ['-C', join(root, 'cno'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const slash = (path) => path.replaceAll('\\', '/');

// The main bundle may contain exactly the Bun injector (plus the CTS bridge it
// shares with the Node injector). Everything else under cno/src/bun is payload.
test('embedded CLI bundle contains only the Bun injector', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-bun-boundary-'));
    const outfile = join(directory, 'cno-cli.min.js');
    const metafile = join(directory, 'meta.json');
    execFileSync(process.execPath, [join(root, 'scripts/bundle.mjs'), 'min'], {
        cwd: root,
        env: { ...process.env, CNO_POLYFILL_REVISION: revision, CNO_BUNDLE_OUTFILE: outfile, CNO_BUNDLE_METAFILE: metafile },
        stdio: 'pipe',
    });
    const inputs = Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs).map(slash);
    assert.deepEqual(
        inputs.filter((input) => /(^|\/)cno\/src\/bun\//.test(input)),
        ['cno/src/bun/_internal/inject.ts'],
    );
    assert.ok(inputs.includes('cno/src/node/_internal/cts-bridge.ts'));

    const text = readFileSync(outfile, 'utf8');
    for (const marker of ['cno/src/bun', 'bun/sqlite', 'BunFile', 'randomUUIDv7', 'CryptoHasher']) {
        assert.ok(!text.includes(marker), `main bundle contains Bun implementation marker: ${marker}`);
    }
});

test('Bun payload bundles are self-contained ESM files', async () => {
    const { buildBunPayload } = await import(pathToFileURL(join(root, 'scripts/bundle-bun.mjs')).href);
    const outdir = mkdtempSync(join(tmpdir(), 'cno-bun-payload-'));
    const result = await buildBunPayload({ mode: 'min', outdir });
    const inputs = Object.keys(result.metafile.inputs).map(slash);
    for (const forbidden of ['cno/src/bun/_internal/', 'cno/src/webapi/formdata.ts', 'cno/src/main.ts']) {
        assert.ok(!inputs.some((input) => input.includes(forbidden)), `payload contains global bootstrap input: ${forbidden}`);
    }
    assert.deepEqual(readdirSync(outdir).sort(), ['index.js', 'sqlite.js']);
    for (const name of ['index.js', 'sqlite.js']) {
        const text = readFileSync(join(outdir, name), 'utf8');
        assert.ok(!/^\s*import\s/m.test(text), `${name} has a static import`);
        assert.ok(!/\bimport\(/.test(text.replace(/"[^"]*"|'[^']*'/g, '')), `${name} has a dynamic import`);
        assert.ok(!text.includes('/cno/src/'), `${name} references checkout sources`);
    }
});

test('CMake stages and installs the Bun payload without runtime fallbacks', () => {
    const cmake = readFileSync(join(root, 'CMakeLists.txt'), 'utf8');
    assert.match(cmake, /_STAGE_DIR\}\/lib\/cno\/bun/);
    assert.match(cmake, /DESTINATION "\$\{CMAKE_INSTALL_LIBDIR\}\/cno\/bun"/);
    assert.match(cmake, /CNO_PREBUILT_BUN_DIR/);
    // Payload files are never inputs to cjsc.
    assert.doesNotMatch(cmake, /cjsc[^\n]*lib\/cno\/bun/);
    assert.doesNotMatch(cmake, /file\(DOWNLOAD|FetchContent|git clone/i);
});
