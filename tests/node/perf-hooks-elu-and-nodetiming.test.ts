import { ok, strictEqual } from 'node:assert';
import { performance, PerformanceObserver } from 'node:perf_hooks';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `performance.eventLoopUtilization()` is a permanent zero stub:
 * `cno/src/webapi/performance.ts:502-504` returns a fresh
 * `{ idle: 0, active: 0, utilization: 0 }` every call.
 *
 * Measured against node v24.18.0 (/d/tmp/ag-diag/p-elu.mjs) across a 150 ms busy
 * spin followed by a 150 ms sleep:
 *   node -> idle climbs to 164.205, active 0.143   (any-nonzero-at-all: true)
 *   cno  -> idle 0.000, active 0.000 at every sample (any-nonzero-at-all: false)
 *
 * This is the dangerous shape: an APM agent reads `utilization: 0` forever, which
 * means "the event loop is never busy" -- indistinguishable from a healthy process,
 * so loop saturation is never reported. Nothing throws.
 *
 * Values are inherently variable, so this asserts only *relationships*: that some
 * accounting accumulates at all, and that idle grows across a sleep. Absolute
 * numbers are deliberately not asserted.
 *
 * ACTION: `cno/src/webapi/**` is baked into the binary, so this needs a rebuild
 * after wiring the real uv loop timers. Drop `ignore: true` then.
 * ---------------------------------------------------------------------------
 */
Deno.test({
    name: 'perf_hooks: eventLoopUtilization accumulates real time (needs rebuild)',
    ignore: true,
    fn: async () => {
        const a = performance.eventLoopUtilization();
        await sleep(150);
        const b = performance.eventLoopUtilization();
        ok(b.idle + b.active > 0, 'ELU must accumulate some time, got all zeros');
        ok(b.idle > a.idle, 'idle must grow across a sleep');
        const d = performance.eventLoopUtilization(b, a);
        ok(d.idle + d.active > 0, 'the delta form must report the elapsed window');
    },
});

/**
 * A `gc` PerformanceObserver never fires in cno. `observe({ entryTypes: ['gc'] })`
 * is accepted without throwing (measured: both node and cno accept it), then no
 * entry is ever delivered -- a silently dead observer rather than a loud rejection.
 * Measured over 40 x 50k-element allocations plus an explicit gc() where available:
 *   node -> at least one 'gc' entry      cno -> none
 * ACTION: needs GC-event plumbing from the engine. Unskip after that lands.
 */
Deno.test({
    name: 'perf_hooks: a gc PerformanceObserver receives entries (needs engine support)',
    ignore: true,
    fn: async () => {
        const seen: string[] = [];
        const obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) seen.push(e.entryType);
        });
        obs.observe({ entryTypes: ['gc'] });
        try {
            for (let i = 0; i < 40; i++) {
                const junk = new Array(50_000).fill({ i });
                if (junk.length < 0) throw new Error('unreachable');
            }
            const maybeGc = (globalThis as { gc?: () => void }).gc;
            if (typeof maybeGc === 'function') maybeGc();
            await sleep(150);
            ok(seen.length > 0, 'expected at least one gc entry');
        } finally {
            obs.disconnect();
        }
    },
});

/**
 * `performance.nodeTiming.nodeStart` and `.uvMetricsInfo` are undefined in cno where
 * node v24.18.0 reports a number and an object, and `.loopStart` is not > 0.
 * Startup-profiling tools read these directly.
 * ACTION: `cno/src/webapi/**` is baked; needs a rebuild. Unskip then.
 */
Deno.test({
    name: 'perf_hooks: nodeTiming exposes nodeStart, loopStart and uvMetricsInfo (needs rebuild)',
    ignore: true,
    fn: () => {
        const nt = performance.nodeTiming as unknown as Record<string, unknown>;
        strictEqual(typeof nt.nodeStart, 'number', 'nodeStart must be a number');
        ok((nt.nodeStart as number) >= 0, 'nodeStart must be non-negative');
        ok((nt.loopStart as number) > 0, 'loopStart must be set once the loop has run');
        strictEqual(typeof nt.uvMetricsInfo, 'object', 'uvMetricsInfo must be an object');
    },
});

