import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test({ name: 'arktype: validates runtime object schemas', timeout: 30000 }, async () => {
    const arktype = await import('npm:arktype');
    const type = arktype.type;
    const user = type({
        name: 'string',
        age: 'number.integer > 0',
    });

    const value = user({ name: 'cno', age: 1 });
    strictEqual(value.name, 'cno');
    strictEqual(value.age, 1);

    const invalid = user({ name: 'cno', age: 0 });
    ok(String(invalid).includes('age'), String(invalid));
});

Deno.test({ name: 'uvu: registers and runs assertion tests in-process', timeout: 30000 }, async () => {
    Reflect.set(globalThis, 'UVU_DEFER', true);
    Reflect.set(globalThis, 'UVU_QUEUE', [[null]]);
    const uvu = await import('npm:uvu');
    const assert = await import('npm:uvu/assert');
    let ran = false;

    const suite = uvu.suite('cno-compat-uvu');
    suite('executes a case', () => {
        ran = true;
        assert.equal({ answer: 42 }, { answer: 42 });
    });
    suite.run();
    await uvu.exec();
    Reflect.deleteProperty(globalThis, 'UVU_DEFER');

    strictEqual(ran, true);
});

Deno.test({ name: 'tape: executes a TAP assertion stream', timeout: 30000 }, async () => {
    const mod = await import('npm:tape');
    const tape = mod.default ?? mod;
    const seen: string[] = [];

    await new Promise<void>((resolve, reject) => {
        const harness = tape.createHarness();
        const stream = harness.createStream();
        stream.on('data', (chunk: Buffer | string) => seen.push(String(chunk)));
        stream.on('error', reject);
        harness.onFinish(resolve);

        harness('cno compat tape case', (t: any) => {
            t.plan(2);
            t.equal(1 + 1, 2);
            t.deepEqual({ ok: true }, { ok: true });
        });
    });

    ok(seen.join('').includes('# cno compat tape case'));
    ok(seen.join('').includes('1..2'));
});

Deno.test({ name: 'vitest: standalone expect assertions execute', timeout: 30000 }, async () => {
    const vitest = await import('npm:vitest');
    vitest.expect({ name: 'cno', values: [1, 2] }).toEqual({ name: 'cno', values: [1, 2] });
    vitest.expect('compat').toMatch(/compat/);
});

Deno.test({ name: 'conf: persists settings through Node filesystem APIs', timeout: 30000 }, async () => {
    const mod = await import('npm:conf');
    const Conf = mod.default ?? mod;

    await withTempDir('npm-conf', async (dir) => {
        const store = new Conf({
            cwd: dir,
            projectName: 'cno-compat',
            configName: 'settings',
            clearInvalidConfig: true,
        });

        store.set('answer', 42);
        strictEqual(store.get('answer'), 42);

        const reloaded = new Conf({
            cwd: dir,
            projectName: 'cno-compat',
            configName: 'settings',
        });
        strictEqual(reloaded.get('answer'), 42);
    });
});

Deno.test({ name: 'conf: applies schema defaults and persists delete operations', timeout: 30000 }, async () => {
    const mod = await import('npm:conf');
    const Conf = mod.default ?? mod;

    await withTempDir('npm-conf-schema', async (dir) => {
        const store = new Conf({
            cwd: dir,
            projectName: 'cno-compat-schema',
            configName: 'settings',
            schema: {
                enabled: { type: 'boolean', default: true },
                nested: {
                    type: 'object',
                    properties: {
                        count: { type: 'number' },
                    },
                },
            },
        });

        strictEqual(store.get('enabled'), true);
        store.set('nested.count', 3);
        strictEqual(store.get('nested.count'), 3);
        store.delete('nested.count');
        strictEqual(store.has('nested.count'), false);

        const reloaded = new Conf({
            cwd: dir,
            projectName: 'cno-compat-schema',
            configName: 'settings',
        });
        strictEqual(reloaded.has('nested.count'), false);
    });
});

Deno.test({ name: 'lowdb: persists JSON records through ESM node adapter', timeout: 30000 }, async () => {
    const lowdb = await import('npm:lowdb');
    const node = await import('npm:lowdb/node');

    await withTempDir('npm-lowdb', async (dir) => {
        const file = join(dir, 'db.json');
        const adapter = new node.JSONFile(file);
        const db = new lowdb.Low(adapter, { items: [] as Array<{ name: string; value: number }> });

        await db.read();
        db.data.items.push({ name: 'answer', value: 42 });
        await db.write();

        const reloaded = new lowdb.Low(new node.JSONFile(file), { items: [] as Array<{ name: string; value: number }> });
        await reloaded.read();
        deepStrictEqual(reloaded.data.items, [{ name: 'answer', value: 42 }]);
    });
});

Deno.test({ name: 'lowdb: updates and rewrites records across reloads', timeout: 30000 }, async () => {
    const lowdb = await import('npm:lowdb');
    const node = await import('npm:lowdb/node');

    await withTempDir('npm-lowdb-update', async (dir) => {
        const file = join(dir, 'db.json');
        const db = new lowdb.Low(new node.JSONFile(file), { items: [] as Array<{ name: string; value: number }> });

        await db.read();
        db.data.items.push({ name: 'one', value: 1 }, { name: 'two', value: 2 });
        await db.write();

        db.data.items = db.data.items.filter(item => item.name !== 'one');
        db.data.items[0].value = 22;
        await db.write();

        const reloaded = new lowdb.Low(new node.JSONFile(file), { items: [] as Array<{ name: string; value: number }> });
        await reloaded.read();
        deepStrictEqual(reloaded.data.items, [{ name: 'two', value: 22 }]);
    });
});
