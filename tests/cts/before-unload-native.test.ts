/**
 * Native lifecycle teardown on NATURAL DRAIN: 'beforeunload', 'unload' and
 * process 'exit'.
 *
 * These three are dead in the staged binary and cannot be fixed from JS. The
 * engine event enum had only four members (circu.js/src/private.h), so no native
 * 'beforeunload' existed at all; and EV_EXIT was dispatched only from
 * os.exit (circu.js/src/mod_os.c) and uv__stop (circu.js/src/vm.c), while
 * TJS_Run's loop returned without dispatching anything. A `cno run` that exits
 * by falling off the end therefore fired nothing.
 *
 * OBSERVED before-state, staged cno.exe: a script registering all three
 * listeners and draining naturally prints none of them and exits 0.
 *
 * WHAT THIS FILE IS FOR
 *
 * Every case here runs a real subprocess and asserts on process-level
 * behaviour, because that is the only thing that can distinguish a native
 * dispatch from an in-process simulation. Cases 1-2 and 5-6 must FAIL before a
 * rebuild — that is the honest before-state, not a broken test. Cases 3-4 and
 * 7-8 pass vacuously now and exist to catch the two regressions the first
 * proposed patch would have introduced: an inverted cancel polarity (which hangs
 * every run, since the JS multiplexer returns `false` for an unrecognised event
 * id) and a 'beforeunload' that wrongly fires on an explicit exit.
 *
 * The contract asserted below was measured against real Deno 2.9.3, not
 * inferred. Re-dispatch is unbounded there: a listener that cancels forever
 * spins forever, so no case here cancels without eventually relenting.
 */
import { ok, strictEqual } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';
import { join } from 'node:path';

const TIMEOUT_MS = 20_000;

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/**
 * Run a script under the binary under test.
 *
 * A timeout is mandatory here rather than defensive: the failure mode of a
 * wrong cancel polarity is an infinite re-dispatch loop, and without a kill this
 * file would wedge the whole suite instead of reporting a failure.
 */
async function runScript(source: string): Promise<RunResult> {
    return await withTempDir('lifecycle', async (dir: string) => {
        const file = join(dir, 'lifecycle-entry.ts');
        await Deno.writeTextFile(file, source);

        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const child = new Deno.Command(execPath, {
            args: ['run', '-A', file],
            stdout: 'piped',
            stderr: 'piped',
            env: { CTS_SILENT: 'true' },
        }).spawn();

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill('SIGKILL');
            } catch {
                // Already gone.
            }
        }, TIMEOUT_MS);

        try {
            const output = await child.output();
            return {
                code: output.code,
                stdout: decodeUtf8(output.stdout),
                stderr: decodeUtf8(output.stderr),
                timedOut,
            };
        } finally {
            clearTimeout(timer);
        }
    });
}

/** Ordered list of the MARK: lines a script emitted. */
function marks(r: RunResult): string[] {
    return r.stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith('MARK:'))
        .map((l) => l.slice('MARK:'.length).trim());
}

/* ---------------------------------------------------------------- *
 * 1-2: the two behaviours that are dead today. MUST FAIL pre-rebuild.
 * ---------------------------------------------------------------- */

Deno.test("natural drain fires 'unload' and process 'exit' exactly once", async () => {
    const r = await runScript(`
        import process from 'node:process';
        globalThis.addEventListener('unload', () => console.log('MARK: unload'));
        process.on('exit', (c) => console.log('MARK: process-exit ' + c));
        // Real async work, so the drain is a genuine loop drain and not just an
        // empty-loop shortcut.
        await new Promise((res) => setTimeout(res, 30));
        console.log('MARK: body-done');
    `);

    ok(!r.timedOut, 'timed out: teardown re-dispatched without terminating');
    strictEqual(r.code, 0, r.stderr);
    const m = marks(r);
    strictEqual(m[0], 'body-done', `body must finish first, got ${JSON.stringify(m)}`);
    strictEqual(m.filter((x) => x === 'unload').length, 1, `unload once, got ${JSON.stringify(m)}`);
    strictEqual(
        m.filter((x) => x === 'process-exit 0').length,
        1,
        `process exit once with code 0, got ${JSON.stringify(m)}`,
    );
});

Deno.test("natural drain fires 'beforeunload' before 'unload', cancelable", async () => {
    const r = await runScript(`
        globalThis.addEventListener('beforeunload', (e) => {
            console.log('MARK: beforeunload cancelable=' + e.cancelable);
        });
        globalThis.addEventListener('unload', () => console.log('MARK: unload'));
    `);

    ok(!r.timedOut, 'timed out');
    strictEqual(r.code, 0, r.stderr);
    const m = marks(r);
    // Deno 2.9.3: cancelable=true on beforeunload, false on unload (OBSERVED).
    strictEqual(m[0], 'beforeunload cancelable=true', `got ${JSON.stringify(m)}`);
    strictEqual(m[1], 'unload', `unload must follow beforeunload, got ${JSON.stringify(m)}`);
});

