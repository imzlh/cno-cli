import { rejects, strictEqual, throws } from 'node:assert';
import { runInNewContext } from 'node:vm';
// wrap.ts imports this source module directly. The embedded global Deno.errors
// is initialized through a separate module graph, so its constructors are not
// suitable for identity/instanceof assertions in this source-level test.
import { errors as sourceErrors } from '../../cno/src/deno/01_errors.ts';
import { wrapDenoError, wrapFSErr } from '../../cno/src/utils/wrap.ts';

const engine = import.meta.use('engine');
const nativeError = import.meta.use('error');
const thrownValue = Symbol('thrown value');

class ErrorWrapFixture {
    value = 'fixture';

    failSync(this: ErrorWrapFixture): never {
        throw nativeError.Error(nativeError.errno.ENOENT);
    }

    async failAsync(this: ErrorWrapFixture): Promise<never> {
        throw nativeError.Error(nativeError.errno.ENOENT);
    }

    failWithValue(this: ErrorWrapFixture): never {
        throw thrownValue;
    }

    receiverValue(this: ErrorWrapFixture): string {
        return this.value;
    }
}

// The test loader does not transpile decorator syntax, so invoke the method
// decorator's replacement directly while production methods use @wrapDenoError.
function wrapFixtureMethod<Args extends unknown[], Return>(
    method: (this: ErrorWrapFixture, ...args: Args) => Return
): (this: ErrorWrapFixture, ...args: Args) => Return {
    return wrapDenoError(method, undefined as never);
}

const wrappedMethods = {
    failSync: wrapFixtureMethod(ErrorWrapFixture.prototype.failSync),
    failAsync: wrapFixtureMethod(ErrorWrapFixture.prototype.failAsync),
    failWithValue: wrapFixtureMethod(ErrorWrapFixture.prototype.failWithValue),
    receiverValue: wrapFixtureMethod(ErrorWrapFixture.prototype.receiverValue),
};

const wrappedFixture = Object.assign(new ErrorWrapFixture(), wrappedMethods);

Deno.test('Deno filesystem error mapping preserves special native errors', () => {
    const unknown = wrapFSErr(nativeError.Error(nativeError.errno.UNKNOWN));

    for (const name of ['ENOTEMPTY', 'ENOSPC'] as const) {
        const code = nativeError.errno[name];
        for (const foreign of [false, true]) {
            for (const frozen of [false, true]) {
                for (const stack of ['original stack', { original: 'stack' }, undefined]) {
                    const failure = foreign
                        ? runInNewContext('new Error("foreign native failure")') as Error
                        : nativeError.Error(code);
                    Object.assign(failure, { name: 'IOError', code });
                    Object.defineProperty(failure, 'stack', { value: stack, writable: true, configurable: true });
                    if (frozen) Object.freeze(failure);
                    const wrapped = wrapFSErr(failure) as Error;
                    strictEqual(wrapped === failure, false);
                    strictEqual(wrapped instanceof Error, true);
                    strictEqual(wrapped.name, 'Error');
                    strictEqual(wrapped.message, failure.message);
                    strictEqual(Reflect.get(wrapped, 'code'), name);
                    strictEqual(wrapped.stack, stack);
                    strictEqual(failure.name, 'IOError');
                    strictEqual(Reflect.get(failure, 'code'), code);
                }
            }
        }
    }
    strictEqual(wrapFSErr(nativeError.Error(nativeError.errno.ENOTSUP)) instanceof sourceErrors.NotSupported, true);
    strictEqual(wrapFSErr(nativeError.Error(nativeError.errno.EPERM)) instanceof sourceErrors.PermissionDenied, true);
    strictEqual(wrapFSErr(nativeError.Error(nativeError.errno.ETXTBSY)) instanceof sourceErrors.Busy, true);
    strictEqual(unknown instanceof sourceErrors.NotSupported, true);
});

Deno.test('Deno filesystem error mapping leaves non-errno values unchanged', () => {
    const ordinary = new Error('application failure');
    const coded = Object.assign(new Error('application code'), { code: 'ERR_CUSTOM' });
    const domException = new DOMException('aborted', 'AbortError');
    const value = Symbol('thrown value');

    strictEqual(wrapFSErr(ordinary), ordinary);
    strictEqual(wrapFSErr(coded), coded);
    strictEqual(wrapFSErr(domException), domException);
    strictEqual(wrapFSErr(value), value);

    Object.defineProperty(ordinary, Symbol.toStringTag, {
        get() { throw new Error('tag getter must not be evaluated'); },
    });
    strictEqual(wrapFSErr(ordinary), ordinary);
    const native = nativeError.Error(nativeError.errno.ENOENT);
    Object.defineProperty(native, Symbol.toStringTag, {
        get() { throw new Error('tag getter must not be evaluated'); },
    });
    strictEqual(wrapFSErr(native) instanceof sourceErrors.NotFound, true);
});

