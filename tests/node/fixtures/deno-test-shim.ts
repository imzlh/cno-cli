/**
 * Minimal Deno.test shim so a test file can run through `cno run`, which does
 * not install the Deno test harness. The test file imports this module FIRST:
 * its `Deno.test(...)` registrations are queued, and the file then calls
 * `runRegisteredTests()` at top level. Steps are awaited within their parent.
 *
 * Usage, from a small runner file next to the test:
 *   import '../../tests/node/fixtures/deno-test-shim.ts';
 *   import './some.test.ts';
 *   await (await import('../../tests/node/fixtures/deno-test-shim.ts')).runRegisteredTests();
 */

type TestFn = () => unknown | Promise<unknown>;

const registered: { name: string; fn: TestFn }[] = [];

function register(nameOrDef: unknown, fn?: TestFn): void {
    if (typeof nameOrDef === 'string') {
        if (fn) registered.push({ name: nameOrDef, fn });
        return;
    }
    const def = nameOrDef as { name?: string; fn?: TestFn } | null;
    if (def && typeof def.fn === 'function') registered.push({ name: def.name ?? '(anonymous)', fn: def.fn });
}

const step = async (_name: string, fn: TestFn) => await fn();
Object.assign(register, { step, ignore: () => {}, only: register });

// `Deno` is a read-only global; only the missing method is added.
const deno = Deno as unknown as Record<string, unknown>;
if (typeof deno.test !== 'function') deno.test = register;

/** Run every registered test; throws if any failed, after reporting all. */
export async function runRegisteredTests(): Promise<{ passed: number; failed: string[] }> {
    const failed: string[] = [];
    let passed = 0;
    for (const { name, fn } of registered.splice(0)) {
        try {
            const result = fn();
            if (result && typeof (result as Promise<unknown>).then === 'function') await result;
            passed++;
        } catch (error) {
            failed.push(`${name} :: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        }
    }
    for (const line of failed) console.log(`FAIL ${line}`);
    console.log(`shim result: ${passed} passed, ${failed.length} failed`);
    if (failed.length > 0) throw new Error(`${failed.length} test(s) failed (see FAIL lines above)`);
    return { passed, failed };
}