Deno.test('a cancelled beforeunload re-dispatches, and queued work runs', async () => {
    const r = await runScript(`
        let n = 0;
        globalThis.addEventListener('beforeunload', (e) => {
            n++;
            console.log('MARK: bu ' + n);
            // Relent on the 3rd, because Deno's re-dispatch is uncapped: a
            // listener that always cancels never exits (OBSERVED).
            if (n < 3) {
                e.preventDefault();
                setTimeout(() => console.log('MARK: work ' + n), 0);
            }
        });
        globalThis.addEventListener('unload', () => console.log('MARK: unload'));
    `);

    ok(!r.timedOut, 'timed out: cancel loop never relented');
    strictEqual(r.code, 0, r.stderr);
    // Each cancel buys exactly one more dispatch, and the work it queued runs
    // before that dispatch (OBSERVED under Deno 2.9.3).
    strictEqual(
        marks(r).join('|'),
        'bu 1|work 1|bu 2|work 2|bu 3|unload',
        `got ${JSON.stringify(marks(r))}`,
    );
});

Deno.test('returning false from a beforeunload listener does NOT cancel', async () => {
    // Polarity regression guard. The JS multiplexer returns `false` for any
    // event id it does not recognise, so if the C treated `false` as "cancelled"
    // this would re-dispatch forever and the timeout would fire. Under Deno only
    // preventDefault() cancels; a return value is ignored entirely (OBSERVED).
    const r = await runScript(`
        let n = 0;
        globalThis.addEventListener('beforeunload', () => { n++; console.log('MARK: bu ' + n); return false; });
        globalThis.addEventListener('unload', () => console.log('MARK: unload n=' + n));
    `);

    ok(!r.timedOut, 'timed out: `false` was treated as cancel — polarity is inverted');
    strictEqual(r.code, 0, r.stderr);
    strictEqual(marks(r).join('|'), 'bu 1|unload n=1', `got ${JSON.stringify(marks(r))}`);
});

/* ---------------------------------------------------------------- *
 * 5-6: explicit exit must keep its current behaviour exactly.
 * ---------------------------------------------------------------- */

Deno.test("explicit exit fires 'unload' but NOT 'beforeunload'", async () => {
    // Deno 2.9.3: Deno.exit(3) prints the unload listener and exits 3, with no
    // beforeunload dispatch at all (OBSERVED). This is what the shared
    // unload_dispatched flag buys — without it the loop would later drain to
    // r == 0 and fire a second, spurious teardown.
    const r = await runScript(`
        globalThis.addEventListener('beforeunload', () => console.log('MARK: bu-LEAKED'));
        globalThis.addEventListener('unload', () => console.log('MARK: unload'));
        Deno.exit(3);
    `);

    ok(!r.timedOut, 'timed out');
    strictEqual(r.code, 3, `exit code must survive teardown: ${r.stderr}`);
    const m = marks(r);
    ok(!m.includes('bu-LEAKED'), `beforeunload must not fire on explicit exit, got ${JSON.stringify(m)}`);
    strictEqual(m.filter((x) => x === 'unload').length, 1, `unload exactly once, got ${JSON.stringify(m)}`);
});

Deno.test('teardown does not run twice when an explicit exit follows async work', async () => {
    const r = await runScript(`
        import process from 'node:process';
        process.on('exit', (c) => console.log('MARK: process-exit ' + c));
        globalThis.addEventListener('unload', () => console.log('MARK: unload'));
        setTimeout(() => Deno.exit(0), 20);
    `);

    ok(!r.timedOut, 'timed out');
    strictEqual(r.code, 0, r.stderr);
    const m = marks(r);
    strictEqual(m.filter((x) => x === 'unload').length, 1, `unload once, got ${JSON.stringify(m)}`);
    strictEqual(
        m.filter((x) => x.startsWith('process-exit')).length,
        1,
        `process exit once, got ${JSON.stringify(m)}`,
    );
});

/* ---------------------------------------------------------------- *
 * 7-8: throw semantics and the worker exclusion.
 * ---------------------------------------------------------------- */

Deno.test('a throwing beforeunload listener is fatal and suppresses unload', async () => {
    // Deno 2.9.3: the throw surfaces as an uncaught error, the process exits 1,
    // and 'unload' never fires (OBSERVED).
    const r = await runScript(`
        globalThis.addEventListener('beforeunload', () => { throw new Error('boom-in-beforeunload'); });
        globalThis.addEventListener('unload', () => console.log('MARK: unload-LEAKED'));
    `);

    ok(!r.timedOut, 'timed out');
    strictEqual(r.code, 1, `a throwing beforeunload must exit 1, got ${r.code}: ${r.stderr}`);
    ok(
        /boom-in-beforeunload/.test(r.stderr + r.stdout),
        'the error must be reported, not swallowed',
    );
    ok(!marks(r).includes('unload-LEAKED'), 'unload must not run after a throwing beforeunload');
});

Deno.test('workers fire neither beforeunload nor unload on drain', async () => {
    // Deno fires neither inside a worker, on self.close() or on natural drain
    // (both OBSERVED). Asserted from the parent so a worker-side regression
    // shows up as leaked output rather than a silent pass.
    const r = await runScript(`
        const src = \`
            self.addEventListener('beforeunload', () => console.log('MARK: worker-bu-LEAKED'));
            self.addEventListener('unload', () => console.log('MARK: worker-unload-LEAKED'));
            self.postMessage('ready');
        \`;
        const url = 'data:application/javascript;base64,' + btoa(src);
        const w = new Worker(url, { type: 'module' });
        await new Promise((res) => { w.onmessage = res; });
        w.terminate();
        console.log('MARK: parent-done');
    `);

    ok(!r.timedOut, 'timed out');
    const m = marks(r);
    ok(!m.includes('worker-bu-LEAKED'), `no worker beforeunload, got ${JSON.stringify(m)}`);
    ok(!m.includes('worker-unload-LEAKED'), `no worker unload, got ${JSON.stringify(m)}`);
});
