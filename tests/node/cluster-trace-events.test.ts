import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import cluster from 'node:cluster';
import * as clusterNamed from 'node:cluster';
import {
    createTracing,
    getEnabledCategories,
} from 'node:trace_events';
import traceEvents from 'node:trace_events';

Deno.test('node:cluster exposes primary-process compatibility surface', () => {
    strictEqual(cluster.isPrimary, true);
    strictEqual(cluster.isMaster, true);
    strictEqual(cluster.isWorker, false);
    strictEqual(cluster.SCHED_NONE, 1);
    strictEqual(cluster.SCHED_RR, 2);
    strictEqual(cluster.setupPrimary, cluster.setupMaster);
    strictEqual(cluster.setupPrimary, clusterNamed.setupPrimary);
    strictEqual(cluster.workers, clusterNamed.workers);
    strictEqual(cluster.settings, clusterNamed.settings);

    cluster.setupPrimary({ exec: 'worker.js', args: ['--flag'] });
    deepStrictEqual(cluster.settings, { exec: 'worker.js', args: ['--flag'] });
});

Deno.test('node:cluster disconnect emits asynchronously and calls callback', async () => {
    const events: string[] = [];
    const done = new Promise<void>((resolve) => {
        cluster.once('disconnect', () => events.push('event'));
        cluster.disconnect(() => {
            events.push('callback');
            resolve();
        });
        events.push('sync');
    });

    await done;
    deepStrictEqual(events, ['sync', 'event', 'callback']);
});

Deno.test('node:cluster fork reports unsupported worker spawning explicitly', () => {
    throws(() => cluster.fork(), /not supported/);
});

Deno.test('node:trace_events tracks enabled categories across tracing objects', () => {
    const first = createTracing({ categories: ['node.perf', 'v8'] });
    const second = createTracing({ categories: ['v8', 'node.async_hooks'] });

    strictEqual(first.categories, 'node.perf,v8');
    strictEqual(first.enabled, false);
    strictEqual(second.enabled, false);

    first.enable();
    strictEqual(first.enabled, true);
    strictEqual(getEnabledCategories(), 'node.perf,v8');

    second.enable();
    strictEqual(second.enabled, true);
    strictEqual(getEnabledCategories(), 'node.async_hooks,node.perf,v8');

    first.disable();
    strictEqual(first.enabled, false);
    strictEqual(getEnabledCategories(), 'node.async_hooks,v8');

    second.disable();
    strictEqual(getEnabledCategories(), undefined);
});

Deno.test('node:trace_events validates category options', () => {
    throws(() => createTracing({ categories: [] }), TypeError);
    throws(() => createTracing(undefined as unknown as Parameters<typeof createTracing>[0]), TypeError);
    throws(() => createTracing({} as unknown as Parameters<typeof createTracing>[0]), TypeError);
    throws(() => createTracing({ categories: 'v8' } as unknown as Parameters<typeof createTracing>[0]), TypeError);
    throws(() => createTracing({ categories: ['v8', 1] } as unknown as Parameters<typeof createTracing>[0]), TypeError);
});

Deno.test('node:trace_events preserves category list and exposes default namespace', () => {
    strictEqual(traceEvents.createTracing, createTracing);
    strictEqual(traceEvents.getEnabledCategories, getEnabledCategories);

    const tracing = createTracing({ categories: [' v8 ', 'node.perf', 'v8', '', 'node.perf'] });
    strictEqual(tracing.categories, ' v8 ,node.perf,v8,,node.perf');
    strictEqual(tracing.enabled, false);

    tracing.enable();
    tracing.enable();
    strictEqual(tracing.enabled, true);
    strictEqual(getEnabledCategories(), ' v8 ,node.perf,v8');

    tracing.disable();
    tracing.disable();
    strictEqual(tracing.enabled, false);
    strictEqual(getEnabledCategories(), undefined);
});

Deno.test('node:trace_events category refcounts survive overlapping tracing lifetimes', () => {
    const first = createTracing({ categories: ['v8', 'node.perf'] });
    const second = createTracing({ categories: ['v8'] });

    first.enable();
    second.enable();
    strictEqual(getEnabledCategories(), 'node.perf,v8');

    first.disable();
    strictEqual(getEnabledCategories(), 'v8');

    second.disable();
    strictEqual(getEnabledCategories(), undefined);
});
