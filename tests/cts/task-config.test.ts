import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { LockStore } from '../../cts/src/lock.ts';
import { loadTasks } from '../../cts/src/task.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';

async function withTaskConfig(run: (root: string, lock: LockStore) => void | Promise<void>): Promise<void> {
    const root = makePosixTempDir('task-config');
    const lock = new LockStore(root, true);
    try {
        await run(root, lock);
    } finally {
        lock.close();
        rmSync(root, { recursive: true, force: true });
    }
}

Deno.test('cts task config: discovery merges in order and keeps task provenance', async () => {
    await withTaskConfig(async (root, lock) => {
        const packagePath = joinPaths(root, 'package.json');
        writeFileSync(packagePath, JSON.stringify({
            name: 'task-fixture',
            version: '1.2.3',
            scripts: {
                shared: 'echo package > winner.txt',
                preshared: 'echo pre > lifecycle.txt',
                packageOnly: 'echo "$npm_package_name $npm_package_version" > package.txt',
            },
        }));
        writeFileSync(joinPaths(root, 'deno.json'), JSON.stringify({
            tasks: { shared: 'echo json > winner.txt' },
        }));
        writeFileSync(joinPaths(root, 'deno.jsonc'), `{
            // Last discovered config wins.
            "tasks": { "shared": "echo jsonc > winner.txt" }
        }`);
        const nested = joinPaths(root, 'nested');
        mkdirSync(nested);
        const loaded = loadTasks(nested, lock);
        ok(loaded);
        strictEqual(loaded.configPath, joinPaths(root, 'deno.jsonc'));
        strictEqual(await loaded.runner.run('shared'), 0);
        strictEqual(readFileSync(joinPaths(root, 'winner.txt'), 'utf8').trim(), 'jsonc');
        strictEqual(existsSync(joinPaths(root, 'lifecycle.txt')), false);
        strictEqual(await loaded.runner.run('packageOnly'), 0);
        strictEqual(readFileSync(joinPaths(root, 'package.txt'), 'utf8').trim(), 'task-fixture 1.2.3');

        const explicit = loadTasks(nested, lock, { configPath: packagePath, runCwd: nested });
        ok(explicit);
        strictEqual(explicit.configPath, packagePath);
        strictEqual(await explicit.runner.run('shared'), 0);
        strictEqual(readFileSync(joinPaths(nested, 'winner.txt'), 'utf8').trim(), 'package');
        strictEqual(readFileSync(joinPaths(nested, 'lifecycle.txt'), 'utf8').trim(), 'pre');
    });
});

Deno.test('cts task config: an empty task object stops discovery but cannot be explicitly selected', async () => {
    await withTaskConfig((root, lock) => {
        writeFileSync(joinPaths(root, 'deno.json'), JSON.stringify({ tasks: { parent: 'true' } }));
        for (const [file, field] of [['package.json', 'scripts'], ['deno.json', 'tasks']]) {
            const nested = joinPaths(root, field);
            mkdirSync(nested);
            const configPath = joinPaths(nested, file);
            writeFileSync(configPath, JSON.stringify({ [field]: {} }));
            const loaded = loadTasks(nested, lock);
            ok(loaded);
            strictEqual(loaded.configPath, configPath);
            deepStrictEqual(loaded.runner.matchNames('*'), []);
            strictEqual(loadTasks(nested, lock, { configPath }), null);
        }
    });
});

Deno.test('cts task config: discovery ignores primitive fields while explicit selection retains coercion', async () => {
    await withTaskConfig((root, lock) => {
        const parentPath = joinPaths(root, 'deno.json');
        writeFileSync(parentPath, JSON.stringify({ tasks: { parent: 'true' } }));
        for (const [file, field] of [['package.json', 'scripts'], ['deno.json', 'tasks']]) {
            const nested = joinPaths(root, field);
            mkdirSync(nested);
            const configPath = joinPaths(nested, file);
            writeFileSync(configPath, JSON.stringify({ [field]: 'ab' }));
            const discovered = loadTasks(nested, lock);
            ok(discovered);
            strictEqual(discovered.configPath, parentPath);
            deepStrictEqual(discovered.runner.matchNames('*'), ['parent']);
            const explicit = loadTasks(nested, lock, { configPath });
            ok(explicit);
            deepStrictEqual(explicit.runner.matchNames('*'), ['0', '1']);
        }
    });
});

Deno.test('cts task config: a malformed override does not discard valid scripts or trigger explicit fallback', async () => {
    await withTaskConfig((root, lock) => {
        const packagePath = joinPaths(root, 'package.json');
        writeFileSync(packagePath, JSON.stringify({ scripts: { packageOnly: 'true' } }));
        const brokenPath = joinPaths(root, 'deno.json');
        writeFileSync(brokenPath, '{');
        writeFileSync(joinPaths(root, 'deno.jsonc'), 'null');
        const loaded = loadTasks(root, lock);
        ok(loaded);
        strictEqual(loaded.configPath, packagePath);
        deepStrictEqual(loaded.runner.matchNames('*'), ['packageOnly']);
        strictEqual(loadTasks(root, lock, { configPath: brokenPath }), null);
        strictEqual(loadTasks(root, lock, { configPath: joinPaths(root, 'missing.json') }), null);
    });
});
