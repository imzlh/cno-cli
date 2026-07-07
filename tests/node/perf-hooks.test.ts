import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import * as perfHooks from 'node:perf_hooks';

const {
    performance,
    PerformanceObserver,
    createHistogram,
    monitorEventLoopDelay,
    constants,
} = perfHooks;

// --- 1. performance.now returns a number -----------------------------------

Deno.test({ name: 'perf_hooks: performance.now returns number', timeout: 10000 }, () => {
    const n = performance.now();
    ok(typeof n === 'number' && n >= 0);
});

// --- 2. performance.mark / measure / clearMarks ----------------------------

Deno.test({ name: 'perf_hooks: mark/measure/clear are callable', timeout: 10000 }, () => {
    const markA = performance.mark('a');
    performance.mark('b');
    const measure = performance.measure('m', 'a', 'b');
    strictEqual(markA.entryType, 'mark');
    strictEqual(measure.entryType, 'measure');
    performance.clearMarks('a');
    performance.clearMeasures('m');
    strictEqual(performance.getEntriesByName('a').length, 0);
    strictEqual(performance.getEntriesByName('m').length, 0);
});

// --- 3. PerformanceObserver constructor ------------------------------------

Deno.test({ name: 'perf_hooks: PerformanceObserver is constructable', timeout: 10000 }, () => {
    const obs = new PerformanceObserver(() => {});
    ok(obs);
    if (typeof obs.disconnect === 'function') obs.disconnect();
    if (typeof obs.observe === 'function') obs.observe({ entryTypes: ['mark'] });
});

// --- 4. createHistogram returns histogram ----------------------------------

Deno.test({ name: 'perf_hooks: createHistogram returns object', timeout: 10000 }, () => {
    const h = createHistogram?.();
    if (h) {
        ok(typeof h === 'object');
    }
});

Deno.test({ name: 'perf_hooks: createHistogram records count min and max', timeout: 10000 }, () => {
    const h = createHistogram?.();
    if (!h) return;
    h.record(5);
    h.record(10);
    strictEqual(h.count, 2);
    strictEqual(h.min, 5);
    strictEqual(h.max, 10);
});

// --- 5. monitorEventLoopDelay returns monitor -------------------------------

Deno.test({ name: 'perf_hooks: monitorEventLoopDelay returns monitor', timeout: 10000 }, () => {
    const m = monitorEventLoopDelay?.({ resolution: 10 });
    if (m) {
        ok(typeof m.enable === 'function');
        m.disable();
    }
});

Deno.test({ name: 'perf_hooks upstream: monitorEventLoopDelay records samples while enabled', timeout: 10000 }, async () => {
    const monitor = monitorEventLoopDelay?.({ resolution: 10 });
    if (!monitor) return;
    strictEqual(monitor.count, 0);
    monitor.enable();
    await new Promise((resolve) => setTimeout(resolve, 100));
    monitor.disable();

    ok(monitor.count > 0);
    ok(monitor.min > 0);
    ok(monitor.minBigInt > 0n);
});

// --- 6. constants exposes NODE_PERFORMANCE_ENTRY_TYPE ----------------------

Deno.test({ name: 'perf_hooks: constants object exists', timeout: 10000 }, () => {
    ok(constants && typeof constants === 'object');
    strictEqual(constants.NODE_PERFORMANCE_GC_MAJOR, 4);
    strictEqual(constants.NODE_PERFORMANCE_GC_MINOR, 1);
    strictEqual(constants.NODE_PERFORMANCE_GC_FLAGS_FORCED, 4);
});

// --- 7. performance.timeOrigin is a number ---------------------------------

Deno.test({ name: 'perf_hooks: performance.timeOrigin is number', timeout: 10000 }, () => {
    ok(typeof performance.timeOrigin === 'number');
});

Deno.test({ name: 'perf_hooks upstream: performance.timeOrigin is read-only', timeout: 10000 }, () => {
    const original = performance.timeOrigin;
    throws(() => {
        (performance as Performance & { timeOrigin: number }).timeOrigin = 1;
    }, TypeError);
    strictEqual(performance.timeOrigin, original);
});

// --- 8. multiple now() calls are monotonic non-decreasing ------------------

Deno.test({ name: 'perf_hooks: performance.now is monotonic non-decreasing', timeout: 10000 }, () => {
    const a = performance.now();
    const b = performance.now();
    ok(b >= a, `expected monotonic, got a=${a} b=${b}`);
});

Deno.test({ name: 'perf_hooks: getEntriesByType and clearMarks are selective', timeout: 10000 }, () => {
    performance.clearMarks();
    performance.clearMeasures();
    performance.mark('perf-a');
    performance.mark('perf-b');
    performance.measure('perf-m', 'perf-a', 'perf-b');
    deepStrictEqual(performance.getEntriesByType('mark').map((entry) => entry.name), ['perf-a', 'perf-b']);
    deepStrictEqual(performance.getEntriesByName('perf-m').map((entry) => entry.entryType), ['measure']);
    performance.clearMarks('perf-a');
    deepStrictEqual(performance.getEntriesByType('mark').map((entry) => entry.name), ['perf-b']);
    performance.clearMarks();
    performance.clearMeasures();
});

