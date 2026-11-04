import { strictEqual, throws } from 'node:assert';
import { file, write } from 'bun';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('bun: byte paths copy their exact UTF-8 view and support ArrayBuffers', async () => {
    await withTempDir('bun-file-byte-path', async root => {
        const path = join(root, '文件-é.txt');
        await write(path, 'contents');
        const encoded = new TextEncoder().encode(path);
        const backing = new Uint8Array(encoded.length + 4);
        backing.set(encoded, 2);
        const view = backing.subarray(2, -2);
        const target = file(view);
        const bufferTarget = file(encoded.buffer);
        const dataViewTarget = file(new DataView(encoded.buffer));
        backing.fill(0);
        encoded.fill(0);
        strictEqual(target.name, path);
        strictEqual(await target.text(), 'contents');
        strictEqual(await bufferTarget.text(), 'contents');
        strictEqual(await dataViewTarget.text(), 'contents');

        if (typeof SharedArrayBuffer !== 'undefined') {
            const bytes = new TextEncoder().encode(path);
            const shared = new SharedArrayBuffer(bytes.length);
            new Uint8Array(shared).set(bytes);
            const sharedTarget = file(shared);
            new Uint8Array(shared).fill(0);
            strictEqual(await sharedTarget.text(), 'contents');
        }
    });
});

Deno.test('bun: byte paths reject invalid UTF-8 and null bytes', async () => {
    await withTempDir('bun-file-byte-invalid', async root => {
        const prefix = new TextEncoder().encode(`${root}/`);
        const bytes = new Uint8Array(prefix.length + 5);
        bytes.set(prefix);
        bytes.set([0xff, 46, 116, 120, 116], prefix.length);
        await write(join(root, '\ufffd.txt'), 'replacement');
        throws(() => file(bytes), { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' });
        strictEqual(await file(join(root, '\ufffd.txt')).text(), 'replacement');
        throws(() => file(new Uint8Array([97, 0, 98])), { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' });
        throws(() => file(new Uint8Array()), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    });
});

Deno.test('bun: byte paths preserve a UTF-8 BOM and reject unrelated typed arrays', () => {
    strictEqual(file(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])).name, '\ufeffa');
    throws(
        () => file(new Uint16Array([0x61]) as unknown as Uint8Array<ArrayBuffer>),
        { name: 'TypeError' },
    );
});
