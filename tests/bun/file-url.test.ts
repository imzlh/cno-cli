import { strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from '../../cno/src/bun/utils/file-url.ts';

Deno.test('bun: file URLs round-trip paths and escape URL metacharacters', () => {
    const path = `${Deno.cwd()}/bun file #%?.txt`;
    const url = pathToFileURL(path);
    strictEqual(url.protocol, 'file:');
    strictEqual(url.href.includes('bun%20file%20%23%25%3F.txt'), true);
    strictEqual(fileURLToPath(url), path);
    strictEqual(fileURLToPath(url.href), path);
    strictEqual(pathToFileURL('bun-file').href, pathToFileURL(`${Deno.cwd()}/bun-file`).href);
    strictEqual(pathToFileURL(42 as never).pathname.endsWith('/42'), true);
    strictEqual(pathToFileURL(null as never).pathname.endsWith('/null'), true);
    throws(() => pathToFileURL(Symbol('path') as never), {
        name: 'TypeError',
        message: 'Cannot convert a symbol to a string',
    });
});

Deno.test('bun: pathToFileURL coerces once across realms and is not constructable', () => {
    let calls = 0;
    const value = {
        [Symbol.toPrimitive](hint: string) {
            calls++;
            strictEqual(hint, 'string');
            return 'coerced/path';
        },
    };
    strictEqual(pathToFileURL(value as never).pathname.endsWith('/coerced/path'), true);
    strictEqual(calls, 1);

    const foreignString = runInNewContext('new String("foreign/path")');
    strictEqual(pathToFileURL(foreignString as never).pathname.endsWith('/foreign/path'), true);
    throws(() => pathToFileURL(runInNewContext('Object(Symbol("path"))') as never), TypeError);

    strictEqual(pathToFileURL.name, 'pathToFileURL');
    strictEqual(pathToFileURL.length, 1);
    strictEqual(Object.hasOwn(pathToFileURL, 'prototype'), false);
    throws(() => new (pathToFileURL as any)('constructed/path'), TypeError);

    strictEqual(fileURLToPath.name, 'fileURLToPath');
    strictEqual(fileURLToPath.length, 1);
    strictEqual(Object.hasOwn(fileURLToPath, 'prototype'), false);
    throws(() => new (fileURLToPath as any)('file:///constructed/path'), TypeError);
});

Deno.test('bun: pathToFileURL follows host separator rules', () => {
    if (Deno.build.os === 'windows') return;
    const path = 'directory\\..\\file';
    const url = pathToFileURL(path);
    strictEqual(url.pathname.endsWith('/directory%5C..%5Cfile'), true);
    strictEqual(fileURLToPath(url), `${Deno.cwd()}/${path}`);
});

Deno.test('bun: fileURLToPath applies URL string preprocessing', () => {
    const path = `${Deno.cwd()}/preprocessed-file-url`;
    const href = pathToFileURL(path).href;
    strictEqual(fileURLToPath(` \0${href}\t\n`), path);
    strictEqual(fileURLToPath(href.replace('file:', 'fi\nle:')), path);
});

Deno.test('bun: fileURLToPath follows Bun percent-decoding rules', () => {
    const href = (path: string) => Deno.build.os === 'windows' ? `file:///C:/${path}` : `file:///${path}`;
    const expected = (path: string) => Deno.build.os === 'windows' ? `C:\\${path}` : `/${path}`;
    strictEqual(fileURLToPath(href('a%')), expected('a%'));
    strictEqual(fileURLToPath(href('a%Z')), expected('a%Z'));
    strictEqual(fileURLToPath(href('a%2')), expected('a%2'));
    strictEqual(fileURLToPath(href('a%25')), expected('a%'));
    strictEqual(
        fileURLToPath(`${href('%E6%B7%B7%E5%90%88中%20path')}?query=%FF#fragment=%FF`),
        expected('混合中 path'),
    );
    strictEqual(fileURLToPath(href('prefix%FFsuffix')), '');
    strictEqual(fileURLToPath(href('prefix%E4suffix')), '');
    strictEqual(fileURLToPath(href('prefix%C0%AFsuffix')), '');
    if (Deno.build.os !== 'windows') strictEqual(fileURLToPath('file:///a%5Cb'), '/a\\b');
});

Deno.test('bun: fileURLToPath percent decoding uses intrinsic URL and error brands', () => {
    const intrinsicHref = Deno.build.os === 'windows' ? 'file:///C:/intrinsic%' : 'file:///intrinsic%';
    const intrinsicPath = Deno.build.os === 'windows' ? 'C:\\intrinsic%' : '/intrinsic%';
    class PoisonedAccessorsURL extends URL {
        get href(): string { throw new URIError('shadowed href getter ran'); }
        get protocol(): string { throw new URIError('shadowed protocol getter ran'); }
        get pathname(): string { throw new URIError('shadowed pathname getter ran'); }
        get hostname(): string { throw new URIError('shadowed hostname getter ran'); }
    }
    const url = new PoisonedAccessorsURL(intrinsicHref);
    strictEqual(fileURLToPath(url), intrinsicPath);

    const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'URL')!;
    const uriErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'URIError')!;
    try {
        Object.defineProperty(globalThis, 'URL', {
            ...urlDescriptor,
            value: class PoisonedURL { constructor() { throw new Error('poisoned URL'); } },
        });
        Object.defineProperty(globalThis, 'URIError', { ...uriErrorDescriptor, value: TypeError });
        const stableHref = Deno.build.os === 'windows' ? 'file:///C:/stable%' : 'file:///stable%';
        const stablePath = Deno.build.os === 'windows' ? 'C:\\stable%' : '/stable%';
        const invalidHref = Deno.build.os === 'windows' ? 'file:///C:/invalid%FF' : 'file:///invalid%FF';
        const slashHref = Deno.build.os === 'windows' ? 'file:///C:/encoded%2Fslash' : 'file:///encoded%2Fslash';
        strictEqual(fileURLToPath(stableHref), stablePath);
        strictEqual(fileURLToPath(invalidHref), '');
        throws(() => fileURLToPath(slashHref), {
            name: 'TypeError',
            code: 'ERR_INVALID_FILE_URL_PATH',
        });
    } finally {
        Object.defineProperty(globalThis, 'URL', urlDescriptor);
        Object.defineProperty(globalThis, 'URIError', uriErrorDescriptor);
    }
});

Deno.test('bun: file URL conversions reject invalid inputs and encoded separators', () => {
    throws(() => fileURLToPath('https://example.com/a'), { name: 'TypeError', code: 'ERR_INVALID_URL_SCHEME' });
    throws(() => fileURLToPath('npm:package'), TypeError);
    throws(() => fileURLToPath('relative/path'), TypeError);
    throws(() => fileURLToPath(new URL('https://example.com/a')), TypeError);
    throws(() => fileURLToPath('file:///tmp/a%2Fb'), TypeError);
    throws(() => fileURLToPath('file:///tmp/a%2fb'), TypeError);
    for (const value of [null, undefined, false, 0, 1n, Symbol('url'), {}, new String('file:///tmp/a')]) {
        throws(() => fileURLToPath(value as never), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    }
    throws(() => fileURLToPath(new Proxy(new URL('file:///tmp/a'), {})), {
        name: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
    });
});
