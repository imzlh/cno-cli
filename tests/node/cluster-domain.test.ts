// Derived from Deno upstream unit_node/{cluster,domain}_test.ts public cases.
import { deepStrictEqual, strictEqual } from 'node:assert';
import cluster, * as clusterNamed from 'node:cluster';
import domain from 'node:domain';
import { EventEmitter } from 'node:events';

Deno.test('node cluster upstream: primary-only export surface is available', () => {
    strictEqual(cluster.isPrimary, true);
    strictEqual(cluster.isMaster, true);
    strictEqual(cluster.isWorker, false);
    strictEqual(typeof cluster.disconnect, 'function');
    strictEqual(typeof cluster.on, 'function');
    deepStrictEqual(cluster.workers, {});
    deepStrictEqual(cluster.settings, {});
    strictEqual(cluster.SCHED_NONE, 1);
    strictEqual(cluster.SCHED_RR, 2);
    strictEqual(typeof cluster.fork, 'function');
    strictEqual(typeof cluster.setupPrimary, 'function');
    strictEqual(cluster.setupPrimary, cluster.setupMaster);

    strictEqual(cluster.setupPrimary, clusterNamed.setupPrimary);
    strictEqual(cluster.setupMaster, clusterNamed.setupMaster);
    strictEqual(cluster.workers, clusterNamed.workers);
    strictEqual(cluster.settings, clusterNamed.settings);
    strictEqual(cluster.fork, clusterNamed.fork);
    strictEqual(cluster.disconnect, clusterNamed.disconnect);
    strictEqual(cluster.SCHED_NONE, clusterNamed.SCHED_NONE);
    strictEqual(cluster.SCHED_RR, clusterNamed.SCHED_RR);
    strictEqual(cluster.isWorker, clusterNamed.isWorker);
    strictEqual(cluster.isPrimary, clusterNamed.isPrimary);
    strictEqual(cluster.isMaster, clusterNamed.isMaster);
});

Deno.test('node domain upstream: run catches thrown errors', async () => {
    const d = domain.create();
    const caught = new Promise<void>((resolve) => {
        d.on('error', (err) => {
            strictEqual(err?.message, 'a thrown error');
            resolve();
        });
    });
    d.run(() => {
        throw new Error('a thrown error');
    });
    await caught;
});

Deno.test('node domain upstream: add and remove EventEmitter error routing', async () => {
    const d = domain.create();
    const emitter = new EventEmitter();
    const caught = new Promise<void>((resolve) => {
        d.on('error', (err) => {
            strictEqual(err?.message, 'an emitted error');
            resolve();
        });
    });
    d.add(emitter);
    emitter.emit('error', new Error('an emitted error'));
    await caught;

    let domainGotError = false;
    d.on('error', () => {
        domainGotError = true;
    });
    d.remove(emitter);
    const local = new Promise<void>((resolve) => {
        emitter.on('error', (err) => {
            strictEqual(err?.message, 'local only');
            setTimeout(resolve, 0);
        });
    });
    emitter.emit('error', new Error('local only'));
    await local;
    strictEqual(domainGotError, false);
});

Deno.test('node domain upstream: bind and intercept route callback errors', async () => {
    const d = domain.create();
    const messages: string[] = [];
    const done = new Promise<void>((resolve) => {
        d.on('error', (err) => {
            messages.push(err?.message);
            if (messages.length === 3) resolve();
        });
    });

    d.bind((err: Error, a: number, b: number) => {
        strictEqual(err.message, 'a passed error');
        strictEqual(a, 2);
        strictEqual(b, 3);
        throw new Error('a thrown error');
    })(new Error('a passed error'), 2, 3);

    d.intercept((a: number, b: number) => {
        strictEqual(a, 2);
        strictEqual(b, 3);
        throw new Error('another thrown error');
    })(null, 2, 3);

    d.intercept(() => {
        throw new Error('should never reach here');
    })(new Error('a passed intercept error'));

    await done;
    deepStrictEqual(messages, [
        'a thrown error',
        'another thrown error',
        'a passed intercept error',
    ]);
});
