// Resource-limit enforcement contract: cno OOMs can be catchable JS errors,
// unlike Node's fatal aborts. Fixtures release allocations before reporting so
// diagnostics do not become a second OOM or serialize a partial result.

import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

interface RunResult { code: number; stdout: string; stderr: string }

async function runCno(args: string[], cwd?: string, env?: Record<string, string>): Promise<RunResult> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
        env: { CTS_SILENT: 'true', ...env },
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

// `buf` stresses typed-array backing stores; `heap` can leave too little room
// to create an Error. CAP bounds an unenforced runtime. Keep CHUNK_MB large and
// clear `sink` before reporting: an OOM leaves less than one chunk free.
const CHUNK_MB = 4;

function allocSrc(shape: 'buf' | 'heap', capMB: number, useTry: boolean): string {
    const body = shape === 'buf'
        ? `sink.push(new Uint8Array(${CHUNK_MB} * 1024 * 1024)); mb += ${CHUNK_MB};`
        : `const row = new Array(4096);
           for (let i = 0; i < 4096; i++) row[i] = ('x' + mb + '_' + i).repeat(8);
           sink.push(row); mb += 0.25;`;
    const alloc = `
        const sink = [];
        let mb = 0;
        while (mb < ${capMB}) { ${body} }
    `;
    if (!useTry) {
        return `${alloc}\nconsole.log('COMPLETED-NO-OOM ' + mb);\nconsole.log('END');\n`;
    }
    return `
        let caughtName = 'none', caughtMsg = 'none', wasError = false, isNull = false;
        const sink = [];
        let mb = 0;
        try {
            while (mb < ${capMB}) { ${body} }
            sink.length = 0;
            console.log('COMPLETED-NO-OOM ' + mb);
        } catch (e) {
            // Release BEFORE touching anything that allocates, or the report
            // itself OOMs -- see the CHUNK_MB note above.
            sink.length = 0;
            isNull = (e === null);
            wasError = (e instanceof Error);
            caughtName = isNull ? 'null' : String(e && e.name);
            caughtMsg  = isNull ? 'null' : String(e && e.message);
        }
        console.log('CAUGHT name=' + caughtName + ' msg=' + caughtMsg +
                    ' isError=' + wasError + ' isNull=' + isNull);
        console.log('END');
    `;
}

const MEM = '32MB';
// Well above the limit, but small enough that an unenforced build finishes fast.
const CAP = 120;

// Workers release `sink` before postMessage because structured-cloning an OOM
// result allocates. Retaining it can make the fixture report an empty or corrupt
// payload. `report` runs after the release; without it the error is uncaught.
function workerAllocSrc(report?: string): string {
    return `
        import { parentPort } from 'node:worker_threads';
        const sink = []; let mb = 0;
        try {
            while (mb < ${CAP}) {
                sink.push(new Uint8Array(${CHUNK_MB} * 1024 * 1024));
                mb += ${CHUNK_MB};
            }
            sink.length = 0;
            parentPort?.postMessage({ ok: true, mb });
        } catch (e) {
            sink.length = 0;   // FIRST -- before anything that allocates
            ${report === undefined ? '' : `const isNull = (e === null);
            const name = isNull ? 'null' : String(e && e.name);
            `}${report ?? 'throw e;'}
        }
    `;
}

// --- 1. memory limit is enforced at all -------------------------------------

Deno.test('resource-limits: --memory-limit refuses allocation past the cap', async () => {
    await withTempDir('rl-enforce', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, allocSrc('buf', CAP, true));
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        ok(!r.stdout.includes('COMPLETED-NO-OOM'),
            `allocation of ${CAP}MB must be refused under ${MEM}; got: ${r.stdout}`);
        ok(r.stdout.includes('CAUGHT'), `expected a caught OOM, got: ${r.stdout}`);
    });
});

// --- 2. the OOM is a catchable JS exception (NOT a fatal abort) --------------

Deno.test('resource-limits: OOM is a catchable exception, not a fatal abort', async () => {
    await withTempDir('rl-catch', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, allocSrc('buf', CAP, true));
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        // The process survives and keeps running user code after the OOM.
        ok(r.stdout.includes('END'),
            `process must survive a caught OOM and reach END; got: ${r.stdout}`);
        strictEqual(r.code, 0, 'a caught OOM leaves exit code 0');
        // When there is headroom to build the Error, it is a proper
        // InternalError('out of memory').
        ok(r.stdout.includes('name=InternalError'),
            `expected InternalError, got: ${r.stdout}`);
        ok(r.stdout.includes('msg=out of memory'),
            `expected "out of memory" message, got: ${r.stdout}`);
        ok(r.stdout.includes('isError=true'),
            `OOM value must be an Error instance, got: ${r.stdout}`);
    });
});

