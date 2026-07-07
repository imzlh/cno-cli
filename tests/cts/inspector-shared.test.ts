import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { consoleAPICalledType, buildConsoleStackTrace } from '../../src/inspector/shared/console-utils.ts';
import { CDPDispatcher, CDPError, CdpErrorCode, formatCdpError } from '../../src/inspector/worker/dispatcher.ts';

Deno.test('inspector shared: consoleAPICalledType maps raw console methods to CDP types', () => {
    strictEqual(consoleAPICalledType('warn'), 'warning');
    strictEqual(consoleAPICalledType('group'), 'startGroup');
    strictEqual(consoleAPICalledType('groupEnd'), 'endGroup');
    strictEqual(consoleAPICalledType('timeEnd'), 'timeEnd');
    strictEqual(consoleAPICalledType('count'), 'count');
    strictEqual(consoleAPICalledType('trace'), 'trace');
    strictEqual(consoleAPICalledType('assert'), 'assert');
    strictEqual(consoleAPICalledType('table'), 'table');
    strictEqual(consoleAPICalledType('dir'), 'dir');
    strictEqual(consoleAPICalledType('error'), 'error');
    strictEqual(consoleAPICalledType('info'), 'info');
    strictEqual(consoleAPICalledType('debug'), 'debug');
    strictEqual(consoleAPICalledType('log'), 'log');
    strictEqual(consoleAPICalledType('unknown'), 'log');
});

Deno.test('inspector shared: buildConsoleStackTrace converts frames without mutating input', () => {
    const frames = [{
        functionName: 'fn',
        scriptId: '7',
        url: 'file:///tmp/main.ts',
        lineNumber: 10,
        columnNumber: 2,
        ignored: true,
    }] as any;

    const stack = buildConsoleStackTrace(frames);
    deepStrictEqual(stack, {
        callFrames: [{
            functionName: 'fn',
            scriptId: '7',
            url: 'file:///tmp/main.ts',
            lineNumber: 10,
            columnNumber: 2,
        }],
    });
    ok(!('ignored' in stack!.callFrames[0]!));
    strictEqual(buildConsoleStackTrace([]), undefined);
    strictEqual(buildConsoleStackTrace(undefined), undefined);
});

Deno.test('inspector dispatcher: registerMany dispatches sync and async handlers', async () => {
    const dispatcher = new CDPDispatcher();
    dispatcher.registerMany({
        'Runtime.evaluate': (params) => ({ value: params.expression }),
        'Runtime.await': async () => ({ done: true }),
    });

    strictEqual(dispatcher.has('Runtime.evaluate'), true);
    deepStrictEqual(await dispatcher.dispatch('Runtime.evaluate', { expression: '1 + 1' }), { value: '1 + 1' });
    deepStrictEqual(await dispatcher.dispatch('Runtime.await', {}), { done: true });
});

Deno.test('inspector dispatcher: unknown methods and errors use CDP payload shape', async () => {
    const dispatcher = new CDPDispatcher();
    let caught: unknown;
    try {
        await dispatcher.dispatch('Missing.method', {});
    } catch (e) {
        caught = e;
    }

    ok(caught instanceof CDPError);
    strictEqual((caught as CDPError).code, CdpErrorCode.MethodNotFound);
    deepStrictEqual(formatCdpError(caught), {
        code: CdpErrorCode.MethodNotFound,
        message: 'Unknown CDP method: Missing.method',
    });
    deepStrictEqual(formatCdpError(new CDPError(CdpErrorCode.InvalidParams, 'bad params', { field: 'x' })), {
        code: CdpErrorCode.InvalidParams,
        message: 'bad params',
        data: { field: 'x' },
    });
    deepStrictEqual(formatCdpError(new Error('boom')), {
        code: CdpErrorCode.InternalError,
        message: 'boom',
    });
});
