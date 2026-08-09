/**
 * `node:async_hooks` must not manufacture spurious `unhandledRejection` events.
 *
 * MEASURED DEFECT. Loading `node:async_hooks` installs a `Promise.prototype.then`
 * patch (cno/src/node/async_hooks/mod.ts, `installAsyncPatches`). It attached a
 * bookkeeping branch to every derived promise whose rejection arm re-threw
 * unconditionally into a promise that was immediately discarded — so nothing
 * could ever handle it, and every rejecting `.then` hop produced a REAL
 * unhandled rejection carrying the original error.
 *
 * The user-visible failure was a koa app that handles its own errors:
 *   koa/lib/application.js:186  fnMiddleware(ctx).then(handleResponse).catch(onerror)
 * The intermediate `.then(handleResponse)` result rejects, the user's `.catch`
 * handles it, node fires ONLY `app.on('error')` — and cno also fired
 * `process.on('unhandledRejection')`. Deployments that install
 * `process.on('unhandledRejection', () => process.exit(1))` therefore killed the
 * process on a correctly-handled application error. Wire bytes were identical;
 * only the spurious event differed.
 *
 * The fix cannot simply drop the re-throw. Attaching ANY `.then` to a promise
 * sets [[PromiseIsHandled]] on it, so the bookkeeping branch masks that promise's
 * own unhandled rejection; the re-throw is what relocates the report onto the
 * discarded promise. Removing it would silence GENUINE unhandled rejections. The
 * fix re-throws only when no user reaction was ever attached to the derived
 * promise. Both directions are asserted here — the genuine rows are the ones a
 * naive "swallow it" fix breaks, and they are the reason this file exists.
 *
 * These run as child processes: `unhandledRejection` is a process-global event and
 * an in-process assertion would see rejections leaked by every other test in the
 * suite. Fixtures report through a marker FILE rather than stdout because
 * os.exit() does not drain a queued pipe write.
 */
