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
        throws(() => Reflect.apply(resolveSync, undefined, ['fs']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
        await rejects(Reflect.apply(resolve, undefined, ['fs']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
        bridge.resolveEsmForInspection = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
        throws(() => resolveSync('./missing', '/tmp'), { name: 'ResolveMessage', code: 'ERR_MODULE_NOT_FOUND' });
        await rejects(resolve('./missing', '/tmp'), { name: 'ResolveMessage', code: 'ERR_MODULE_NOT_FOUND' });
    } finally {
        bridge.resolveEsmForInspection = previous;
    }
});
