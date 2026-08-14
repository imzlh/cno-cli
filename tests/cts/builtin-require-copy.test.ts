import { notStrictEqual, ok, strictEqual } from 'node:assert';
import { CjsLoader, type CjsDeps } from '../../cts/src/compile/cjs.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';

function builtinInfo(name: string): ModuleInfo {
    return {
        specPath: `node:${name}`,
        localPath: `/cache/node/${name}/index.ts`,
        format: 'esm',
        fileKind: 'source',
    };
}

function makeLoader(namespaces: Record<string, Record<string, unknown>>): {
    loader: CjsLoader;
    loads: Record<string, number>;
} {
    const loads: Record<string, number> = {};
    const deps: CjsDeps = {
        resolveBuiltin: (name) => builtinInfo(name),
        loadEsmSync(info) {
            const name = info.specPath.slice('node:'.length);
            loads[name] = (loads[name] ?? 0) + 1;
            return namespaces[name]!;
        },
        resolveExternal: () => null,
        prepareSource: () => null,
    };
    return { loader: new CjsLoader(deps), loads };
}

Deno.test('cts builtin require: object defaults are copied and cached', () => {
    const sealedDefault = Object.preventExtensions(Object.assign(Object.create(null), {
        shared: () => 'sealed',
    })) as Record<string, unknown>;
    const extensibleDefault = { shared: () => 'extensible' };
    const { loader, loads } = makeLoader({
        os: { default: sealedDefault, namedOnly: 1 },
        util: { default: extensibleDefault, namedOnly: 2 },
    });
    const require = loader.mkRequire('/project/entry.cjs');

    for (const [name, source] of [
        ['os', sealedDefault],
        ['util', extensibleDefault],
    ] as const) {
        const first = require(name) as Record<string, unknown>;
        const second = require(`node:${name}`) as Record<string, unknown>;

        notStrictEqual(first, source, `${name}: require must not expose the ESM default`);
        strictEqual(second, first, `${name}: bare and node: forms share the cached copy`);
        strictEqual(Object.getPrototypeOf(first), Object.prototype);
        ok(Object.isExtensible(first));
        strictEqual(first.shared, source.shared);
        strictEqual(first.namedOnly, name === 'os' ? 1 : 2);
        strictEqual(loads[name], 1, `${name}: ESM namespace should load once`);

        first.requireOnly = name;
        strictEqual(source.requireOnly, undefined, `${name}: mutation leaked to ESM default`);
    }
});