/**
 * `performance.toJSON()` must include nodeTiming and eventLoopUtilization, not just
 * timeOrigin. Measured: node -> `eventLoopUtilization,nodeTiming,timeOrigin`,
 * cno -> `timeOrigin`.
 * ACTION: `cno/src/webapi/**` is baked; needs a rebuild. Unskip then.
 */
Deno.test({
    name: 'perf_hooks: performance.toJSON includes nodeTiming and ELU (needs rebuild)',
    ignore: true,
    fn: () => {
        const keys = Object.keys(performance.toJSON() as object).sort();
        strictEqual(keys.join(','), 'eventLoopUtilization,nodeTiming,timeOrigin');
    },
});

// --- what holds today, pinned -----------------------------------------------

/**
 * `performance.now()` must be monotonic and finer-grained than the ~15.6 ms Windows
 * timer floor. Measured: 20 000 samples yield >100 distinct values, a smallest
 * non-zero delta below 1 ms, and fractional values -- matching node.
 */
Deno.test('perf_hooks: now() is monotonic with sub-millisecond resolution', () => {
    const samples: number[] = [];
    for (let i = 0; i < 20_000; i++) samples.push(performance.now());

    for (let i = 1; i < samples.length; i++) {
        ok(samples[i] >= samples[i - 1], `now() went backwards at sample ${i}`);
    }
    ok(new Set(samples).size > 100, 'now() must not be quantised to a coarse tick');
    ok(samples.some((s) => s % 1 !== 0), 'now() must report fractional milliseconds');

    let minDelta = Infinity;
    for (let i = 1; i < samples.length; i++) {
        const d = samples[i] - samples[i - 1];
        if (d > 0 && d < minDelta) minDelta = d;
    }
    ok(minDelta < 1, `resolution must beat 1ms, smallest non-zero delta was ${minDelta}`);
});

Deno.test('perf_hooks: timeOrigin plus now() tracks Date.now()', () => {
    strictEqual(typeof performance.timeOrigin, 'number');
    ok(performance.timeOrigin > 1.5e12, 'timeOrigin must be a real epoch milliseconds value');
    const drift = Math.abs(performance.timeOrigin + performance.now() - Date.now());
    ok(drift < 5000, `timeOrigin + now() drifted ${drift}ms from Date.now()`);
});

Deno.test('perf_hooks: mark and measure entries land in getEntries', () => {
    performance.clearMarks();
    performance.clearMeasures();

    performance.mark('pm-a', { detail: { d: 1 } });
    performance.mark('pm-b');
    const marks = performance.getEntriesByType('mark');
    strictEqual(marks.length, 2);
    strictEqual(marks.map((e) => e.name).join(','), 'pm-a,pm-b');
    ok(marks.every((e) => e.entryType === 'mark'), 'entryType must be "mark"');
    ok(marks.every((e) => e.duration === 0), 'marks have zero duration');

    const measure = performance.measure('pm-meas', 'pm-a', 'pm-b');
    strictEqual(measure.entryType, 'measure');
    strictEqual(typeof measure.duration, 'number');
    strictEqual(performance.getEntriesByName('pm-meas', 'measure').length, 1);

    performance.clearMarks('pm-a');
    strictEqual(performance.getEntriesByType('mark').map((e) => e.name).join(','), 'pm-b');
    performance.clearMarks();
    performance.clearMeasures();
    // Asserted per-type rather than on getEntries().length, because cno adds a
    // browser-style `navigation` entry that node does not have -- see the skipped
    // test below.
    strictEqual(performance.getEntriesByType('mark').length, 0, 'all marks cleared');
    strictEqual(performance.getEntriesByType('measure').length, 0, 'all measures cleared');
});

