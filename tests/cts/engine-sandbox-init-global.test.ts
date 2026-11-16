const engine = import.meta.use('engine');

function strictEqual(actual: unknown, expected: unknown): void {
    if (!Object.is(actual, expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function deepStrictEqual(actual: unknown, expected: unknown): void {
    strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

function throws(fn: () => unknown, constructor: new (...args: never[]) => Error, message: RegExp): void {
    let error: unknown;
    try {
        fn();
    } catch (caught) {
        error = caught;
    }
    if (!(error instanceof constructor) || !message.test(error.message)) {
        throw new Error(`Expected ${constructor.name} matching ${message}, got ${String(error)}`);
    }
}

Deno.test('engine sandbox: initGlobal installs selected intrinsics in the sandbox context', () => {
    const sandbox = new engine.Sandbox();

    strictEqual(typeof sandbox.global.JSON, 'undefined');
    strictEqual(typeof sandbox.global.Map, 'undefined');
    strictEqual(typeof sandbox.global.Uint8Array, 'undefined');
    // BaseObjects provides these before optional globals are selected.
    strictEqual(typeof sandbox.global.BigInt, 'function');

    sandbox.initGlobal(['json', 'map', 'typedarrays', 'bigint']);

    deepStrictEqual({
        json: typeof sandbox.global.JSON,
        map: typeof sandbox.global.Map,
        u8: typeof sandbox.global.Uint8Array,
        bigint: typeof sandbox.global.BigInt,
        value: sandbox.call('JSON.stringify({x:new Map([[1,2]]).size,y:typeof BigInt})'),
    }, {
        json: 'object',
        map: 'function',
        u8: 'function',
        bigint: 'function',
        value: '{"x":1,"y":"function"}',
    });

    throws(() => sandbox.initGlobal([]), TypeError, /global already initialized/);
});

Deno.test('engine sandbox: initGlobal deduplicates features and installs atob dependencies', () => {
    const sandbox = new engine.Sandbox();
    sandbox.initGlobal(['atob', 'domexception', 'atob']);

    strictEqual(typeof sandbox.global.atob, 'function');
    strictEqual(typeof sandbox.global.DOMException, 'function');
    strictEqual(sandbox.call('atob("Y25v")'), 'cno');
});

Deno.test('engine sandbox: initGlobal without a feature list installs every optional intrinsic', () => {
    const sandbox = new engine.Sandbox();
    sandbox.initGlobal();

    deepStrictEqual(sandbox.call(`({
        date: typeof Date,
        regexp: typeof RegExp,
        json: typeof JSON,
        proxy: typeof Proxy,
        map: typeof Map,
        typedarrays: typeof Uint8Array,
        promise: typeof Promise,
        bigint: typeof BigInt,
        weakref: typeof WeakRef,
        atob: typeof atob,
        domexception: typeof DOMException,
        performance: typeof performance,
    })`), {
        date: 'function',
        regexp: 'function',
        json: 'object',
        proxy: 'function',
        map: 'function',
        typedarrays: 'function',
        promise: 'function',
        bigint: 'function',
        weakref: 'function',
        atob: 'function',
        domexception: 'function',
        performance: 'object',
    });
});

Deno.test('engine sandbox: initGlobal rejects reentry from feature access', () => {
    const sandbox = new engine.Sandbox();
    const features: engine.IntrinsicFeature[] = [];
    Object.defineProperty(features, 0, {
        get() {
            sandbox.initGlobal(['json']);
            return 'json';
        },
    });
    features.length = 1;

    throws(() => sandbox.initGlobal(features), TypeError, /global already initialized/);
    throws(() => sandbox.initGlobal(['json']), TypeError, /global already initialized/);
});
