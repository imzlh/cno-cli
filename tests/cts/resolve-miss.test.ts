import { ok, strictEqual, throws } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCjsDeps } from '../../cts/src/compile/bridge.ts';
import { err, ErrorKind, isResolutionMiss } from '../../cts/src/errors.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';
import type { ModuleResolver } from '../../cts/src/resolve/index.ts';
import type { EsmCompiler } from '../../cts/src/compile/esm.ts';

Deno.test('cts isResolutionMiss: only ModuleNotFound/FileNotFound/MODULE_NOT_FOUND/ENOENT', () => {
    ok(isResolutionMiss(err(ErrorKind.ModuleNotFound, 'Cannot find module x')));
    ok(isResolutionMiss(err(ErrorKind.FileNotFound, 'File not found: x')));
    const codeOnly = new Error('missing');
    Reflect.set(codeOnly, 'code', 'MODULE_NOT_FOUND');
    ok(isResolutionMiss(codeOnly));
    const enoent = new Error('enoent');
    Reflect.set(enoent, 'code', 'ENOENT');
    ok(isResolutionMiss(enoent));

    ok(!isResolutionMiss(err(ErrorKind.ProtocolDisabled, 'Protocol "https:" is disabled')));
    ok(!isResolutionMiss(err(ErrorKind.NetworkError, 'fetch failed')));
    ok(!isResolutionMiss(err(ErrorKind.LockFrozen, 'Module not in lock')));
    ok(!isResolutionMiss(err(ErrorKind.InvalidSpecifier, 'bad')));
    ok(!isResolutionMiss(err(ErrorKind.PermissionError, 'EACCES')));
    ok(!isResolutionMiss(err(ErrorKind.VersionNotFound, 'no version')));
    ok(!isResolutionMiss(new Error('plain')));
    ok(!isResolutionMiss('string'));
});

Deno.test('cts bridge resolveExternal: miss → null; non-miss rethrows', () => {
    const hit: ModuleInfo = {
        specPath: '/hit.js',
        localPath: '/hit.js',
        format: 'cjs',
        fileKind: 'source',
    };
    const resolver = {
        resolve(req: string, _parent: string, _opts?: { cjs?: boolean }): ModuleInfo {
            if (req === './hit.js') return hit;
            if (req === 'missing-pkg') throw err(ErrorKind.ModuleNotFound, `Cannot find module '${req}'`);
            if (req.startsWith('https://')) {
                throw err(ErrorKind.ProtocolDisabled, 'Protocol "https:" is disabled');
            }
            if (req.startsWith('http://')) {
                throw err(ErrorKind.NetworkError, `HTTP 500 fetching ${req}`);
            }
            if (req === 'frozen-mod') throw err(ErrorKind.LockFrozen, 'Module not in lock: frozen-mod');
            throw err(ErrorKind.Generic, `unexpected ${req}`);
        },
        getCachedMtime() { return undefined; },
        packParentRef() { return null; },
    } as unknown as ModuleResolver;

    const esm = {
        transformer: { transformForCjs: () => null },
        jsc: {
            loadCompiled: () => null,
            persistBytecode: () => {},
        },
        load() { throw new Error('esm.load not used'); },
    } as unknown as EsmCompiler;

    const deps = buildCjsDeps(resolver, esm);

    strictEqual(deps.resolveExternal('./hit.js', '/parent.cjs'), hit);
    strictEqual(deps.resolveExternal('missing-pkg', '/parent.cjs'), null);

    throws(
        () => deps.resolveExternal('https://example.com/x.js', '/parent.cjs'),
        (e: unknown) => {
            ok(e instanceof Error);
            strictEqual(e.kind, ErrorKind.ProtocolDisabled);
            ok(/Protocol "https:" is disabled/.test(e.message));
            return true;
        },
    );
    throws(
        () => deps.resolveExternal('http://example.com/y.js', '/parent.cjs'),
        (e: unknown) => {
            ok(e instanceof Error);
            strictEqual(e.kind, ErrorKind.NetworkError);
            return true;
        },
    );
    throws(
        () => deps.resolveExternal('frozen-mod', '/parent.cjs'),
        (e: unknown) => {
            ok(e instanceof Error);
            strictEqual(e.kind, ErrorKind.LockFrozen);
            return true;
        },
    );
});

Deno.test('cts bridge: resolveExternal uses isResolutionMiss (structural)', () => {
    const src = readFileSync(join(import.meta.dirname!, '../../cts/src/compile/bridge.ts'), 'utf8');
    const start = src.indexOf('resolveExternal(req: string, parent: string)');
    ok(start >= 0);
    const body = src.slice(start, start + 400);
    ok(body.includes('isResolutionMiss'));
    ok(/if\s*\(\s*isResolutionMiss\s*\(/.test(body));
    ok(!/catch\s*\{\s*return null;\s*\}/.test(body.replace(/\s+/g, ' ')));
});
