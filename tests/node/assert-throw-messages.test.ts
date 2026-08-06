// Message shapes for the four "expected/unwanted exception" assertions.
// Every expected string here was measured against real Node v24.18.0 —
// `generatedMessage` is false in all eight cases because Node builds the text
// itself rather than deriving it from actual/expected.
import { strictEqual } from 'node:assert';
import assert from 'node:assert';

interface Captured {
    message: string;
    generatedMessage: boolean;
    operator: string;
}

function capture(fn: () => unknown): Captured {
    try {
        fn();
    } catch (error) {
        const e = error as Captured;
        return { message: e.message, generatedMessage: e.generatedMessage, operator: e.operator };
    }
    throw new Error('expected the assertion itself to throw');
}

async function captureAsync(fn: () => Promise<unknown>): Promise<Captured> {
    try {
        await fn();
    } catch (error) {
        const e = error as Captured;
        return { message: e.message, generatedMessage: e.generatedMessage, operator: e.operator };
    }
    throw new Error('expected the assertion itself to throw');
}

Deno.test({ name: 'assert: throws() reports Node\'s missing-exception message', timeout: 10000 }, () => {
    const bare = capture(() => assert.throws(() => {}));
    strictEqual(bare.message, 'Missing expected exception.');
    strictEqual(bare.generatedMessage, false);
    strictEqual(bare.operator, 'throws');

    // A named constructor matcher is echoed in parentheses.
    strictEqual(capture(() => assert.throws(() => {}, TypeError)).message,
        'Missing expected exception (TypeError).');

    // A regex matcher has no name, so no parens.
    strictEqual(capture(() => assert.throws(() => {}, /x/)).message,
        'Missing expected exception.');

    // A string second argument IS the message, not a matcher — colon form.
    strictEqual(capture(() => assert.throws(() => {}, 'strmsg')).message,
        'Missing expected exception: strmsg');

    strictEqual(capture(() => assert.throws(() => {}, TypeError, 'custom msg')).message,
        'Missing expected exception (TypeError): custom msg');
});

Deno.test({ name: 'assert: doesNotThrow() appends the actual message on a second line', timeout: 10000 }, () => {
    const bare = capture(() => assert.doesNotThrow(() => { throw new TypeError('boom'); }));
    strictEqual(bare.message, 'Got unwanted exception.\nActual message: "boom"');
    strictEqual(bare.generatedMessage, false);
    strictEqual(bare.operator, 'doesNotThrow');

    strictEqual(
        capture(() => assert.doesNotThrow(() => { throw new TypeError('boom'); }, TypeError, 'custom')).message,
        'Got unwanted exception: custom\nActual message: "boom"'
    );
});

Deno.test({ name: 'assert: rejects() mirrors throws() with "rejection"', timeout: 10000 }, async () => {
    const bare = await captureAsync(() => assert.rejects(async () => {}));
    strictEqual(bare.message, 'Missing expected rejection.');
    strictEqual(bare.generatedMessage, false);
    strictEqual(bare.operator, 'rejects');

    strictEqual((await captureAsync(() => assert.rejects(async () => {}, TypeError))).message,
        'Missing expected rejection (TypeError).');

    strictEqual((await captureAsync(() => assert.rejects(async () => {}, TypeError, 'custom'))).message,
        'Missing expected rejection (TypeError): custom');
});

Deno.test({ name: 'assert: doesNotReject() mirrors doesNotThrow()', timeout: 10000 }, async () => {
    const bare = await captureAsync(() =>
        assert.doesNotReject(async () => { throw new TypeError('boom'); }));
    strictEqual(bare.message, 'Got unwanted rejection.\nActual message: "boom"');
    strictEqual(bare.generatedMessage, false);
    strictEqual(bare.operator, 'doesNotReject');
});
