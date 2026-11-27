import { deepStrictEqual, ok } from 'node:assert';
import { existsSync } from 'node:fs';

function packageDir(spec: string): string {
    const pkg = require.resolve(`${spec}/package.json`);
    return pkg.slice(0, pkg.lastIndexOf('/'));
}

// These cases need native addon packages present in the local npm cache; they
// are not repo fixtures. Check each package independently so one installed
// addon does not accidentally unskip unrelated cases.
function packageInstalled(spec: string): boolean {
    try {
        require.resolve(`${spec}/package.json`);
        return true;
    } catch {
        return false;
    }
}

// The better-sqlite3 and cpu-features cases assert the FAILURE mode of legacy
// Node/V8 addons and branch on existsSync(addon), so a source-only package
// (no compiled .node) still exercises them. The sqlite3 cases actually open a
// database through the compiled addon, so gate those on the expected build
// artifact. Once it exists, a require/ABI failure is a test failure, not a skip.

const betterSqlite3Installed = packageInstalled('better-sqlite3');
const cpuFeaturesInstalled = packageInstalled('cpu-features');
const sqlite3PackageInstalled = packageInstalled('sqlite3');
const sqlite3Addon = sqlite3PackageInstalled
    ? `${packageDir('sqlite3')}/build/Release/node_sqlite3.node`
    : '';
const sqlite3Installed = sqlite3PackageInstalled && existsSync(sqlite3Addon);

Deno.test({ ignore: !betterSqlite3Installed, name: 'bindings: better-sqlite3 searches native addon from package root', timeout: 30000 }, async () => {
    const root = packageDir('better-sqlite3');
    const addon = `${root}/build/Release/better_sqlite3.node`;
    const cwdBuild = `${Deno.cwd()}/build/better_sqlite3.node`;

    try {
        const Database = require('better-sqlite3');
        new Database(':memory:');
        ok(false, 'better-sqlite3 legacy Node/V8 addon should not load as Node-API');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ok(message.includes(addon), message);
        if (existsSync(addon)) {
            ok(message.includes('legacy Node/V8 NODE_MODULE registration'), message);
            ok(message.includes('only Node-API addons are supported'), message);
        }
        ok(!message.includes(cwdBuild), message);
    }
});

Deno.test({ ignore: !sqlite3Installed, name: 'sqlite3: native Node-API addon opens an in-memory database', timeout: 30000 }, async () => {
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(':memory:');
    try {
        await new Promise<void>((resolve, reject) => {
            db.serialize(() => {
                db.run('CREATE TABLE t (value INTEGER)', (error: Error | null) => {
                    if (error) reject(error);
                });
                db.run('INSERT INTO t VALUES (?)', 42, (error: Error | null) => {
                    if (error) reject(error);
                });
                db.get('SELECT value FROM t', (error: Error | null, row: { value: number }) => {
                    if (error) reject(error);
                    else {
                        ok(row);
                        ok(row.value === 42, `expected sqlite3 wrapper query to return 42, got ${row.value}`);
                        resolve();
                    }
                });
            });
        });
    } finally {
        await new Promise<void>((resolve, reject) => {
            db.close((error: Error | null) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }
});

Deno.test({ ignore: !sqlite3Installed, name: 'sqlite3: prepared statements insert and query multiple rows', timeout: 30000 }, async () => {
    const root = packageDir('sqlite3');
    const sqlite3 = require(`${root}/lib/sqlite3.js`);
    const db = new sqlite3.Database(':memory:');
    try {
        const rows = await new Promise<Array<{ name: string }>>((resolve, reject) => {
            db.serialize(() => {
                db.run('CREATE TABLE t (id INTEGER, name TEXT)', (error: Error | null) => {
                    if (error) reject(error);
                });
                const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
                stmt.run(1, 'one');
                stmt.run(2, 'two');
                stmt.finalize((error: Error | null) => {
                    if (error) reject(error);
                });
                db.all('SELECT name FROM t ORDER BY id', (error: Error | null, result: Array<{ name: string }>) => {
                    if (error) reject(error);
                    else resolve(result);
                });
            });
        });
        deepStrictEqual(rows.map(row => row.name), ['one', 'two']);
    } finally {
        await new Promise<void>((resolve, reject) => {
            db.close((error: Error | null) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }
});

Deno.test({ ignore: !cpuFeaturesInstalled, name: 'cpu-features: built legacy native addon reports unsupported Node ABI', timeout: 30000 }, async () => {
    const root = packageDir('cpu-features');
    const addon = `${root}/build/Release/cpufeatures.node`;
    const cwdBuild = `${Deno.cwd()}/build/Release/cpufeatures.node`;

    try {
        require('cpu-features');
        ok(false, 'cpu-features legacy Node/V8 addon should not load as Node-API');
    } catch (error) {
        const e = error as Error & { code?: string };
        if (existsSync(addon)) {
            ok(e.message.includes(addon), e.message);
            ok(e.message.includes('legacy Node/V8 NODE_MODULE registration'), e.message);
            ok(e.message.includes('only Node-API addons are supported'), e.message);
        } else {
            ok(e.code === 'MODULE_NOT_FOUND', e.message);
            ok(e.message.includes(`'../build/Release/cpufeatures.node'`), e.message);
            ok(e.message.includes(`${root}/lib/index.js`), e.message);
        }
        ok(!e.message.includes(cwdBuild), e.message);
    }
});
