import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import {
    hasModuleLoadHooks,
    hasModuleResolveHooks,
    registerModuleHooks,
    runModuleLoadHooks,
    runModuleResolveHooks,
} from '../../cts/src/module-hooks.ts';
import { resolveWithModuleHooks } from '../../cts/src/runtime/meta.ts';
import type { ModuleResolver } from '../../cts/src/resolve/index.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';

Deno.test('module hooks: resolve chain snapshots registrations and retains context defaults', () => {
    const context = { parentURL: 'file:///entry.mjs' };
    const override = { parentURL: 'file:///override.mjs' };
    const calls: string[] = [];
    const older = registerModuleHooks({
        resolve(specifier, received, next) {
            calls.push('older');
            strictEqual(received, override);
            return next(`${specifier}/child`);
        },
    });
    const loadOnly = registerModuleHooks({ load() { throw new Error('load hook ran during resolve'); } });
    const newer = registerModuleHooks({
        resolve(specifier, received, next) {
            calls.push('newer');
            strictEqual(received, context);
            older.deregister();
            older.deregister();
            return next(specifier, override);
        },
    });
    try {
        const result = runModuleResolveHooks('probe', context, (specifier, received) => {
            calls.push('terminal');
            strictEqual(received, context);
            return { url: specifier };
        });
        strictEqual(result.url, 'probe/child');
        deepStrictEqual(calls, ['newer', 'older', 'terminal']);

        calls.length = 0;
        runModuleResolveHooks('probe', context, (specifier, received) => {
            calls.push('terminal');
            strictEqual(received, override);
            return { url: specifier };
        });
        deepStrictEqual(calls, ['newer', 'terminal']);
        newer.deregister();
        newer.deregister();
        strictEqual(hasModuleResolveHooks(), false);
        strictEqual(hasModuleLoadHooks(), true);
    } finally {
        newer.deregister();
        loadOnly.deregister();
        older.deregister();
    }
});

Deno.test('module hooks: load chain preserves order, short circuits and thrown errors', () => {
    const calls: string[] = [];
    const failure = new Error('hook failure');
    const older = registerModuleHooks({
        load(url, context, next) {
            calls.push('older');
            if (url === 'fail') throw failure;
            return next(url, context);
        },
    });
    const newer = registerModuleHooks({
        load(url, context, next) {
            calls.push('newer');
            return url === 'virtual' ? { source: 'virtual source', shortCircuit: true } : next(url, context);
        },
    });
    const terminal = () => {
        calls.push('terminal');
        return { source: 'file source' };
    };
    try {
        strictEqual(runModuleLoadHooks('file', {}, terminal).source, 'file source');
        deepStrictEqual(calls, ['newer', 'older', 'terminal']);
        calls.length = 0;
        strictEqual(runModuleLoadHooks('virtual', {}, terminal).source, 'virtual source');
        deepStrictEqual(calls, ['newer']);
        calls.length = 0;
        throws(() => runModuleLoadHooks('fail', {}, terminal), (error) => error === failure);
        deepStrictEqual(calls, ['newer', 'older']);
    } finally {
        newer.deregister();
        older.deregister();
    }
    strictEqual(hasModuleLoadHooks(), false);
});

Deno.test('module hooks: returning an earlier nextResolve result preserves its ModuleInfo', () => {
    const parent: ModuleInfo = {
        specPath: 'npm:parent@1.0.0/index.js',
        localPath: '/cache/parent/index.js',
        format: 'esm',
        fileKind: 'source',
    };
    const first: ModuleInfo = {
        specPath: 'npm:first@1.0.0/index.js',
        localPath: '/cache/first/index.js',
        format: 'esm',
        fileKind: 'source',
    };
    const second: ModuleInfo = {
        specPath: 'npm:second@1.0.0/index.js',
        localPath: '/cache/second/index.js',
        format: 'esm',
        fileKind: 'source',
    };
    const resolver = {
        getInfo(specifier: string): ModuleInfo {
            if (specifier === parent.specPath) return parent;
            throw new Error(`unexpected getInfo: ${specifier}`);
        },
        resolve(specifier: string): ModuleInfo {
            if (specifier === 'first') return first;
            if (specifier === 'second') return second;
            throw new Error(`canonical result was resolved again: ${specifier}`);
        },
    } as unknown as ModuleResolver;

    const controller = registerModuleHooks({
        resolve(_specifier, context, nextResolve) {
            const firstResult = nextResolve('first', context);
            nextResolve('second', context);
            return { ...firstResult };
        },
    });

    try {
        const resolved = resolveWithModuleHooks(resolver, 'probe', parent.specPath);
        strictEqual(resolved, first);
    } finally {
        controller.deregister();
    }
});
