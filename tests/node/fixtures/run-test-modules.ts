/**
 * Runs test files through `cno run` instead of `cno test`.
 *
 * `cno test` loads `node:*` from the polyfill cache, which another agent may be
 * refreshing concurrently; and `cno run` does not install Deno.test. So for a
 * self-contained test file (top-level asserts, or Deno.test only), copy it
 * byte-for-byte next to this runner and run it here — its relative imports keep
 * resolving, and it loads `node:*` from the same cache with no worker layer.
 *
 * usage: cno run tests/node/fixtures/run-test-modules.ts <test file>...
 *        (a Deno.test file additionally needs the two-line shim harness; see
 *         deno-test-shim.ts)
 */

const root = new URL('../../../', import.meta.url).href;

function firstLine(error: unknown): string {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const line = text.split('\n').find((l) => /^\s*(AssertionError|Error|TypeError|RangeError|InternalError)/.test(l));
    return line?.trim() ?? text.split('\n')[0] ?? '';
}

async function runWrapped(spec: string): Promise<{ failed: boolean; error?: string }> {
    let failed = false;
    const assertModule = await import('node:assert') as unknown as Record<string, unknown> & {
        fail(...args: unknown[]): never;
        throws(fn: unknown, ...rest: unknown[]): unknown;
    };
    const fastFail = ((value: unknown, message?: string) => {
        if (value) return;
        failed = true;
        assertModule.fail(message ?? 'Assertion failed');
    }) as unknown as Record<string, unknown>;
    fastFail.fail = (...args: unknown[]) => {
        failed = true;
        return assertModule.fail(...args);
    };
    fastFail.throws = (fn: unknown, ...rest: unknown[]) => {
        try {
            return assertModule.throws(fn, ...rest);
        } catch (error) {
            failed = true;
            throw error;
        }
    };
    for (const key of Object.keys(assertModule)) {
        if (!(key in fastFail)) fastFail[key] = assertModule[key];
    }
    (globalThis as unknown as Record<string, unknown>).assert = fastFail;
    try {
        await import(spec);
    } catch (error) {
        return { failed: true, error: firstLine(error) };
    }
    return { failed };
}

const targets = Deno.args;
const failures: string[] = [];
for (const target of targets) {
    const label = target.split(/[\\/]/).pop() as string;
    // Resolve from the runner's own directory (tests/node/fixtures), so a test
    // copied in beside it can be named by basename.
    const spec = new URL(target, root).href;
    const { failed, error } = await runWrapped(spec);
    if (!failed) { console.log(`PASS ${label}`); continue; }
    failures.push(label);
    console.log(`FAIL ${label}${error ? `: ${error}` : ': assertion failed'}`);
}
console.log(`modules: ${targets.length - failures.length}/${targets.length} passed`);
if (failures.length > 0) throw new Error(`${failures.length} module(s) failed`);