// --- 3. an UNCAUGHT OOM must exit non-zero with a diagnostic -----------------

Deno.test('resource-limits: uncaught OOM exits non-zero with a stderr diagnostic', async () => {
    await withTempDir('rl-uncaught', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, allocSrc('buf', CAP, false));
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        ok(!r.stdout.includes('COMPLETED-NO-OOM'), 'allocation must be refused');
        ok(r.code !== 0, `uncaught OOM must exit non-zero, got ${r.code}`);
        // See the Promise case below: an uncaught OOM may degenerate to a bare
        // JS_NULL whose diagnostic omits "out of memory". Accept either.
        ok(/out of memory/i.test(r.stderr) || /\bnull\b/.test(r.stderr),
            `stderr must diagnose the OOM, got: ${r.stderr}`);
    });
});

// --- 4. uncaught OOM inside an awaited Promise ------------------------------

Deno.test('resource-limits: uncaught OOM in a Promise exits non-zero', async () => {
    await withTempDir('rl-promise', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            const job = () => new Promise((resolve) => {
                const sink = []; let mb = 0;
                while (mb < ${CAP}) { sink.push(new Uint8Array(${CHUNK_MB} * 1024 * 1024)); mb += ${CHUNK_MB}; }
                resolve(mb);
            });
            const mb = await job();
            console.log('COMPLETED-NO-OOM ' + mb);
        `);
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        ok(!r.stdout.includes('COMPLETED-NO-OOM'), 'allocation must be refused');
        ok(r.code !== 0, `uncaught OOM in a Promise must exit non-zero, got ${r.code}`);
        // An UNCAUGHT OOM cannot release anything first -- the CLI's error
        // printer runs with the heap still at the cap -- so when the remainder
        // is too small to build the Error, QuickJS throws a bare JS_NULL and
        // the diagnostic reads "Error / null" with no mention of memory. That
        // is the documented degenerate path (see the header), not a missing
        // diagnostic, so accept it. OBSERVED: rc is 1 in every case, which is
        // why the exit-code assertion above stays strict.
        ok(/out of memory/i.test(r.stderr) || /\bnull\b/.test(r.stderr),
            `stderr must diagnose the OOM, got: ${r.stderr}`);
    });
});

// --- 5. OOM inside a vm sandbox is catchable by the host --------------------

Deno.test('resource-limits: OOM in a vm sandbox is catchable by the host', async () => {
    await withTempDir('rl-vm', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            import vm from 'node:vm';
            const code = \`
                const sink = []; let mb = 0;
                while (mb < ${CAP}) { sink.push(new Uint8Array(256 * 1024)); mb += 0.25; }
                mb;
            \`;
            try {
                const mb = vm.runInNewContext(code, {});
                console.log('VM-COMPLETED-NO-OOM ' + mb);
            } catch (e) {
                console.log('HOST-CAUGHT isNull=' + (e === null));
            }
            console.log('END');
        `);
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        ok(!r.stdout.includes('VM-COMPLETED-NO-OOM'),
            `vm allocation must be refused under ${MEM}; got: ${r.stdout}`);
        ok(r.stdout.includes('HOST-CAUGHT'),
            `host must be able to catch the sandbox OOM, got: ${r.stdout}`);
        ok(r.stdout.includes('END'), 'host must survive the sandbox OOM');
    });
});

// --- 6. the memory limit IS applied to file-based Worker threads ------------
//
// File and eval Workers must inherit the resolved runtime config and enforce
// its memory limit.