Deno.test({ name: 'perf_hooks: PerformanceObserver receives mark and measure entries', timeout: 10000 }, async () => {
    performance.clearMarks();
    performance.clearMeasures();
    const entries: Array<{ name: string; type: string }> = [];
    const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            entries.push({ name: entry.name, type: entry.entryType });
        }
    });
    obs.observe({ entryTypes: ['mark', 'measure'] });
    performance.mark('obs-a');
    performance.mark('obs-b');
    performance.measure('obs-m', 'obs-a', 'obs-b');
    await new Promise((resolve) => setTimeout(resolve, 20));
    obs.disconnect();
    ok(entries.some((entry) => entry.name === 'obs-a' && entry.type === 'mark'));
    ok(entries.some((entry) => entry.name === 'obs-m' && entry.type === 'measure'));
    performance.clearMarks();
    performance.clearMeasures();
});

Deno.test({ name: 'perf_hooks upstream: PerformanceObserver validates observe options', timeout: 10000 }, () => {
    const obs = new PerformanceObserver(() => {});
    try {
        throws(() => obs.observe(undefined as unknown as PerformanceObserverInit), TypeError);
        throws(() => obs.observe({ entryTypes: ['mark'], type: 'mark' } as PerformanceObserverInit), TypeError);
        throws(() => obs.observe({ entryTypes: 'mark' } as unknown as PerformanceObserverInit), TypeError);
        obs.observe({ type: 'mark', buffered: true });
    } finally {
        obs.disconnect();
    }
});

Deno.test({ name: 'perf_hooks: PerformanceObserver.supportedEntryTypes includes mark and measure', timeout: 10000 }, () => {
    ok(Array.isArray(PerformanceObserver.supportedEntryTypes));
    ok(PerformanceObserver.supportedEntryTypes.includes('mark'));
    ok(PerformanceObserver.supportedEntryTypes.includes('measure'));
    ok(PerformanceObserver.supportedEntryTypes.includes('function'));
    ok(PerformanceObserver.supportedEntryTypes.includes('resource'));
});

Deno.test({ name: 'perf_hooks: mark stores detail and measure without marks starts at zero', timeout: 10000 }, () => {
    performance.clearMarks();
    performance.clearMeasures();
    const mark = performance.mark('detail-mark', { detail: { a: 1 } });
    strictEqual((mark as PerformanceEntry & { detail?: { a: number } }).detail?.a, 1);
    const measure = performance.measure('from-origin');
    strictEqual(measure.entryType, 'measure');
    strictEqual(measure.startTime, 0);
    performance.clearMarks();
    performance.clearMeasures();
});

Deno.test({ name: 'perf_hooks: measure throws for missing marks', timeout: 10000 }, () => {
    performance.clearMarks();
    performance.clearMeasures();
    throws(() => performance.measure('missing-measure', 'does-not-exist'), SyntaxError);
});

Deno.test({ name: 'perf_hooks: timerify wraps function and emits function entry', timeout: 10000 }, async () => {
    const seen: Array<{ name: string; detail?: unknown }> = [];
    const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            seen.push({ name: entry.name, detail: (entry as PerformanceEntry & { detail?: unknown }).detail });
        }
    });
    obs.observe({ entryTypes: ['function'] });
    try {
        function add(a: number, b: number) {
            return a + b;
        }
        const wrapped = performance.timerify(add);
        strictEqual(wrapped.name, 'timerified add');
        strictEqual(wrapped(2, 3), 5);
        await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
        obs.disconnect();
    }
    ok(seen.some((entry) => entry.name === 'add' && Array.isArray(entry.detail) && entry.detail[0] === 2 && entry.detail[1] === 3));
});

Deno.test({ name: 'perf_hooks upstream: markResourceTiming records resource entries', timeout: 10000 }, () => {
    performance.clearResourceTimings?.();
    const entry = performance.markResourceTiming(
        { startTime: 5, endTime: 17 },
        'http://example.test/node-resource',
        'fetch',
        globalThis,
        '',
        { encodedBodySize: 42 },
        200,
    ) as PerformanceEntry & { initiatorType?: string; transferSize?: number };

    strictEqual(entry.name, 'http://example.test/node-resource');
    strictEqual(entry.entryType, 'resource');
    strictEqual(entry.startTime, 5);
    strictEqual(entry.duration, 12);
    strictEqual(entry.initiatorType, 'fetch');
    strictEqual(entry.transferSize, 42);
    strictEqual(performance.getEntriesByName('http://example.test/node-resource', 'resource').at(-1), entry);
});

Deno.test({ name: 'perf_hooks upstream: observer takeRecords and disconnect semantics', timeout: 10000 }, () => {
    performance.clearMarks();
    const seen: string[] = [];
    const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) seen.push(entry.name);
    });

    obs.observe({ entryTypes: ['mark'], buffered: true });
    performance.mark('take-record-a');
    performance.mark('take-record-b');
    deepStrictEqual(obs.takeRecords().map((entry) => entry.name), ['take-record-a', 'take-record-b']);
    deepStrictEqual(obs.takeRecords(), []);

    obs.disconnect();
    performance.mark('take-record-c');
    deepStrictEqual(obs.takeRecords(), []);
    deepStrictEqual(seen, ['take-record-a', 'take-record-b']);
    performance.clearMarks();
});
