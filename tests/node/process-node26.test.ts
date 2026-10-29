import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import processDefault, * as process from 'node:process';

Deno.test('process node26: reports the Node 26 compatibility baseline', () => {
    strictEqual(process.version, 'v26.6.0');
    strictEqual(process.versions.node, '26.6.0');
    strictEqual(process.versions.modules, '144');
    strictEqual(process.versions.napi, '9');
    strictEqual(process.release.name, 'node');
    strictEqual(process.release.lts, undefined);
    strictEqual(process.features.inspector, true);
    strictEqual(process.features.require_module, true);
    strictEqual(process.features.typescript, false);
    strictEqual(processDefault.version, process.version);
    strictEqual(processDefault.versions, process.versions);
});

Deno.test('process node26: additional capture callbacks run newest first and can handle', async () => {
    strictEqual(
        process.addUncaughtExceptionCaptureCallback,
        processDefault.addUncaughtExceptionCaptureCallback,
    );
    for (const value of [undefined, null, 1, 'callback']) {
        throws(
            () => Reflect.apply(process.addUncaughtExceptionCaptureCallback, process, [value]),
            (error: unknown) => error !== null && typeof error === 'object' &&
                Reflect.get(error, 'code') === 'ERR_INVALID_ARG_TYPE',
        );
    }

    const failure = new Error('node26 additional capture');
    const calls: string[] = [];
    process.addUncaughtExceptionCaptureCallback((error) => {
        strictEqual(error, failure);
        calls.push('oldest');
        return false;
    });
    process.addUncaughtExceptionCaptureCallback((error) => {
        strictEqual(error, failure);
        calls.push('handler');
        return true;
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('capture callbacks did not run')), 100);
        process.addUncaughtExceptionCaptureCallback((error) => {
            clearTimeout(timer);
            strictEqual(error, failure);
            calls.push('newest');
            queueMicrotask(resolve);
            return false;
        });
        process.nextTick(() => { throw failure; });
    });

    deepStrictEqual(calls, ['newest', 'handler']);
});