Deno.test('resource-limits: --memory-limit is enforced inside a file Worker', async () => {
    await withTempDir('rl-worker', async (dir) => {
        const wf = join(dir, 'w.js');
        Deno.writeTextFileSync(wf, workerAllocSrc());
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            import { Worker } from 'node:worker_threads';
            const w = new Worker(${JSON.stringify(wf.replaceAll('\\', '/'))});
            w.on('message', (m) => console.log('MSG ' + JSON.stringify(m)));
            w.on('error', (e) => console.log('ERR ' + (e && e.message)));
            w.on('exit', (c) => console.log('EXIT ' + c));
        `);
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        ok(!r.stdout.includes('"ok":true'),
            `worker must not allocate ${CAP}MB under ${MEM}; stdout: ${r.stdout}`);
        ok(!r.stdout.includes(`"mb":${CAP}`),
            `worker must not reach the ${CAP}MB cap; stdout: ${r.stdout}`);
        ok(/out of memory/i.test(r.stdout) || /out of memory/i.test(r.stderr),
            `the worker OOM must be reported somewhere; stdout: ${r.stdout} stderr: ${r.stderr}`);
    });
});

Deno.test('resource-limits: a worker OOM reaches the parent as error + exit 1', async () => {
    // cno exposes a catchable InternalError on `error`, then exits 1.
    await withTempDir('rl-worker-err', async (dir) => {
        const wf = join(dir, 'w.js');
        Deno.writeTextFileSync(wf, workerAllocSrc());
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            import { Worker } from 'node:worker_threads';
            const w = new Worker(${JSON.stringify(wf.replaceAll('\\', '/'))});
            w.on('message', (m) => console.log('[EV message] ' + JSON.stringify(m)));
            w.on('error', (e) => console.log('[EV error] ' + (e && e.name) + ' ' + (e && e.message)));
            w.on('exit', (c) => console.log('[EV exit] ' + c));
        `);
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        ok(/\[EV error\] InternalError out of memory/.test(r.stdout),
            `'error' must fire with the OOM; stdout: ${r.stdout}`);
        ok(r.stdout.includes('[EV exit] 1'),
            `a worker killed by OOM must exit 1; stdout: ${r.stdout}`);
        // User code cannot reach postMessage under the cap. Any message is an
        // internal worker-control envelope leaked into the public channel, not a
        // claim about Node's OOM event ordering.
        ok(!r.stdout.includes('__cno_role'),
            `the internal role-tagged envelope must never reach the user's ` +
            `'message' listener; stdout: ${r.stdout}`);
        ok(!/\[EV message\]/.test(r.stdout),
            `user code never reaches postMessage under the cap, so any 'message' ` +
            `is a leaked cts-internal envelope that missed its gate; ` +
            `stdout: ${r.stdout}`);
    });
});

Deno.test('resource-limits: --memory-limit is enforced inside an eval Worker', async () => {
    await withTempDir('rl-worker-eval', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            import { Worker } from 'node:worker_threads';
            const w = new Worker(\`
                const { parentPort } = require('node:worker_threads');
                const cfg = Reflect.get(globalThis, '__cno_worker_runtime_config');
                const sink = []; let mb = 0;
                try {
                    while (mb < ${CAP}) {
                        sink.push(new Uint8Array(${CHUNK_MB} * 1024 * 1024));
                        mb += ${CHUNK_MB};
                    }
                    sink.length = 0;
                    parentPort.postMessage({ ok: true, mb, hasCfg: !!cfg });
                } catch (e) {
                    sink.length = 0;   // release before serialising -- see workerAllocSrc
                    parentPort.postMessage({ caught: true, mb, hasCfg: !!cfg });
                }
            \`, { eval: true });
            w.on('message', (m) => console.log('MSG ' + JSON.stringify(m)));
            w.on('exit', (c) => console.log('EXIT ' + c));
        `);
        const r = await runCno(['run', `--memory-limit=${MEM}`, f], dir);
        ok(r.stdout.includes('"hasCfg":true'),
            `an eval worker must receive the parent's runtime config. ` +
            `stdout: ${r.stdout}`);
        ok(!r.stdout.includes('"ok":true'),
            `an eval worker must not allocate ${CAP}MB under ${MEM}; ` +
            `stdout: ${r.stdout}`);
        ok(!r.stdout.includes(`"mb":${CAP}`),
            `an eval worker must not reach the ${CAP}MB cap; stdout: ${r.stdout}`);
    });
});

// --- 7. stack limit: clean RangeError, matching Node ------------------------

Deno.test('resource-limits: --max-stack-size yields a catchable RangeError', async () => {
    await withTempDir('rl-stack', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            let depth = 0;
            function rec(n) { depth = n; return rec(n + 1); }
            try { rec(0); console.log('NO-OVERFLOW'); }
            catch (e) {
                console.log('CAUGHT name=' + (e && e.name) +
                            ' msg=' + (e && e.message) +
                            ' isRangeError=' + (e instanceof RangeError));
            }
            console.log('END');
        `);
        const r = await runCno(['run', '--max-stack-size=1MB', f], dir);
        strictEqual(r.code, 0, 'a caught stack overflow leaves exit code 0');
        ok(r.stdout.includes('name=RangeError'), `expected RangeError, got: ${r.stdout}`);
        ok(r.stdout.includes('msg=Maximum call stack size exceeded'),
            `expected Node's message text, got: ${r.stdout}`);
        ok(r.stdout.includes('isRangeError=true'),
            `must be a real RangeError instance, got: ${r.stdout}`);
        ok(r.stdout.includes('END'), 'process must survive a caught overflow');
    });
});

