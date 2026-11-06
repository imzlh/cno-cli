import { strictEqual, throws } from 'node:assert';
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

Deno.test('bun: file URL conversions reject invalid inputs and encoded separators', () => {
    throws(() => fileURLToPath('https://example.com/a'), { name: 'TypeError', code: 'ERR_INVALID_URL_SCHEME' });
    throws(() => fileURLToPath('npm:package'), TypeError);
    throws(() => fileURLToPath('relative/path'), TypeError);
    throws(() => fileURLToPath(new URL('https://example.com/a')), TypeError);
    throws(() => fileURLToPath('file:///tmp/a%2Fb'), TypeError);
    for (const value of [null, undefined, false, 0, 1n, Symbol('url'), {}, new String('file:///tmp/a')]) {
        throws(() => fileURLToPath(value as never), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    }
    throws(() => fileURLToPath(new Proxy(new URL('file:///tmp/a'), {})), {
        name: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
    });
});
