import { strictEqual } from 'node:assert';
import { registerModuleHooks } from '../../cts/src/module-hooks.ts';
import { resolveWithModuleHooks } from '../../cts/src/runtime/meta.ts';
import type { ModuleResolver } from '../../cts/src/resolve/index.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';

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
