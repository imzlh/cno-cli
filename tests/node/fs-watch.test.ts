import { strictEqual, ok } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const WATCH_DIR = path.join(os.tmpdir(), `cno-fswatch-${process.pid}`);

// --- 1. fs.watch returns an FSWatcher ---------------------------------------

Deno.test('fs.watch: returns an FSWatcher', async () => {
    await fsp.mkdir(WATCH_DIR, { recursive: true });
    try {
        const w = fs.watch(WATCH_DIR);
        ok(w);
        ok(typeof w.close === 'function');
        w.close();
    } finally {
        await fsp.rm(WATCH_DIR, { recursive: true, force: true });
    }
});

// --- 2. fs.watch emits 'change' on file modification ------------------------

Deno.test('fs.watch: emits change on file write', async () => {
    await fsp.mkdir(WATCH_DIR, { recursive: true });
    const target = path.join(WATCH_DIR, 'file.txt');
    await fsp.writeFile(target, 'initial');

    let sawChange = false;
    const w = fs.watch(target, (eventType, filename) => {
        if (eventType === 'change') sawChange = true;
    });

    // give watcher time to register, then mutate
    await new Promise((r) => setTimeout(r, 150));
    await fsp.writeFile(target, 'modified');

    // wait for event to propagate
    await new Promise((r) => setTimeout(r, 300));
    w.close();

    ok(sawChange, 'fs.watch must emit change event on file write');
    await fsp.rm(WATCH_DIR, { recursive: true, force: true });
});

// --- 3. fs.watch with recursive option (if supported) -----------------------

Deno.test('fs.watch: recursive option accepted', async () => {
    await fsp.mkdir(WATCH_DIR, { recursive: true });
    try {
        let w: any;
        try {
            w = fs.watch(WATCH_DIR, { recursive: true });
            ok(w, 'recursive watch must be accepted');
        } catch (e: any) {
            // if unsupported, must throw ENOSYS-like, not crash
            ok(/not support|ENO/i.test(e.message) || w, 'unsupported recursive must throw cleanly');
        } finally {
            if (w) w.close();
        }
    } finally {
        await fsp.rm(WATCH_DIR, { recursive: true, force: true });
    }
});

// --- 4. FSWatcher.close fires 'close' event ---------------------------------

Deno.test('fs.watch: FSWatcher.close fires close event', async () => {
    await fsp.mkdir(WATCH_DIR, { recursive: true });
    try {
        const w = fs.watch(WATCH_DIR);
        let closed = false;
        w.on('close', () => { closed = true; });
        w.close();
        await new Promise((r) => setTimeout(r, 30));
        ok(closed, 'close must emit');
    } finally {
        await fsp.rm(WATCH_DIR, { recursive: true, force: true });
    }
});

// --- 5. fs.watchFile / unwatchFile -------------------------------------------

Deno.test('fs.watchFile + unwatchFile', async () => {
    await fsp.mkdir(WATCH_DIR, { recursive: true });
    const target = path.join(WATCH_DIR, 'wf.txt');
    await fsp.writeFile(target, 'a');

    let changes = 0;
    const listener = (curr: fs.Stats, prev: fs.Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs) changes++;
    };
    fs.watchFile(target, { interval: 50 }, listener);

    await new Promise((r) => setTimeout(r, 100));
    await fsp.writeFile(target, 'b');
    await new Promise((r) => setTimeout(r, 200));

    fs.unwatchFile(target, listener);
    await fsp.rm(WATCH_DIR, { recursive: true, force: true });

    ok(changes >= 1, `watchFile must report >=1 change, got ${changes}`);
});

// --- 6. fs.unwatchFile without listener is safe -----------------------------

Deno.test('fs.unwatchFile without prior watch is safe', async () => {
    await fsp.mkdir(WATCH_DIR, { recursive: true });
    const target = path.join(WATCH_DIR, 'wf2.txt');
    await fsp.writeFile(target, 'x');
    // should not throw
    fs.unwatchFile(target);
    await fsp.rm(WATCH_DIR, { recursive: true, force: true });
});