import { deepStrictEqual, strictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

interface RunResult {
    status: number | null;
    stderr: string;
    /** unhandledRejection reasons the fixture observed, in order. */
    seen: string[];
}

function runFixture(name: string, body: string): RunResult {
    const dir = mkdtempSync(join(tmpdir(), 'cno-ahrej-'));
    const file = join(dir, `${name}.mjs`);
    const marker = join(dir, 'marker.json');
    try {
        writeFileSync(file, body, 'utf8');
        const r = spawnSync(process.execPath, ['run', file, marker], {
            encoding: 'utf8',
            timeout: 60_000,
        });
        const raw = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
        return {
            status: r.status,
            stderr: String(r.stderr ?? ''),
            seen: raw === '' ? [] : JSON.parse(raw) as string[],
        };
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

/**
 * `hold` keeps the loop unambiguously alive until `done()` runs, so no row
 * depends on how the timer polyfill arms its underlying handle. The marker is
 * written even when the list is empty, which is what distinguishes "the fixture
 * ran and saw nothing" from "the fixture never got there".
 */
const PRELUDE = [
    "import { writeFileSync } from 'node:fs';",
    'const MARKER = process.argv[2];',
    'const seen = [];',
    "process.on('unhandledRejection', (reason) => { seen.push(reason && reason.message ? reason.message : String(reason)); });",
    'const hold = setInterval(() => {}, 10);',
    'const done = () => { writeFileSync(MARKER, JSON.stringify(seen)); clearInterval(hold); };',
    '',
].join('\n');

function fixture(...lines: string[]): string {
    return PRELUDE + lines.join('\n') + '\n';
}

const LOAD_AH = "import 'node:async_hooks';";

// --- direction 1: a HANDLED rejection must stay silent ----------------------

Deno.test('async_hooks: handled .then().catch() reports no unhandledRejection', () => {
    // koa's exact shape, reduced. node: silent.
    const r = runFixture('thencatch', fixture(
        LOAD_AH,
        "Promise.reject(new Error('OK_THENCATCH')).then(() => {}).catch(() => {});",
        'setTimeout(done, 120);',
    ));
    deepStrictEqual(r.seen, [], `a handled rejection must not be reported; stderr: ${r.stderr}`);
});

Deno.test('async_hooks: handled deep chain reports no unhandledRejection', () => {
    // Each hop used to contribute its own spurious event, so this row also pins
    // that the count does not scale with chain length.
    const r = runFixture('deepcatch', fixture(
        LOAD_AH,
        "Promise.reject(new Error('OK_DEEP')).then(() => {}).then(() => {}).then(() => {}).catch(() => {});",
        'setTimeout(done, 120);',
    ));
    deepStrictEqual(r.seen, [], `stderr: ${r.stderr}`);
});

Deno.test('async_hooks: handled rejection in a request listener reports no unhandledRejection', () => {
    // The koa-facing path: the listener returns an already-handled chain and the
    // server awaits it (cno/src/node/_internal/server-request-runtime.ts).
    const r = runFixture('listener-handled', fixture(
        LOAD_AH,
        "import http from 'node:http';",
        'const server = http.createServer((req, res) => {',
        "    return Promise.reject(new Error('OK_LISTENER')).then(() => {}).catch(() => {",
        "        res.writeHead(200, { 'content-type': 'text/plain' });",
        "        res.end('ok');",
        '    });',
        '});',
        "server.listen(0, '127.0.0.1', () => {",
        '    const { port } = server.address();',
        "    http.request({ host: '127.0.0.1', port, path: '/' }, (res) => {",
        "        res.on('data', () => {});",
        "        res.on('end', () => setTimeout(() => { server.close(); done(); }, 120));",
        '    }).end();',
        '});',
    ));
    deepStrictEqual(r.seen, [], `stderr: ${r.stderr}`);
});

// --- direction 2: a GENUINE unhandled rejection must still report -----------
// These are the rows that fail if the bookkeeping re-throw is simply deleted.

Deno.test('async_hooks: unhandled .then() hop still reports unhandledRejection', () => {
    // `p.then(f)` with no rejection handler anywhere. node reports once.
    const r = runFixture('then-nocatch', fixture(
        LOAD_AH,
        "Promise.reject(new Error('GEN_HOP')).then(() => {});",
        'setTimeout(done, 120);',
    ));
    deepStrictEqual(r.seen, ['GEN_HOP'], `a genuine unhandled rejection must still report; stderr: ${r.stderr}`);
});

Deno.test('async_hooks: unhandled chain reports exactly once, not once per hop', () => {
    const r = runFixture('chain-nocatch', fixture(
        LOAD_AH,
        "Promise.reject(new Error('GEN_CHAIN')).then(() => {}).then(() => {});",
        'setTimeout(done, 120);',
    ));
    deepStrictEqual(r.seen, ['GEN_CHAIN'], `stderr: ${r.stderr}`);
});

Deno.test('async_hooks: bare unhandled rejection still reports', () => {
    const r = runFixture('bare', fixture(
        LOAD_AH,
        "Promise.reject(new Error('GEN_BARE'));",
        'setTimeout(done, 120);',
    ));
    deepStrictEqual(r.seen, ['GEN_BARE'], `stderr: ${r.stderr}`);
});

Deno.test('async_hooks: a handler attached in a later tick still reports, as node does', () => {
    // node reports the rejection and then fires 'rejectionHandled'. Only the
    // report is asserted: this runtime never emits 'rejectionHandled' at all
    // (the notification is dropped in circu.js/src/vm.c) — a separate defect,
    // and the reason this row cannot use it as evidence.
    const r = runFixture('late-catch', fixture(
        LOAD_AH,
        "const p = Promise.reject(new Error('GEN_LATE')).then(() => {});",
        'setTimeout(() => p.catch(() => {}), 40);',
        'setTimeout(done, 160);',
    ));
    deepStrictEqual(r.seen, ['GEN_LATE'], `stderr: ${r.stderr}`);
});

Deno.test('async_hooks: unhandled rejection in a request listener still reports', () => {
    const r = runFixture('listener-genuine', fixture(
        LOAD_AH,
        "import http from 'node:http';",
        'const server = http.createServer((req, res) => {',
        "    res.writeHead(200, { 'content-type': 'text/plain' });",
        "    res.end('ok');",
        "    Promise.reject(new Error('GEN_LISTENER')).then(() => {});",
        '});',
        "server.listen(0, '127.0.0.1', () => {",
        '    const { port } = server.address();',
        "    http.request({ host: '127.0.0.1', port, path: '/' }, (res) => {",
        "        res.on('data', () => {});",
        "        res.on('end', () => setTimeout(() => { server.close(); done(); }, 160));",
        '    }).end();',
        '});',
    ));
    deepStrictEqual(r.seen, ['GEN_LISTENER'], `stderr: ${r.stderr}`);
});

// --- baseline control: the same shapes without the patch installed ----------

Deno.test('async_hooks: baseline — without loading async_hooks both directions are correct', () => {
    // Positive control for the two rows above. If this fixture ever diverges, the
    // defect is in core promise tracking rather than in the async_hooks patch, and
    // the rows above would be measuring the wrong thing.
    const r = runFixture('no-ah', fixture(
        "Promise.reject(new Error('OK_NOAH')).then(() => {}).catch(() => {});",
        "Promise.reject(new Error('GEN_NOAH')).then(() => {});",
        'setTimeout(done, 120);',
    ));
    deepStrictEqual(r.seen, ['GEN_NOAH'], `stderr: ${r.stderr}`);
    strictEqual(r.seen.includes('OK_NOAH'), false, 'the handled chain must never be reported');
});
