/**
 * process.dlopen — same Node-API loader as CJS require('*.node').
 * Success path: repo-local N-API fixture (built from addon.c if needed).
 */
import { strictEqual, ok, throws } from 'node:assert';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/napi-addon/', import.meta.url));
const FIXTURE_NODE = join(FIXTURE_DIR, 'cno_napi_fixture.node');

/** Build fixture when absent — source of truth is addon.c + Makefile. */
function ensureNapiFixture(): string {
    if (existsSync(FIXTURE_NODE)) return FIXTURE_NODE;
    const r = spawnSync('make', ['-C', FIXTURE_DIR], { encoding: 'utf8' });
    if (r.status !== 0) {
        const detail = [r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n');
        throw new Error(`failed to build N-API fixture in ${FIXTURE_DIR}:\n${detail}`);
    }
    ok(existsSync(FIXTURE_NODE), `make succeeded but ${FIXTURE_NODE} missing`);
    return FIXTURE_NODE;
}

function packageDir(spec: string): string | null {
    try {
        const pkg = require.resolve(`${spec}/package.json`);
        return pkg.slice(0, pkg.lastIndexOf('/'));
    } catch {
        return null;
    }
}

Deno.test('process.dlopen: rejects bad module/filename args', () => {
    throws(() => process.dlopen(null as unknown as object, 'x.node'), TypeError);
    throws(() => process.dlopen({}, ''), TypeError);
    throws(() => process.dlopen({}, 1 as unknown as string), TypeError);
});

Deno.test('process.dlopen: missing file fails closed', () => {
    const mod: { exports?: unknown } = { exports: {} };
    try {
        process.dlopen(mod, '/tmp/grok-goal-90f99bded2f5/implementer/definitely-missing-addon.node');
        ok(false, 'expected throw');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ok(/Error loading shared library|ERR_DLOPEN|not found|No such file|failed|cannot load/i.test(msg), msg);
        ok(mod.exports === undefined || typeof mod.exports === 'object');
    }
});

Deno.test('process.dlopen: loads Node-API fixture into module.exports', () => {
    const addon = ensureNapiFixture();

    const mod: { exports?: unknown } = { exports: {} };
    process.dlopen(mod, addon);

    ok(mod.exports !== null && typeof mod.exports === 'object', 'exports object set');
    const exp = mod.exports as { tag?: unknown; hello?: unknown };
    strictEqual(exp.tag, 'cno-napi-fixture');
    ok(typeof exp.hello === 'function', 'hello export is a function');
    strictEqual((exp.hello as () => string)(), 'from-napi');
});

Deno.test({
    name: 'process.dlopen: legacy better-sqlite3 fails closed like require',
    timeout: 15000,
}, () => {
    const root = packageDir('better-sqlite3');
    if (!root) {
        console.log('skip: better-sqlite3 not installed (optional fail-closed probe)');
        return;
    }
    const addon = `${root}/build/Release/better_sqlite3.node`;
    if (!existsSync(addon)) {
        console.log('skip: better_sqlite3.node not built (optional fail-closed probe)');
        return;
    }
    const mod: { exports?: unknown } = { exports: {} };
    try {
        process.dlopen(mod, addon);
        ok(false, 'legacy addon must not load');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ok(
            /legacy Node\/V8|only Node-API|ERR_DLOPEN|Error loading shared library/i.test(msg),
            msg,
        );
    }
});

Deno.test('process.dlopen: is not unsupported()', () => {
    try {
        process.dlopen({ exports: {} }, '/no/such/addon.node');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        strictEqual(/is not supported/.test(msg), false, msg);
    }
});