/**
 * `performance.getEntries()` must not contain a `navigation` entry. Navigation
 * timing is a browser concept; node v24.18.0 has no such entry, and
 * `PerformanceObserver.supportedEntryTypes` reflects that.
 *
 * Measured (/d/tmp/ag-diag/p-clear.mjs) after one mark/measure round plus
 * clearMarks() + clearMeasures():
 *   node -> before: `mark:a,measure:m,mark:b`              after: EMPTY
 *   cno  -> before: `navigation:navigation,mark:a,...`     after: `navigation:navigation`
 *
 * So any code that iterates `performance.getEntries()` sees a spurious entry it
 * cannot clear. Related, same root: cno advertises
 * `supportedEntryTypes = mark,measure,navigation,resource,paint,frame,function`
 * where node reports `dns,function,gc,http,http2,mark,measure,net,resource` -- cno
 * claims three browser types it should not and omits five node types it should have.
 *
 * ACTION: `cno/src/webapi/performance.ts` is baked into the binary, so this needs a
 * rebuild. Drop `ignore: true` then.
 */
Deno.test({
    name: 'perf_hooks: getEntries has no browser navigation entry (needs rebuild)',
    ignore: true,
    fn: () => {
        performance.clearMarks();
        performance.clearMeasures();
        const types = performance.getEntries().map((e) => e.entryType);
        strictEqual(types.includes('navigation'), false, `unexpected navigation entry: ${types.join(',')}`);
    },
});

Deno.test('perf_hooks: a PerformanceObserver delivers marks and measures', async () => {
    performance.clearMarks();
    performance.clearMeasures();
    const seen: string[] = [];
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) seen.push(`${e.entryType}:${e.name}`);
    });
    obs.observe({ entryTypes: ['mark', 'measure'] });
    try {
        performance.mark('po-a');
        performance.mark('po-b');
        performance.measure('po-m', 'po-a', 'po-b');
        await sleep(80);
        ok(seen.includes('mark:po-a'), `expected mark:po-a, saw ${seen.join(',')}`);
        ok(seen.includes('mark:po-b'), `expected mark:po-b, saw ${seen.join(',')}`);
        ok(seen.includes('measure:po-m'), `expected measure:po-m, saw ${seen.join(',')}`);
    } finally {
        obs.disconnect();
    }

    // disconnect must stop delivery
    seen.length = 0;
    performance.mark('po-after-disconnect');
    await sleep(60);
    strictEqual(seen.length, 0, 'a disconnected observer must receive nothing');
});

Deno.test('perf_hooks: buffered: true replays marks made before observe()', async () => {
    performance.clearMarks();
    performance.mark('buf-1');
    performance.mark('buf-2');
    await sleep(20);

    let seen = 'NOT_CALLED';
    const obs = new PerformanceObserver((list) => {
        seen = list.getEntries().map((e) => e.name).join(',');
    });
    obs.observe({ type: 'mark', buffered: true });
    try {
        await sleep(80);
        strictEqual(seen, 'buf-1,buf-2', 'buffered observe must replay earlier entries');
    } finally {
        obs.disconnect();
        performance.clearMarks();
    }
});

Deno.test('perf_hooks: timerify records a function entry and preserves the result', async () => {
    const seen: string[] = [];
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) seen.push(`${e.entryType}:${e.name}`);
    });
    obs.observe({ entryTypes: ['function'] });
    try {
        const sum = (n: number) => {
            let s = 0;
            for (let i = 0; i < n; i++) s += i;
            return s;
        };
        const timed = performance.timerify(sum);
        strictEqual(timed(1000), sum(1000), 'timerify must not change the return value');
        await sleep(80);
        ok(seen.includes('function:sum'), `expected function:sum, saw ${seen.join(',') || 'none'}`);
    } finally {
        obs.disconnect();
    }
});
