import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { extractImports } from '../../cts/src/scan.ts';
import { parseTaskTimeoutMs } from '../../cts/src/api/index.ts';

Deno.test('precompile policy: ParseDriver is transform-only; scan is ImportScanner', () => {
    // Transform keeps a 60s safety kill. Scan must not share the worker pool
    // (old 10s scan-kill was the frpc / multiaddr hang heritage).
    strictEqual(parseTaskTimeoutMs('transform'), 60_000);

    const parseSrc = readFileSync(new URL('../../cts/src/parse.ts', import.meta.url), 'utf8');
    ok(!parseSrc.includes('SCAN_TASK_TIMEOUT_MS'), 'old scan kill constant must stay gone');
    ok(!parseSrc.includes("kind: 'scan'"), 'worker protocol must not carry scan tasks');
    ok(!parseSrc.includes('scanQueue'), 'ParseDriver must not queue scan work');
    ok(!parseSrc.includes('async scanFile'), 'scanFile API must not live on ParseDriver');
    ok(
        !/10_000/.test(parseSrc) || parseSrc.includes('parseTaskTimeoutMs'),
        'must not reintroduce a short wall-clock kill',
    );
    ok(parseSrc.includes('parseTaskTimeoutMs'), 'sendToWorker must arm transform timeout via policy');
    // Global wall-clock must abandon remaining tasks (not bare finish()).
    ok(parseSrc.includes('onGlobalTimeout'), 'batch timeout must fail remaining work');
    ok(parseSrc.includes('cancelOutstanding'), 'shutdown must surface cancelled transforms');
    // Fail-closed: global timer must cancel outstanding work (onFailed), not only resolve the batch promise.
    const globalBody = methodBody(parseSrc, 'onGlobalTimeout');
    ok(globalBody.includes('cancelOutstanding'), 'onGlobalTimeout must cancel outstanding, not bare finish');
    ok(globalBody.includes('this.finish()'), 'onGlobalTimeout still settles the batch after abandon');
    const cancelBody = methodBody(parseSrc, 'cancelOutstanding');
    ok(cancelBody.includes('onFailed'), 'cancelOutstanding must report cancelled transforms via onFailed');
    ok(cancelBody.includes('cancelledPending > 0'), 'completed shutdown must not emit a late progress callback');
    ok(parseSrc.includes('this.onProgressCb = undefined'), 'completed batches must release their progress callback');
    ok(parseSrc.includes('this.taskTotal = 0'), 'completed batches must not look active during shutdown');

    const progressSrc = readFileSync(new URL('../../cts/src/utils/progress.ts', import.meta.url), 'utf8');
    const stopBody = methodBody(progressSrc, 'stop');
    const pauseBody = methodBody(progressSrc, 'pause');
    const kickBody = methodBody(progressSrc, 'kick');
    ok(stopBody.includes('this.stopped = true'), 'progress stop must be terminal');
    ok(stopBody.includes('this.pause()'), 'stop must clear the timer via pause');
    ok(pauseBody.includes('clearInterval'), 'pause clears the redraw timer without being terminal');
    ok(!pauseBody.includes('this.stopped = true'), 'pause must allow later kick() to restart painting');
    ok(kickBody.includes('this.stopped'), 'late callbacks must not restart a stopped progress timer');
    ok(kickBody.includes('lastPaintMs'), 'producer path must throttle-paint when the interval is starved');

    const writerSrc = readFileSync(new URL('../../cts/src/pack/writer.ts', import.meta.url), 'utf8');
    ok(writerSrc.includes('new ParseDriver(oxc, 0)'), 'pack must use reliable inline transform/compile');
    const cleanup = writerSrc.slice(writerSrc.lastIndexOf('} finally {'));
    ok(cleanup.indexOf('await parseDriver.terminate()') < cleanup.indexOf('prog?.stop()'),
        'pack must stop the progress producer before closing its UI');
    // Dual-name heritage (PrecompileDriver / compiler worker aliases) must stay gone.
    ok(!parseSrc.includes('PrecompileDriver'), 'ParseDriver is the only public driver name');
    ok(!parseSrc.includes('isCompilerWorker'), 'isParseWorker is the only worker-role check');
    ok(!parseSrc.includes('runCompilerWorker'), 'runParseWorker is the only worker entry');
});

/** Extract `name(...) { ... }` body by brace depth (not non-greedy regex). */
function methodBody(src: string, name: string): string {
    const needle = `${name}(`;
    let from = 0;
    while (true) {
        const idx = src.indexOf(needle, from);
        if (idx < 0) return '';
        // Prefer method definition: preceded by space/newline/private/public, not `this.`
        const pre = src.slice(Math.max(0, idx - 12), idx);
        if (pre.includes('this.')) { from = idx + needle.length; continue; }
        const brace = src.indexOf('{', idx);
        if (brace < 0) return '';
        let depth = 0;
        for (let i = brace; i < src.length; i++) {
            const c = src.charAt(i);
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) return src.slice(idx, i + 1);
            }
        }
        return '';
    }
}

Deno.test('precompile policy: long named-import scan stays complete without worker path', () => {
    // Real failure mode: multiaddr-style long import lists. extractImports
    // (ImportScanner sucrase fallback) must still see the from-clause.
    const names = Array.from({ length: 60 }, (_, i) => `SYM_${i}`).join(', ');
    const source = `import { ${names} } from "./constants.js";\nexport const x = 1;\n`;
    const root = makePosixTempDir('precompile-scan-long');
    try {
        mkdirSync(root, { recursive: true });
        const file = join(root, 'registry.ts');
        writeFileSync(file, source);
        const fromDisk = new TextDecoder().decode(readFileSync(file));
        deepStrictEqual(extractImports(fromDisk, true).sort(), ['./constants.js']);
        strictEqual(parseTaskTimeoutMs('transform'), 60_000);
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});
