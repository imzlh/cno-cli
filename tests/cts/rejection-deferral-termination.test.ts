import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

/**
 * TERMINATION guards for the unhandled-rejection deferral in
 * tjs__promise_rejection_dispatch (circu.js/src/vm.c).
 *
 * The dispatch job can run one job too early: thenable adoption happens in a
 * later PromiseResolveThenableJob, so `return <rejected promise>` from an async
 * function looked unhandled even though a handler was about to be attached. The
 * fix re-enqueues the dispatch while other jobs are pending.
 *
 * The danger in that fix is non-termination, and it is not hypothetical: a
 * deferral is ITSELF a pending job, so deferring unconditionally on
 * JS_IsJobPending makes two rejections in one tick ping-pong forever. That is
 * what `two rejections in one tick` below exists to catch -- it is a HANG
 * detector, and it fails by timing out.
 *
 * The `still reports` cases are negative controls of equal weight to the
 * positive ones: the false positive must not be traded for a false negative.
 * Trading one for the other would pass half this file and break the other half.
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

Deno.test({ name: 'rejection deferral: two rejections in one tick both report and terminate', timeout: 30000 }, async () => {
    await withTempDir('rejection-two-in-one-tick', async (root) => {
        const main = join(root, 'main.ts');
        // Each rejection's deferral is a pending job from the other's point of
        // view. A deferral loop without a bound never drains this. Both are
        // genuinely floating, so both must be reported.
        await Deno.writeTextFile(main, `
            Promise.reject(new Error("first floating"));
            Promise.reject(new Error("second floating"));
            console.log("two floated");
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 1, `two floating rejections must exit 1: ${result.stderr}`);
        strictEqual(result.stdout.trim().split(/\r?\n/)[0], 'two floated');
        const combined = result.stdout + result.stderr;
        ok(combined.includes('first floating'),
            `the first rejection must be reported: ${combined}`);
        ok(combined.includes('second floating'),
            `the second rejection must be reported, not starved by the first: ${combined}`);
    });
});

Deno.test({ name: 'rejection deferral: many rejections in one tick all terminate', timeout: 30000 }, async () => {
    await withTempDir('rejection-many-in-one-tick', async (root) => {
        const main = join(root, 'main.ts');
        // Scale the ping-pong: N coexisting deferrals must still drain. With a
        // per-deferral hop bound this is linear in N, not exponential.
        await Deno.writeTextFile(main, `
            for (let i = 0; i < 50; i++) Promise.reject(new Error("floating " + i));
            console.log("fifty floated");
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 1, `fifty floating rejections must exit 1: ${result.stderr}`);
        strictEqual(result.stdout.trim().split(/\r?\n/)[0], 'fifty floated');
    });
});

Deno.test({ name: 'rejection deferral: a deep return-adoption chain stays silent and exits 0', timeout: 30000 }, async () => {
    await withTempDir('rejection-deep-adoption', async (root) => {
        const main = join(root, 'main.ts');
        // Each `return prev()` inserts one more adoption hop before the handler
        // lands. The depth is deliberately far beyond the internal hop bound:
        // the rejection is handled at the top, so it must stay silent no matter
        // how many hops adoption takes.
        await Deno.writeTextFile(main, `
            async function leaf() { throw new Error("deep boom"); }
            let fn = leaf;
            for (let i = 0; i < 40; i++) { const prev = fn; fn = async function () { return prev(); }; }
            try { await fn(); } catch (error) { console.log("CAUGHT", error.message); }
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, `a caught deep-adoption rejection must exit 0: ${result.stderr}`);
        strictEqual(result.stdout.trim(), 'CAUGHT deep boom');
        ok(!(result.stdout + result.stderr).includes('unhandled promise rejection'),
            `a handled rejection must not be reported at any adoption depth: ${result.stderr}`);
    });
});

Deno.test({ name: 'rejection deferral: a floating rejection during a busy tick still reports', timeout: 30000 }, async () => {
    await withTempDir('rejection-busy-tick', async (root) => {
        const main = join(root, 'main.ts');
        // The realistic shape of the starvation risk: a genuine unhandled
        // rejection while a long but FINITE microtask chain keeps the job queue
        // non-empty. The chain drains, so the report must still arrive. Only an
        // unbounded chain can starve it, and such a program never exits at all
        // (node loses the report there too -- measured on v24.18.0).
        await Deno.writeTextFile(main, `
            Promise.reject(new Error("busy tick report"));
            let n = 0;
            function step() { if (++n < 5000) Promise.resolve().then(step); }
            step();
            console.log("chain started");
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 1, `a floating rejection must still exit 1 on a busy tick: ${result.stderr}`);
        strictEqual(result.stdout.trim().split(/\r?\n/)[0], 'chain started');
        ok((result.stdout + result.stderr).includes('busy tick report'),
            `the report must survive a finite microtask chain: ${result.stderr}`);
    });
});

Deno.test({ name: 'rejection deferral: adoption resolving to a VALUE still reports a later floating rejection', timeout: 30000 }, async () => {
    await withTempDir('rejection-adoption-then-floating', async (root) => {
        const main = join(root, 'main.ts');
        // Mixes the two paths in one program: a legitimately adopted rejection
        // (silent) followed by a genuinely floating one (reported). The deferral
        // counter must not let the handled case suppress the unhandled one.
        await Deno.writeTextFile(main, `
            async function inner() { throw new Error("adopted and caught"); }
            async function outer() { return inner(); }
            try { await outer(); } catch (error) { console.log("CAUGHT", error.message); }
            Promise.reject(new Error("later floating"));
            console.log("floated after");
        `);
        const result = await runCno(['run', main], root);
        strictEqual(result.code, 1, `the later floating rejection must still exit 1: ${result.stderr}`);
        const combined = result.stdout + result.stderr;
        ok(combined.includes('CAUGHT adopted and caught'),
            `the adopted rejection must still be catchable: ${combined}`);
        ok(!combined.includes('adopted and caught\n    at') && combined.includes('later floating'),
            `the floating rejection must be reported: ${combined}`);
    });
});