Deno.test('Deno filesystem error mapping preserves DOMException from another realm', () => {
    const foreignDOMException = runInNewContext(`(() => {
        class DOMException extends Error {
            constructor() {
                super('foreign invalid state');
                this.name = 'InvalidStateError';
                this.code = 11;
            }
            get [Symbol.toStringTag]() { return 'DOMException'; }
        }
        return new DOMException();
    })()`);

    strictEqual(foreignDOMException instanceof DOMException, false);
    strictEqual(wrapFSErr(foreignDOMException), foreignDOMException);
});

Deno.test('Deno error wrappers map foreign promise rejections without reading their tags', async () => {
    const foreignPromise = runInNewContext(
        'Promise.reject(Object.assign(new Error("foreign failure"), { code }))',
        { code: nativeError.errno.ENOENT },
    ) as Promise<never>;
    Object.defineProperty(foreignPromise, Symbol.toStringTag, {
        get() { throw new Error('promise tag getter must not run'); },
    });
    strictEqual(foreignPromise instanceof Promise, false);
    const fail = wrapFixtureMethod(() => foreignPromise);
    await rejects(fail.call(wrappedFixture), (error: unknown) => {
        strictEqual(error instanceof sourceErrors.NotFound, true);
        strictEqual((error as Error).message, 'foreign failure');
        return true;
    });
});

Deno.test('Deno error wrappers map synchronous native failures', () => {
    try {
        wrappedFixture.failSync();
        throw new Error('expected the method to fail');
    } catch (error) {
        strictEqual(error instanceof sourceErrors.NotFound, true);
        strictEqual(Reflect.get(error as Error, 'code'), 'ENOENT');
    }
});

Deno.test('Deno error wrappers map asynchronous native failures', async () => {
    await rejects(() => wrappedFixture.failAsync(), (error: unknown) => {
        strictEqual(error instanceof sourceErrors.NotFound, true);
        strictEqual(Reflect.get(error as Error, 'code'), 'ENOENT');
        return true;
    });
});

Deno.test('Deno error wrappers preserve non-Error thrown values', () => {
    try {
        wrappedMethods.failWithValue.call(new ErrorWrapFixture());
        throw new Error('expected the method to fail');
    } catch (error) {
        strictEqual(error, thrownValue);
    }
});

Deno.test('Error propagation preserves captured stacks without invoking formatters', async () => {
    // A bare realm keeps the engine regression independent of wrap.ts and the
    // Web API Error constructor/stack accessors.
    const sandbox = new engine.Sandbox();
    sandbox.initGlobal(['promise']);
    const result = await sandbox.call<Promise<{
        identical: boolean;
        formats: number;
        reads: number;
        writes: number;
        stacksPreserved: boolean;
        descriptorsPreserved: boolean;
    }>>(`(async () => {
        const plain = new Error('captured stack');
        const originalStack = plain.stack;
        const assigned = new Error('assigned stack');
        const marker = {};
        Object.defineProperty(assigned, 'stack', { value: marker, configurable: true });
        const accessor = new Error('stack accessor');
        const frozen = new Error('frozen stack accessor');
        let reads = 0, writes = 0, formats = 0, identical = true;
        for (const error of [accessor, frozen]) {
            Object.defineProperty(error, 'stack', {
                configurable: true,
                get() { reads++; return 'original stack'; },
                set(_) { writes++; },
            });
        }
        Object.freeze(plain);
        Object.freeze(frozen);
        const failures = [plain, assigned, accessor, frozen];
        const descriptors = failures.map(error => Object.getOwnPropertyDescriptor(error, 'stack'));
        function fail(error) { throw error; }
        function rethrow(error) {
            try { fail(error); } catch (caught) { throw caught; }
        }
        async function reject(error) { throw error; }
        Error.prepareStackTrace = () => { formats++; return 'unexpected formatting'; };
        for (const failure of failures) {
            for (let i = 0; i < 2; i++) {
                try { fail(failure); } catch (caught) { identical &&= caught === failure; }
                try { fail.apply(null, [failure]); } catch (caught) { identical &&= caught === failure; }
                try { rethrow(failure); } catch (caught) { identical &&= caught === failure; }
                try { await Promise.reject(failure); } catch (caught) { identical &&= caught === failure; }
                try { await reject(failure); } catch (caught) { identical &&= caught === failure; }
            }
        }
        Error.prepareStackTrace = undefined;
        return {
            identical, formats, reads, writes,
            stacksPreserved: plain.stack === originalStack && assigned.stack === marker,
            descriptorsPreserved: failures.every((error, index) => {
                const before = descriptors[index];
                const after = Object.getOwnPropertyDescriptor(error, 'stack');
                return before === undefined ? after === undefined :
                    ['get', 'set', 'value', 'writable', 'enumerable', 'configurable']
                        .every(key => before[key] === after[key]);
            }),
        };
    })()`);
    strictEqual(result.identical, true);
    strictEqual(result.stacksPreserved, true);
    strictEqual(result.descriptorsPreserved, true);
    strictEqual(result.reads, 0);
    strictEqual(result.writes, 0);
    strictEqual(result.formats, 0);
});

