import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

/**
 * Unhandled-rejection reporting must not fire for rejections that ARE handled.
 *
 * A spurious report is no longer cosmetic: the diagnostic path calls
 * requestFailureExitCode(), so a false positive turns a healthy program into
 * rc=1. Every expectation below was measured against real node v24.18.0 —
 * node's contract is: no handler anywhere -> rc=1; handled -> rc=0, silent.
 *
 * The negative controls (`...still reports` cases) are as load-bearing as the
 * positive ones. Suppressing the false positive by widening the silence would
 * pass the first half of this file and break the second.
 */

async function runCno(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
        env: { CTS_SILENT: 'true' },
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

const REJECTION_DIAGNOSTIC = 'unhandled promise rejection';

function hasRejectionDiagnostic(stderr: string): boolean {
    return stderr.includes(REJECTION_DIAGNOSTIC);
}

// A module whose *synchronous* evaluation throws. quickjs runs such a body via
// js_execute_sync_module (quickjs.c:32669), which calls js_async_function_call,
// reads the rejection reason off the resulting promise, then frees that promise
// without ever attaching a handler to it. The error is not lost — it is
// re-raised synchronously as the module's evaluation exception — but the host
// rejection tracker has already seen a rejected promise that no script can
// reach, so it can never be marked handled. A module with top-level await goes
// through js_execute_async_module instead, which does attach handlers, and shows
// no such report.
const THROWING_MODULE = 'throw new Error("thrown once");\n';

Deno.test({ name: 'rejection: caught dynamic import of a throwing module is silent and exits 0', timeout: 20000 }, async () => {
    await withTempDir('rejection-dynamic-import-caught', async (root) => {
        await Deno.writeTextFile(join(root, 'throws.ts'), THROWING_MODULE);
        const main = join(root, 'main.ts');
        // Twice, to also cover the cached-failure re-import: quickjs keeps the
        // evaluation exception on the module and re-raises it without re-running
        // the body, so the second import must not add a second report either.
        await Deno.writeTextFile(main, `
            for (let i = 0; i < 2; i++) {
                try {
                    await import("./throws.ts");
                } catch (error) {
                    console.log(error instanceof Error, error.message);
                }
            }
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'true thrown once',
            'true thrown once',
        ]);
        ok(!hasRejectionDiagnostic(result.stderr),
            `caught import() must not report an unhandled rejection: ${result.stderr}`);
    });
});

Deno.test({ name: 'rejection: uncaught dynamic import of a throwing module still reports and exits 1', timeout: 20000 }, async () => {
    await withTempDir('rejection-dynamic-import-floating', async (root) => {
        await Deno.writeTextFile(join(root, 'throws.ts'), THROWING_MODULE);
        const main = join(root, 'main.ts');
        // Floating promise: nothing ever handles the import rejection, so this
        // is a genuine unhandled rejection. node prints the error and exits 1.
        await Deno.writeTextFile(main, `
            import("./throws.ts");
            console.log("floating started");
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 1, `genuine unhandled rejection must exit 1: ${result.stderr}`);
        strictEqual(result.stdout.trim(), 'floating started');
        ok(result.stderr.includes('thrown once'),
            `the rejection reason must still be reported: ${result.stderr}`);
    });
});

Deno.test({ name: 'rejection: a module body reject with no handler still reports and exits 1', timeout: 20000 }, async () => {
    await withTempDir('rejection-module-body-reject', async (root) => {
        // The module *evaluates fine*; it just leaves a rejected promise behind.
        // Distinguishing this from the case above is the whole difficulty: both
        // carry an Error created at a module top level, with the same innermost
        // stack frame shape. Only handler state separates them.
        await Deno.writeTextFile(join(root, 'leaks.ts'), `
            Promise.reject(new Error("genuinely unhandled"));
            export const x = 1;
        `);
        const main = join(root, 'main.ts');
        await Deno.writeTextFile(main, `
            await import("./leaks.ts");
            console.log("import ok");
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 1, `genuine unhandled rejection must exit 1: ${result.stderr}`);
        strictEqual(result.stdout.trim(), 'import ok');
        ok(result.stderr.includes('genuinely unhandled'),
            `the rejection reason must still be reported: ${result.stderr}`);
    });
});

Deno.test({ name: 'rejection: an async function returning an already-rejected promise is silent and exits 0', timeout: 20000 }, async () => {
    await withTempDir('rejection-bare-return-adoption', async (root) => {
        const main = join(root, 'main.ts');
        // `return inner()` resolves outer's promise WITH a rejected promise.
        // Adoption runs in a later job (PromiseResolveThenableJob), so the
        // rejection tracker's dispatch job observes inner()'s promise before the
        // adoption attaches a handler to it. `return await inner()` attaches the
        // handler in the same job and is silent — the two differ only in when
        // the handler lands, so reporting the first is a timing artifact.
        await Deno.writeTextFile(main, `
            async function inner() { throw new Error("inner boom"); }
            async function outer() { return inner(); }
            try { await outer(); } catch (error) { console.log("CAUGHT", error.message); }
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'CAUGHT inner boom');
        ok(!hasRejectionDiagnostic(result.stderr),
            `an adopted, caught rejection must not be reported: ${result.stderr}`);
    });
});

Deno.test({ name: 'rejection: a plain caught rejection is silent and exits 0', timeout: 20000 }, async () => {
    await withTempDir('rejection-plain-caught', async (root) => {
        const main = join(root, 'main.ts');
        await Deno.writeTextFile(main, `
            try { await Promise.reject(new Error("caught")); }
            catch (error) { console.log("CAUGHT", error.message); }
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'CAUGHT caught');
        ok(!hasRejectionDiagnostic(result.stderr),
            `a caught rejection must not be reported: ${result.stderr}`);
    });
});

Deno.test({ name: 'rejection: a process.on(unhandledRejection) handler suppresses the report and exits 0', timeout: 20000 }, async () => {
    await withTempDir('rejection-node-handler', async (root) => {
        const main = join(root, 'main.ts');
        // Measured on node v24.18.0: with a handler registered, node prints
        // nothing of its own and exits 0.
        await Deno.writeTextFile(main, `
            import process from "node:process";
            process.on("unhandledRejection", (reason) => {
                console.log("HANDLER", reason instanceof Error, reason.message);
            });
            Promise.reject(new Error("delivered"));
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'HANDLER true delivered');
        ok(!hasRejectionDiagnostic(result.stderr),
            `a delivered rejection must not also print the diagnostic: ${result.stderr}`);
    });
});
