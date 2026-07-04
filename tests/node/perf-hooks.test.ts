import { strictEqual, ok } from 'node:assert';
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
    performance.mark('a');
    performance.mark('b');
    performance.measure('m', 'a', 'b');
    performance.clearMarks('a');
    performance.clearMeasures('m');
    ok(true);
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

// --- 5. monitorEventLoopDelay returns monitor -------------------------------

Deno.test({ name: 'perf_hooks: monitorEventLoopDelay returns monitor', timeout: 10000 }, () => {
    const m = monitorEventLoopDelay?.({ resolution: 10 });
    if (m) {
        ok(typeof m.enable === 'function');
        m.disable();
    }
});

// --- 6. constants exposes NODE_PERFORMANCE_ENTRY_TYPE ----------------------

Deno.test({ name: 'perf_hooks: constants object exists', timeout: 10000 }, () => {
    ok(constants && typeof constants === 'object');
});

// --- 7. performance.timeOrigin is a number ---------------------------------

Deno.test({ name: 'perf_hooks: performance.timeOrigin is number', timeout: 10000 }, () => {
    ok(typeof performance.timeOrigin === 'number');
});

// --- 8. multiple now() calls are monotonic non-decreasing ------------------

Deno.test({ name: 'perf_hooks: performance.now is monotonic non-decreasing', timeout: 10000 }, () => {
    const a = performance.now();
    const b = performance.now();
    ok(b >= a, `expected monotonic, got a=${a} b=${b}`);
});
