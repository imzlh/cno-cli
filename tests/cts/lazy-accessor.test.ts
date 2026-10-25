import { ok, strictEqual, throws } from 'node:assert';
import { defineLazy, lazyPrototype, whenLazy } from '../../cno/src/utils/lazy-accessor.ts';

function deferredValues(): {
    promise: Promise<ReadonlyMap<string, unknown>>;
    resolve: (values: ReadonlyMap<string, unknown>) => void;
} {
    let resolve!: (values: ReadonlyMap<string, unknown>) => void;
    const promise = new Promise<ReadonlyMap<string, unknown>>(done => { resolve = done; });
    return { promise, resolve };
}

Deno.test('lazy accessors: registering a constructor does not redefine its class prototype', async () => {
    const target: Record<string, unknown> = {};
    class Command {}
    await defineLazy(target, [{ name: 'Command', kind: 'ctor' }], async () => new Map([['Command', Command]]));
    strictEqual(target.Command, Command);
});

Deno.test('lazy accessors: saved constructors and subclasses adopt methods when loading finishes', async () => {
    const target: Record<string, unknown> = {};
    const values = deferredValues();
    const loading = defineLazy(target, [{ name: 'Command', kind: 'ctor' }], () => values.promise);
    class Command {
        static ready = true;
        #value: number;
        constructor(value: number) { this.#value = value; }
        output(): number { return this.#value; }
    }
    const SavedCommand = target.Command as typeof Command;
    class CustomCommand extends SavedCommand {
        doubled(): number { return super.output() * 2; }
    }
    throws(() => new SavedCommand(1), /still loading/);
    values.resolve(new Map([['Command', Command]]));
    await loading;
    await whenLazy(target, 'Command');

    strictEqual(SavedCommand.prototype.output, Command.prototype.output);
    strictEqual(SavedCommand.ready, true);
    const saved = new SavedCommand(7);
    strictEqual(saved.output(), 7);
    ok(saved instanceof SavedCommand);
    ok(saved instanceof Command);
    const custom = new CustomCommand(9);
    strictEqual(custom.doubled(), 18);
    ok(custom instanceof CustomCommand);
    ok(custom instanceof SavedCommand);
    ok(custom instanceof Command);
});

Deno.test('lazy accessors: module assignments do not prevent saved constructors from adopting', async () => {
    const target: Record<string, unknown> = {};
    const values = deferredValues();
    const loading = defineLazy(target, [{ name: 'Socket', kind: 'ctor' }], () => values.promise);
    class Socket {
        static OPEN = 1;
        send(): string { return 'sent'; }
    }
    const SavedSocket = target.Socket as typeof Socket;
    target.Socket = Socket;
    values.resolve(new Map([['Socket', Socket]]));
    await loading;
    strictEqual(SavedSocket.OPEN, 1);
    strictEqual(new SavedSocket().send(), 'sent');
});

Deno.test('lazy accessors: separate loads on one owner retain earlier constructors and functions', async () => {
    const target: Record<string, unknown> = {};
    const first = deferredValues();
    const second = deferredValues();
    class Command { output(): string { return 'first'; } }
    class Socket { send(): string { return 'second'; } }
    const loadingFirst = defineLazy(target, [
        { name: 'Command', kind: 'ctor' }, { name: 'read', kind: 'fn' },
    ], () => first.promise);
    const loadingSecond = defineLazy(target, [{ name: 'Socket', kind: 'ctor' }], () => second.promise);
    const SavedCommand = target.Command as typeof Command;
    const savedRead = target.read as () => string;
    const SavedSocket = target.Socket as typeof Socket;
    first.resolve(new Map<string, unknown>([['Command', Command], ['read', () => 'read']]));
    await loadingFirst;
    second.resolve(new Map([['Socket', Socket]]));
    await loadingSecond;
    strictEqual(new SavedCommand().output(), 'first');
    strictEqual(savedRead(), 'read');
    strictEqual(new SavedSocket().send(), 'second');
});

Deno.test('lazy accessors: shared prototypes adopt their own class with one loader call', async () => {
    const name = 'LazyAccessorSharedFixture';
    const target: Record<string, unknown> = {};
    const values = deferredValues();
    let loads = 0;
    const loading = defineLazy(target, [{ name, kind: 'prototype' }], () => {
        loads++;
        return values.promise;
    });
    class Server { listen(): string { return 'listening'; } }
    const SavedServer = target[name] as typeof Server;
    class CustomServer extends SavedServer {}
    const shared = lazyPrototype(name);
    values.resolve(new Map([[name, Server]]));
    await loading;
    strictEqual(loads, 1);
    strictEqual(lazyPrototype(name), shared);
    strictEqual(Object.getPrototypeOf(shared), Server.prototype);
    const server = new CustomServer();
    strictEqual(server.listen(), 'listening');
    ok(server instanceof CustomServer);
    ok(server instanceof SavedServer);
    ok(server instanceof Server);
});

Deno.test('lazy accessors: known prototypes support saved subclasses', async () => {
    const target: Record<string, unknown> = {};
    const values = deferredValues();
    class Server { listen(): string { return 'listening'; } }
    const loading = defineLazy(target, [{ name: 'Server', kind: 'prototype', finalPrototype: Server.prototype }], () => values.promise);
    const SavedServer = target.Server as typeof Server;
    class CustomServer extends SavedServer {}
    values.resolve(new Map([['Server', Server]]));
    await loading;
    const server = new CustomServer();
    strictEqual(server.listen(), 'listening');
    ok(server instanceof CustomServer);
    ok(server instanceof Server);
});
