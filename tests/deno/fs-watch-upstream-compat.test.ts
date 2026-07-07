import { ok, strictEqual, throws } from 'node:assert';
import { basename, join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeWatcher(watcher: Deno.FsWatcher): Promise<void> {
    watcher.close();
    await sleep(50);
}

async function nextEvent(watcher: Deno.FsWatcher, timeout = 3000): Promise<Deno.FsEvent> {
    const iterator = watcher[Symbol.asyncIterator]();
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for fs event')), timeout);
    });
    const result = await Promise.race([iterator.next(), timeoutPromise]);
    ok(!result.done, 'watcher should yield an event before closing');
    return result.value;
}

Deno.test({ name: 'deno fs upstream: watchFs yields file events and close ends iteration', timeout: 10000 }, async () => {
    await withTempDir('deno-watchfs', async (root) => {
        const watcher = Deno.watchFs(root);
        try {
            await sleep(150);
            const file = join(root, 'created.txt');
            Deno.writeTextFileSync(file, 'created');

            const event = await nextEvent(watcher);
            ok(['any', 'rename', 'modify', 'create', 'remove', 'other'].includes(event.kind));
            ok(event.paths.some(path => basename(path) === 'created.txt'));
            ok(event.paths.every(path => typeof path === 'string' && path.length > 0));

            await closeWatcher(watcher);
            const closed = await watcher[Symbol.asyncIterator]().next();
            strictEqual(closed.done, true);
        } finally {
            await closeWatcher(watcher);
        }
    });
});

Deno.test({ name: 'deno fs upstream: watchFs ignore filters contained paths', timeout: 10000 }, async () => {
    await withTempDir('deno-watchfs', async (root) => {
        const ignored = join(root, 'ignored');
        Deno.mkdirSync(ignored);
        const watcher = Deno.watchFs(root, { ignore: ignored });
        const seen: Deno.FsEvent[] = [];
        try {
            await sleep(150);
            Deno.writeTextFileSync(join(ignored, 'hidden.txt'), 'hidden');
            const visible = join(root, 'visible.txt');
            Deno.writeTextFileSync(visible, 'visible');

            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                const event = await nextEvent(watcher, Math.max(200, deadline - Date.now()));
                seen.push(event);
                if (event.paths.some(path => basename(path) === 'visible.txt')) break;
            }

            ok(seen.some(event => event.paths.some(path => basename(path) === 'visible.txt')));
            ok(seen.every(event => event.paths.every(path => !path.includes(`${ignored}/`))));
        } finally {
            await closeWatcher(watcher);
        }
    });
});

Deno.test({ name: 'deno fs upstream: watchFs supports multiple roots and iterator return', timeout: 10000 }, async () => {
    await withTempDir('deno-watchfs-multi', async (root) => {
        const one = join(root, 'one');
        const two = join(root, 'two');
        Deno.mkdirSync(one);
        Deno.mkdirSync(two);

        const watcher = Deno.watchFs([one, two]);
        const iterator = watcher[Symbol.asyncIterator]();
        try {
            await sleep(150);
            Deno.writeTextFileSync(join(two, 'from-two.txt'), 'created');

            const event = await nextEvent(watcher);
            ok(event.paths.some(path => basename(path) === 'from-two.txt'));

            const returned = await iterator.return?.();
            strictEqual(returned?.done, true);
            const closed = await iterator.next();
            strictEqual(closed.done, true);
        } finally {
            await closeWatcher(watcher);
        }
    });
});

Deno.test('deno fs upstream: watchFs throws for missing paths', async () => {
    await withTempDir('deno-watchfs-missing', async (root) => {
        throws(() => Deno.watchFs(join(root, 'missing')), Deno.errors.NotFound);
    });
});

Deno.test({ name: 'deno fs upstream: watchFs is recursive by default', timeout: 10000 }, async () => {
    await withTempDir('deno-watchfs-recursive', async (root) => {
        const nested = join(root, 'nested');
        Deno.mkdirSync(nested);
        const watcher = Deno.watchFs(root);
        try {
            await sleep(150);
            Deno.writeTextFileSync(join(nested, 'deep.txt'), 'deep');

            const event = await nextEvent(watcher);
            ok(event.paths.some(path => basename(path) === 'deep.txt'));
        } finally {
            await closeWatcher(watcher);
        }
    });
});

Deno.test({ name: 'deno fs upstream: watchFs recursive false excludes nested file events', timeout: 10000 }, async () => {
    await withTempDir('deno-watchfs-nonrecursive', async (root) => {
        const nested = join(root, 'nested');
        Deno.mkdirSync(nested);
        const watcher = Deno.watchFs(root, { recursive: false });
        const seen: Deno.FsEvent[] = [];
        try {
            await sleep(150);
            Deno.writeTextFileSync(join(nested, 'hidden.txt'), 'hidden');
            Deno.writeTextFileSync(join(root, 'visible.txt'), 'visible');

            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                const event = await nextEvent(watcher, Math.max(200, deadline - Date.now()));
                seen.push(event);
                if (event.paths.some(path => basename(path) === 'visible.txt')) break;
            }

            ok(seen.some(event => event.paths.some(path => basename(path) === 'visible.txt')));
            ok(seen.every(event => event.paths.every(path => basename(path) !== 'hidden.txt')));
        } finally {
            await closeWatcher(watcher);
        }
    });
});