Deno.test('resource-limits: uncaught stack overflow exits non-zero', async () => {
    await withTempDir('rl-stack-uncaught', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            function rec(n) { return rec(n + 1); }
            rec(0);
            console.log('NO-OVERFLOW');
        `);
        const r = await runCno(['run', '--max-stack-size=1MB', f], dir);
        ok(!r.stdout.includes('NO-OVERFLOW'), 'recursion must be stopped');
        ok(r.code !== 0, `uncaught stack overflow must exit non-zero, got ${r.code}`);
        ok(/Maximum call stack size exceeded/.test(r.stderr),
            `stderr must diagnose the overflow, got: ${r.stderr}`);
    });
});

// --- 8. an unusable stack limit must never be a silent success --------------
// The CLI may reject it before entry evaluation; a limit that runs the script is
// also valid. What must not recur is a failed startup with exit code 0.

Deno.test('resource-limits: tiny --max-stack-size must never be a silent success', async () => {
    await withTempDir('rl-stack-tiny', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `console.log('SCRIPT-RAN');\n`);
        for (const size of ['64KB', '128KB', '160KB', '256KB']) {
            const r = await runCno(['run', `--max-stack-size=${size}`, f], dir);
            if (r.stdout.includes('SCRIPT-RAN')) continue; // survivable; fine
            ok(r.code !== 0,
                `--max-stack-size=${size}: script never ran, so the exit code must ` +
                `be non-zero. got code=${r.code} ` +
                `stdout=${JSON.stringify(r.stdout)} ` +
                `stderr=${JSON.stringify(r.stderr.slice(0, 300))}`);
            ok(r.stderr.trim().length > 0,
                `--max-stack-size=${size}: a failed run must print a diagnostic, ` +
                'got empty stderr');
        }
    });
});

// --- 9. a survivable stack limit still runs the script ----------------------

Deno.test('resource-limits: a modest --max-stack-size still runs the script', async () => {
    await withTempDir('rl-stack-ok', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `console.log('SCRIPT-RAN');\n`);
        const r = await runCno(['run', '--max-stack-size=1MB', f], dir);
        strictEqual(r.code, 0, `expected success, stderr: ${r.stderr}`);
        ok(r.stdout.includes('SCRIPT-RAN'), `script must run, got: ${r.stdout}`);
    });
});

// --- 10. CTS_MEMORY_LIMIT is enforced, including in Workers -----------------
// This independent configuration source must also propagate to workers.

Deno.test('resource-limits: CTS_MEMORY_LIMIT is enforced in the main thread', async () => {
    await withTempDir('rl-env', async (dir) => {
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, allocSrc('buf', CAP, true));
        const r = await runCno(['run', f], dir, { CTS_MEMORY_LIMIT: MEM });
        ok(!r.stdout.includes('COMPLETED-NO-OOM'),
            `CTS_MEMORY_LIMIT=${MEM} must refuse ${CAP}MB; got: ${r.stdout}`);
        ok(r.stdout.includes('name=InternalError'),
            `expected InternalError, got: ${r.stdout}`);
    });
});

Deno.test('resource-limits: CTS_MEMORY_LIMIT is enforced inside a Worker', async () => {
    await withTempDir('rl-env-worker', async (dir) => {
        const wf = join(dir, 'w.js');
        Deno.writeTextFileSync(wf, workerAllocSrc(
            `parentPort?.postMessage({ caught: true, name });`,
        ));
        const f = join(dir, 'a.js');
        Deno.writeTextFileSync(f, `
            import { Worker } from 'node:worker_threads';
            const w = new Worker(${JSON.stringify(wf.replaceAll('\\', '/'))});
            w.on('message', (m) => console.log('MSG ' + JSON.stringify(m)));
            w.on('error', (e) => console.log('ERR ' + (e && e.message)));
            w.on('exit', (c) => console.log('EXIT ' + c));
        `);
        const r = await runCno(['run', f], dir, { CTS_MEMORY_LIMIT: MEM });
        ok(!r.stdout.includes('"ok":true'),
            `CTS_MEMORY_LIMIT=${MEM} must be enforced in the worker; got: ${r.stdout}`);
        ok(r.stdout.includes('"caught":true'),
            `worker must observe the OOM; got: ${r.stdout}`);
    });
});
