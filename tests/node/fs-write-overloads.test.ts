import { strictEqual } from 'node:assert';
import * as fs from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('fs.writeSync supports string position and encoding overload', async () => {
    await withTempDir('fs-write-sync-string-overload', async (root) => {
        const file = join(root, 'string-overload.txt');
        fs.writeFileSync(file, 'aaaaaa');
        const fd = fs.openSync(file, 'r+');
        try {
            strictEqual(fs.writeSync(fd, 'ZZ', 2, 'utf8'), 2);
        } finally {
            fs.closeSync(fd);
        }
        strictEqual(fs.readFileSync(file, 'utf8'), 'aaZZaa');
    });
});

Deno.test('fs.promises.FileHandle.write supports string position and encoding overload', async () => {
    await withTempDir('filehandle-write-string-overload', async (root) => {
        const file = join(root, 'string-position.txt');
        await writeFile(file, 'aaaaaa');
        const fh = await open(file, 'r+');
        try {
            const result = await fh.write('ZZ', 2, 'utf8');
            strictEqual(result.bytesWritten, 2);
            strictEqual(result.buffer, 'ZZ');
        } finally {
            await fh.close().catch(() => {});
        }
        strictEqual(await readFile(file, 'utf8'), 'aaZZaa');
    });
});
