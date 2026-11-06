import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { getCtsBridge } from '../../cno/src/node/_internal/cts-bridge.ts';
import { resolve, resolveSync } from '../../cno/src/bun/resolve.ts';

Deno.test('Bun resolve wrapper passes a directory as a synthetic importer and returns the bridge result', async () => {
    const bridge = getCtsBridge()!;
    const previous = bridge.resolveEsmForInspection;
    const calls: string[][] = [];
    bridge.resolveEsmForInspection = (spec: string, parent: string) => {
        calls.push([spec, parent]);
        return 'node:fs';
    };
    try {
        strictEqual(resolveSync('fs', '/tmp/project'), 'node:fs');
        strictEqual(await resolve('fs', '/tmp/project'), 'node:fs');
        deepStrictEqual(calls, [['fs', '/tmp/project/__bun_resolve__.js'], ['fs', '/tmp/project/__bun_resolve__.js']]);
        throws(() => Reflect.apply(resolveSync, undefined, []), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'Expected a specifier and a from path' });
        throws(() => Reflect.apply(resolveSync, undefined, [undefined]), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'specifier must be a string' });
        throws(() => Reflect.apply(resolveSync, undefined, ['fs']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'Expected a from path' });
        await rejects(Reflect.apply(resolve, undefined, ['fs']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
        throws(() => resolveSync('fs', '/tmp/project', null as unknown as boolean), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'esm must be a boolean' });
        strictEqual(resolveSync('fs', '/tmp/project', false), 'node:fs');
        strictEqual(resolveSync('fs', '/tmp/project', true), 'node:fs');
        strictEqual(resolveSync(1, 2), 'node:fs');
        bridge.resolveEsmForInspection = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
        throws(() => resolveSync('./missing', '/tmp'), { name: 'ResolveMessage', code: 'ERR_MODULE_NOT_FOUND' });
        await rejects(resolve('./missing', '/tmp'), { name: 'ResolveMessage', code: 'ERR_MODULE_NOT_FOUND' });
    } finally {
        bridge.resolveEsmForInspection = previous;
    }
});

Deno.test('Bun resolve helpers have native function shapes', () => {
    for (const [fn, name] of [[resolve, 'resolve'], [resolveSync, 'resolveSync']] as const) {
        strictEqual(fn.name, name);
        strictEqual(fn.length, 1);
        strictEqual(Object.hasOwn(fn, 'prototype'), false);
        throws(() => Reflect.construct(fn as never, []), TypeError);
    }
});
