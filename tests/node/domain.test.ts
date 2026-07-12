import { deepStrictEqual, strictEqual } from 'node:assert';
import domain from 'node:domain';
import * as domainNs from 'node:domain';
import { EventEmitter } from 'node:events';

Deno.test('node:domain run catches thrown errors', async () => {
    const d = domain.create();
    const seen = new Promise<Error>((resolve) => d.on('error', resolve));

    const result = d.run(() => {
        throw new Error('a thrown error');
    });

    strictEqual(result, undefined);
    strictEqual((await seen).message, 'a thrown error');
});

Deno.test('node:domain enter/exit maintain active stack', () => {
    const a = domain.create();
    const b = domain.create();
    strictEqual(domainNs.active, null);

    a.enter();
    strictEqual(domainNs.active, a);
    b.enter();
    strictEqual(domainNs.active, b);
    b.exit();
    strictEqual(domainNs.active, a);
    a.exit();
    strictEqual(domainNs.active, null);
});

Deno.test('node:domain exit of non-top domain pops it and above', () => {
    const a = domain.create();
    const b = domain.create();
    const c = domain.create();
    a.enter();
    b.enter();
    c.enter();
    b.exit();
    strictEqual(domainNs.active, a);
    a.exit();
    strictEqual(domainNs.active, null);
});

Deno.test('node:domain run sets active for the duration of the callback', () => {
    const outer = domain.create();
    const inner = domain.create();
    const order: string[] = [];

    outer.run(() => {
        order.push(domainNs.active === outer ? 'outer' : '?');
        inner.run(() => {
            order.push(domainNs.active === inner ? 'inner' : '?');
        });
        order.push(domainNs.active === outer ? 'outer2' : '?');
    });
    order.push(domainNs.active === null ? 'null' : 'still');
    deepStrictEqual(order, ['outer', 'inner', 'outer2', 'null']);
});

Deno.test('node:domain add forwards EventEmitter error events', async () => {
    const d = domain.create();
    const emitter = new EventEmitter();
    const seen = new Promise<Error>((resolve) => d.on('error', resolve));

    d.add(emitter);
    emitter.emit('error', new Error('an emitted error'));

    strictEqual((await seen).message, 'an emitted error');
    strictEqual(emitter.domain, d);
    deepStrictEqual(d.members, [emitter]);
});

Deno.test('node:domain remove detaches EventEmitter error forwarding', async () => {
    const d = domain.create();
    const emitter = new EventEmitter();
    let domainErrors = 0;

    d.on('error', () => {
        domainErrors++;
    });
    d.add(emitter);
    d.remove(emitter);

    const seen = new Promise<Error>((resolve) => emitter.on('error', resolve));
    emitter.emit('error', new Error('local only'));

    strictEqual((await seen).message, 'local only');
    strictEqual(domainErrors, 0);
    strictEqual(emitter.domain, null);
    deepStrictEqual(d.members, []);
});

Deno.test('node:domain bind preserves arguments and reports thrown errors', async () => {
    const d = domain.create();
    const seen = new Promise<Error>((resolve) => d.on('error', resolve));
    const calls: unknown[] = [];

    const bound = d.bind((error: Error, a: number, b: number) => {
        calls.push(error.message, a, b);
        throw new Error('bound throw');
    });

    strictEqual(bound(new Error('passed'), 2, 3), undefined);
    deepStrictEqual(calls, ['passed', 2, 3]);
    strictEqual((await seen).message, 'bound throw');
});

Deno.test('node:domain intercept handles callback errors before invoking callback', async () => {
    const d = domain.create();
    const errors: string[] = [];
    d.on('error', (error) => {
        errors.push(error.message);
    });

    const calls: unknown[] = [];
    const intercepted = d.intercept((a: number, b: number) => {
        calls.push(a, b);
        throw new Error('callback throw');
    });

    strictEqual(intercepted(null, 2, 3), undefined);
    strictEqual(intercepted(new Error('passed error'), 4, 5), undefined);

    deepStrictEqual(calls, [2, 3]);
    deepStrictEqual(errors, ['callback throw', 'passed error']);
});
