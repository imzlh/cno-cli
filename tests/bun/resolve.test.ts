import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { resolve as resolvePath } from 'node:path';
import { getCtsBridge } from '../../cno/src/node/_internal/cts-bridge.ts';
import { resolve, resolveSync } from '../../cno/src/bun/resolve.ts';

Deno.test('Bun resolve wrapper passes a directory as a synthetic importer and returns the bridge result', async () => {
    const bridge = getCtsBridge()!;
    const previous = bridge.resolveEsmForInspection;
    const calls: Array<[string, string, boolean]> = [];
    bridge.resolveEsmForInspection = (spec: string, parent: string, esm: boolean) => {
        calls.push([spec, parent, esm]);
        return 'node:fs';
    };
    try {
        strictEqual(resolveSync('fs', '/tmp/project'), 'node:fs');
        strictEqual(await resolve('fs', '/tmp/project'), 'node:fs');
        const importer = resolvePath('/tmp/project/__bun_resolve__.js');
        deepStrictEqual(calls, [['fs', importer, true], ['fs', importer, true]]);
        throws(() => Reflect.apply(resolveSync, undefined, []), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'Expected a specifier and a from path' });
        throws(() => Reflect.apply(resolveSync, undefined, [undefined]), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'specifier must be a string' });
        throws(() => Reflect.apply(resolveSync, undefined, ['fs']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'Expected a from path' });
        await rejects(Reflect.apply(resolve, undefined, ['fs']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
        throws(() => resolveSync('fs', '/tmp/project', null as unknown as boolean), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'esm must be a boolean' });
        throws(() => Reflect.apply(resolveSync, undefined, ['fs', '/tmp/project', undefined]), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'esm must be a boolean' });
        throws(() => Reflect.apply(resolveSync, undefined, [null, '/tmp/project', 'bad']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'specifier must be a string' });
        throws(() => Reflect.apply(resolveSync, undefined, ['fs', null, 'bad']), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'from must be a string' });
        strictEqual(resolveSync('fs', '/tmp/project', false), 'node:fs');
        strictEqual(resolveSync('fs', '/tmp/project', true), 'node:fs');
        strictEqual(resolveSync(1, 2), 'node:fs');
        deepStrictEqual(calls.slice(-3).map(([spec, , mode]) => [spec, mode]), [
            ['fs', false],
            ['fs', true],
            ['1', true],
        ]);
        throws(() => resolveSync(Symbol('fs'), '/tmp/project'), { name: 'TypeError', message: 'Cannot convert a symbol to a string' });
        const coercions: string[] = [];
        throws(() => resolveSync({ [Symbol.toPrimitive]: () => Symbol('fs') }, '/tmp/project'), {
            name: 'TypeError',
            message: 'Cannot convert a symbol to a string',
        });
        throws(() => resolveSync({ toString: () => { coercions.push('specifier'); return 'fs'; } }, Symbol('/tmp/project')), {
            name: 'TypeError',
            message: 'Cannot convert a symbol to a string',
        });
        deepStrictEqual(coercions, ['specifier']);
        bridge.resolveEsmForInspection = () => { throw Object.assign(new Error('invalid'), { code: 'ERR_INVALID_MODULE_SPECIFIER' }); };
        throws(() => resolveSync('', '/tmp'), {
            name: 'ResolveMessage',
            code: 'ERR_MODULE_NOT_FOUND',
            message: "Cannot find module '' imported from /tmp",
        });
        bridge.resolveEsmForInspection = () => { throw Object.assign(new Error('missing'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }); };
        throws(() => resolveSync('node:not-a-builtin', '/tmp'), {
            name: 'ResolveMessage',
            code: 'ERR_UNKNOWN_BUILTIN_MODULE',
            message: 'No such built-in module: node:not-a-builtin',
        });
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