Deno.test('Error capture retains undefined formatter results across rethrows', () => {
    const sandbox = new engine.Sandbox();
    sandbox.initGlobal(['domexception']);
    const result = sandbox.call<{
        construction: boolean;
        rethrow: boolean;
        explicitCapture: boolean;
        nativeCapture: boolean;
        uninitializedStack: boolean;
    }>(`(() => {
        const formatted = [];
        Error.prepareStackTrace = error => { formatted.push(error); return undefined; };
        const failure = new Error('undefined stack');
        const construction = formatted.length === 1 && formatted[0] === failure && failure.stack === undefined;
        function fail(error) { throw error; }
        let identical = true;
        for (let i = 0; i < 2; i++) {
            try { fail(failure); } catch (caught) { identical &&= caught === failure; }
        }
        const rethrow = identical && formatted.length === 1 && failure.stack === undefined;
        const target = {};
        Error.captureStackTrace(target);
        const explicitCapture = formatted.length === 2 && formatted[1] === target && target.stack === undefined;
        let native;
        try { null.value; } catch (caught) { native = caught; }
        for (let i = 0; i < 2; i++) {
            try { fail(native); } catch (caught) { identical &&= caught === native; }
        }
        return {
            construction, rethrow, explicitCapture,
            nativeCapture: identical && native instanceof TypeError && formatted.length === 3 &&
                formatted[2] === native && native.stack === undefined,
            uninitializedStack: DOMException.prototype.stack === undefined,
        };
    })()`);
    strictEqual(result.construction, true);
    strictEqual(result.rethrow, true);
    strictEqual(result.explicitCapture, true);
    strictEqual(result.nativeCapture, true);
    strictEqual(result.uninitializedStack, true);
});

Deno.test('Deno error wrappers preserve stack formatter identity and results', async () => {
    const previous = Error.prepareStackTrace;
    const marker = { custom: 'stack' };
    const failure = nativeError.Error(nativeError.errno.ENOENT);
    const failSync = wrapFixtureMethod(() => { throw failure; });
    const failAsync = wrapFixtureMethod(async () => { throw failure; });
    try {
        for (const stack of ['custom-stack', marker, undefined, null, 0, false]) {
            let formattedError: Error | undefined;
            const formatter = function (error: Error, sites: NodeJS.CallSite[]): unknown {
                strictEqual(Error.isError(error), true);
                strictEqual(Error.prepareStackTrace, formatter);
                formattedError = error;
                strictEqual(Array.isArray(sites), true);
                return stack;
            };
            Error.prepareStackTrace = formatter;
            try {
                failSync.call(wrappedFixture);
                throw new Error('expected the method to fail');
            } catch (error) {
                strictEqual(error instanceof sourceErrors.NotFound, true);
                strictEqual((error as Error).message, failure.message);
                strictEqual((error as Error).stack, stack);
                strictEqual(error, formattedError);
            }
            await rejects(() => failAsync.call(wrappedFixture), (error: unknown) => {
                strictEqual(error instanceof sourceErrors.NotFound, true);
                strictEqual((error as Error).stack, stack);
                strictEqual(error, formattedError);
                return true;
            });
        }
    } finally {
        Error.prepareStackTrace = previous;
    }
});

Deno.test('Deno error wrappers leave application errors and stack accessors untouched', async () => {
    const previous = Error.prepareStackTrace;
    const local = new Error('local application failure');
    const foreign = runInNewContext('new Error("foreign application failure")') as Error;
    const frozenLocal = new Error('frozen local application failure');
    const frozenForeign = runInNewContext('new Error("frozen foreign application failure")') as Error;
    const failures = [local, foreign, frozenLocal, frozenForeign];
    let reads = 0;
    let writes = 0;
    let formats = 0;
    for (const failure of failures) {
        Object.defineProperty(failure, 'stack', {
            configurable: true,
            get() { reads++; return 'original stack'; },
            set() { writes++; throw new Error('unexpected stack assignment'); },
        });
    }
    Object.freeze(frozenLocal);
    Object.freeze(frozenForeign);
    try {
        Error.prepareStackTrace = () => { formats++; return 'unexpected formatting'; };
        for (const failure of failures) {
            const failSync = wrapFixtureMethod(() => { throw failure; });
            const failAsync = wrapFixtureMethod(async () => { throw failure; });
            throws(() => failSync.call(wrappedFixture), error => error === failure);
            await rejects(() => failAsync.call(wrappedFixture), error => error === failure);
        }
        strictEqual(reads, 0);
        strictEqual(writes, 0);
        strictEqual(formats, 0);
    } finally {
        Error.prepareStackTrace = previous;
    }
});

