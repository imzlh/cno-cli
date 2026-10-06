import { deepStrictEqual, strictEqual } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('fs streams: destroy during open closes once without reading or writing', async () => {
    await withTempDir('fs-stream-destroy-opening', async root => {
        const path = join(root, 'data.txt');
        fs.writeFileSync(path, 'original');
        for (const create of [fs.createReadStream, fs.createWriteStream]) {
            const stream = create(path, { flags: 'r+' });
            const events: string[] = [];
            const closed = new Promise<void>((resolve, reject) => {
                stream.on('error', reject);
                stream.on('data', () => events.push('data'));
                stream.on('end', () => events.push('end'));
                stream.on('finish', () => events.push('finish'));
                stream.on('close', () => { events.push('close'); resolve(); });
            });
            stream.destroy();
            stream.destroy();
            await closed;
            deepStrictEqual(events, ['close']);
            strictEqual(stream.destroyed, true);
            strictEqual(stream.closed, true);
            strictEqual(fs.readFileSync(path, 'utf8'), 'original');
        }
    });
});

Deno.test('fs streams: open failure with pending I/O reports one error then close', async () => {
    await withTempDir('fs-stream-open-error', async root => {
        const path = join(root, 'missing', 'file.txt');
        for (const create of [fs.createReadStream, fs.createWriteStream]) {
            const stream = create(path);
            const events: string[] = [];
            const closed = new Promise<void>(resolve => {
                stream.on('open', () => events.push('open'));
                stream.on('ready', () => events.push('ready'));
                stream.on('error', error => events.push(`error:${(error as NodeJS.ErrnoException).code}`));
                stream.on('close', () => { events.push('close'); resolve(); });
            });
            if (stream instanceof fs.ReadStream) stream.resume();
            else stream.end('pending write');
            await closed;
            deepStrictEqual(events, ['error:ENOENT', 'close']);
            strictEqual(stream.closed, true);
        }
    });
});
