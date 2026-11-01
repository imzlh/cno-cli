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
});

Deno.test('bun: file URL conversions reject invalid inputs and encoded separators', () => {
    throws(() => fileURLToPath('https://example.com/a'), TypeError);
    throws(() => fileURLToPath('npm:package'), TypeError);
    throws(() => fileURLToPath('relative/path'), TypeError);
    throws(() => fileURLToPath(new URL('https://example.com/a')), TypeError);
    throws(() => fileURLToPath('file:///tmp/a%2Fb'), TypeError);
    throws(() => pathToFileURL(1 as unknown as string), TypeError);
    throws(() => fileURLToPath(null as unknown as string), TypeError);
});