Deno.test('Deno error wrappers do not format stacks for successful async calls', async () => {
    const previous = Error.prepareStackTrace;
    const succeed = wrapFixtureMethod(async function () { return this.value; });
    let calls = 0;
    const formatter = () => { calls++; throw new Error('unexpected stack formatting'); };
    try {
        Error.prepareStackTrace = formatter;
        const result = succeed.call(wrappedFixture);
        strictEqual(Error.prepareStackTrace, formatter);
        strictEqual(calls, 0);
        strictEqual(await result, 'fixture');
        strictEqual(calls, 0);
    } finally {
        Error.prepareStackTrace = previous;
    }
});

Deno.test('Deno error wrappers preserve method receivers and return values', () => {
    strictEqual(wrappedFixture.receiverValue(), 'fixture');
});

Deno.test('Deno.readLinkSync preserves application failures without a second filesystem call', () => {
    const fs = import.meta.use('fs');
    const { readlink, lstat } = Object.getOwnPropertyDescriptors(fs);
    let probes = 0;
    try {
        Object.defineProperty(fs, 'lstat', { ...lstat, value: () => { probes++; throw new Error('unexpected probe'); } });
        for (const failure of [
            new Error('readlink rejected by the caller'),
            new TypeError('application type failure'),
        ]) {
            Object.defineProperty(fs, 'readlink', { ...readlink, value: () => { throw failure; } });
            throws(() => Deno.readLinkSync(Deno.execPath()), error => error === failure);
        }
        strictEqual(probes, 0);
    } finally {
        Object.defineProperty(fs, 'lstat', lstat!);
        Object.defineProperty(fs, 'readlink', readlink!);
    }
});

Deno.test('Deno.readLinkSync maps native errno without probing lstat', () => {
    const fs = import.meta.use('fs');
    const { readlink, lstat } = Object.getOwnPropertyDescriptors(fs);
    const failures = [
        [nativeError.errno.ENOENT, 'NotFound'],
        [nativeError.errno.EACCES, 'PermissionDenied'],
    ] as const;
    let probes = 0;
    try {
        Object.defineProperty(fs, 'lstat', { ...lstat, value: () => { probes++; throw new Error('unexpected probe'); } });
        for (const [code, name] of failures) {
            Object.defineProperty(fs, 'readlink', { ...readlink, value: () => { throw nativeError.Error(code); } });
            throws(() => Deno.readLinkSync(Deno.execPath()), error => error instanceof Error && error.name === name);
        }
        strictEqual(probes, 0);
    } finally {
        Object.defineProperty(fs, 'lstat', lstat!);
        Object.defineProperty(fs, 'readlink', readlink!);
    }
});

Deno.test('Deno symlink preserves argument and application failures without probing the destination', async () => {
    const fs = import.meta.use('fs');
    const asyncfs = import.meta.use('asyncfs');
    const descriptors = Object.getOwnPropertyDescriptors(fs);
    const symlink = Object.getOwnPropertyDescriptor(asyncfs, 'symlink')!;
    let probes = 0;
    try {
        for (const key of ['stat', 'lstat'] as const) {
            Object.defineProperty(fs, key, {
                ...descriptors[key],
                value: () => { probes++; return { isDirectory: false }; },
            });
        }
        for (const failure of [new RangeError('empty target'), new TypeError('capability denied'), new Error('application failure')]) {
            Object.defineProperty(fs, 'symlink', { ...descriptors.symlink, value: () => { throw failure; } });
            Object.defineProperty(asyncfs, 'symlink', { ...symlink, value: () => Promise.reject(failure) });
            throws(() => Deno.symlinkSync('', '/existing', { type: 'file' }), error => error === failure);
            await rejects(() => Deno.symlink('', '/existing', { type: 'file' }), error => error === failure);
        }
        strictEqual(probes, 0);
    } finally {
        for (const key of ['symlink', 'stat', 'lstat'] as const) {
            Object.defineProperty(fs, key, descriptors[key]);
        }
        Object.defineProperty(asyncfs, 'symlink', symlink);
    }
});
