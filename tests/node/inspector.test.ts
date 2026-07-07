import { ok, strictEqual } from 'node:assert';
import * as inspector from 'node:inspector';

// --- 1. inspector.url() returns a string or undefined ----------------------

Deno.test('inspector: url() returns string or undefined', () => {
    const u = inspector.url();
    ok(u === undefined || typeof u === 'string');
    strictEqual(u, undefined);
});

// --- 3. inspector.waitForDebugger is callable ------------------------------

Deno.test('inspector: waitForDebugger is callable', () => {
    try {
        strictEqual(inspector.waitForDebugger(), undefined);
    } catch (e) {
        ok(e instanceof Error);
        ok(/Inspector is not active|not available/i.test(e.message));
    }
});

// --- 4. inspector.console is an object -------------------------------------

Deno.test('inspector: console object exists', () => {
    ok(inspector.console && typeof inspector.console === 'object');
    ok(typeof inspector.console.log === 'function');
});

Deno.test('inspector: close returns undefined when inspector is not active', () => {
    strictEqual(inspector.close(), undefined);
});

// --- 5. inspector.Session is a class ---------------------------------------

Deno.test('inspector: Session is a constructor', () => {
    ok(typeof inspector.Session === 'function');
});

// --- 6. Session.post / on / connect / disconnect ---------------------------

Deno.test('inspector: Session methods exist', () => {
    const S = inspector.Session;
    ok(typeof S.prototype.post === 'function');
    ok(typeof S.prototype.connect === 'function');
    ok(typeof S.prototype.disconnect === 'function');
    ok(typeof S.prototype.on === 'function');
    ok(typeof S.prototype.once === 'function');
    ok(typeof S.prototype.removeListener === 'function');
});

Deno.test('inspector: Session.connect and disconnect return undefined', () => {
    const session = new inspector.Session();
    strictEqual(session.connect(), undefined);
    strictEqual(session.disconnect(), undefined);
});

Deno.test('inspector: Session.post before connect throws ERR_INSPECTOR_NOT_CONNECTED', () => {
    const session = new inspector.Session();
    let caught: NodeJS.ErrnoException | null = null;
    try {
        session.post('Runtime.enable', () => {});
    } catch (error) {
        caught = error as NodeJS.ErrnoException;
    }
    ok(caught instanceof Error);
    strictEqual(caught?.code, 'ERR_INSPECTOR_NOT_CONNECTED');
});

Deno.test('inspector: Session.post evaluates expressions after connect', async () => {
    const session = new inspector.Session();
    session.connect();
    try {
        const result = await new Promise<number>((resolve, reject) => {
            session.post('Runtime.evaluate', { expression: '1 + 2' }, (error, response) => {
                if (error) reject(error);
                else resolve((response as { result?: { value?: number } })?.result?.value ?? NaN);
            });
        });
        strictEqual(result, 3);
    } finally {
        session.disconnect();
    }
});

Deno.test('inspector: Session.post after disconnect throws ERR_INSPECTOR_NOT_CONNECTED', () => {
    const session = new inspector.Session();
    session.connect();
    session.disconnect();
    let caught: NodeJS.ErrnoException | null = null;
    try {
        session.post('Runtime.enable', () => {});
    } catch (error) {
        caught = error as NodeJS.ErrnoException;
    }
    ok(caught instanceof Error);
    strictEqual(caught?.code, 'ERR_INSPECTOR_NOT_CONNECTED');
});

// --- 7. inspector.open with wait=true returns a handle ---------------------

Deno.test('inspector: open returns a handle with dispose', () => {
    let handle: any;
    try {
        handle = inspector.open(0, '127.0.0.1', false);
        if (handle !== undefined) {
            ok(
                typeof handle.dispose === 'function' ||
                typeof handle[Symbol.dispose] === 'function'
            );
        }
    } catch (e) {
        ok(e instanceof Error);
        ok(/not available|operation not permitted|permission|EACCES|EADDRINUSE/i.test(e.message));
    } finally {
        if (handle?.dispose) handle.dispose();
        else if (handle?.[Symbol.dispose]) handle[Symbol.dispose]();
    }
});
