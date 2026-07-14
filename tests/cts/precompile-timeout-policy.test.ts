import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { ParseDriver, parseTaskTimeoutMs } from '../../cts/src/api/index.ts';
import { tryLoadOxc } from '../../cts/src/oxc.ts';

Deno.test('precompile policy: workers scan/transform; bytecode compile stays on main', () => {
    strictEqual(parseTaskTimeoutMs('transform'), 60_000);

    const parseSrc = readFileSync(new URL('../../cts/src/parse.ts', import.meta.url), 'utf8');
    ok(!parseSrc.includes('SCAN_TASK_TIMEOUT_MS'), 'old scan kill constant must stay gone');
    ok(parseSrc.includes("kind: 'scan'"), 'worker protocol must carry scan tasks');
    ok(parseSrc.includes('scanQueue'), 'ParseDriver must prioritize scan work');
    ok(parseSrc.includes('async scanFile'), 'ParseDriver must expose worker scan');
    // oxc scan stays on main (IPC overhead > native parse for 1k small files).
    ok(parseSrc.includes('this.oxc || this.maxWorkers <= 0'), 'oxc import scan must prefer main thread');
    ok(parseSrc.includes('Prefer main-thread oxc'), 'policy comment must document oxc-main scan');
    ok(
        !/10_000/.test(parseSrc) || parseSrc.includes('parseTaskTimeoutMs'),
        'must not reintroduce a short wall-clock kill',
    );
    const sendBody = methodBody(parseSrc, 'sendToWorker');
    ok(sendBody.includes("task.kind === 'transform'"), 'only transform tasks may arm a task timer');
    const workerBody = methodBody(parseSrc, 'runParseWorker');
    ok(workerBody.includes('importScanner.scanBytes'), 'worker must scan imports itself');
    ok(workerBody.includes('transformCaptureBytes'), 'worker must transform source itself');
    ok(!workerBody.includes('compileForCache'), 'worker must not compile QuickJS bytecode');
    const resultBody = methodBody(parseSrc, 'onWorkerResult');
    ok(resultBody.includes('compileForCache'), 'main result handler must compile worker output');

    ok(parseSrc.includes('onGlobalTimeout'), 'batch timeout must fail remaining work');
    ok(parseSrc.includes('cancelOutstanding'), 'shutdown must surface cancelled transforms');
    const globalBody = methodBody(parseSrc, 'onGlobalTimeout');
    ok(globalBody.includes('failInfrastructure'), 'onGlobalTimeout must reject the worker batch');
    const infrastructureBody = methodBody(parseSrc, 'failInfrastructure');
    ok(infrastructureBody.includes('cancelOutstanding'), 'infrastructure failure must cancel all pending work');
    ok(infrastructureBody.includes('this.finish(error)'), 'infrastructure failure must reject the batch');
    const workerErrorBody = methodBody(parseSrc, 'onWorkerError');
    ok(workerErrorBody.includes('retryTask'), 'worker transport failure must retry work');
    ok(!workerErrorBody.includes('onFailed'), 'worker transport failure is not a source-file failure');
    const retryBody = methodBody(parseSrc, 'retryTask');
    ok(retryBody.includes('ParseWorkerError'), 'exhausted retries must be an infrastructure error');
    ok(!parseSrc.includes('scanFallback'), 'worker failure must not degrade scan to the main thread');
    ok(parseSrc.includes('this.onProgressCb = undefined'), 'completed batches must release their progress callback');
    ok(parseSrc.includes('this.taskTotal = 0'), 'completed batches must not look active during shutdown');

    const progressSrc = readFileSync(new URL('../../cts/src/utils/progress.ts', import.meta.url), 'utf8');
    const stopBody = methodBody(progressSrc, 'stop');
    const pauseBody = methodBody(progressSrc, 'pause');
    const ensureBody = methodBody(progressSrc, 'ensureTimer');
    ok(stopBody.includes('this.stopped = true'), 'progress stop must be terminal');
    ok(stopBody.includes('this.pause()'), 'stop must clear the timer via pause');
    ok(pauseBody.includes('clearInterval'), 'pause clears the redraw timer without being terminal');
    ok(!pauseBody.includes('this.stopped = true'), 'pause must allow later state updates to re-arm paint');
    ok(pauseBody.includes('this.lastFinished = null'), 'phase pause must drop stale ✓ resolve rows');
    ok(pauseBody.includes('this.items.clear()'), 'phase pause must clear download/resolve item maps');
    ok(ensureBody.includes('this.stopped'), 'late callbacks must not restart a stopped progress timer');
    ok(ensureBody.includes('setInterval'), 'paint is owned by a private timer, not producer kick/flush');
    ok(!progressSrc.includes('kick('), 'producers must not call paint kick');
    ok(!progressSrc.includes('flush('), 'producers must not call paint flush');
    ok(progressSrc.includes('setActivity'), 'progress must expose a light activity label for relative edges');
    ok(progressSrc.includes('this.activity'), 'render must paint the current activity line');
    const depsSrc = readFileSync(new URL('../../cts/src/deps.ts', import.meta.url), 'utf8');
    ok(depsSrc.includes('maybeYieldBatch'), 'scan loop must batch-yield the event loop');
    ok(depsSrc.includes('yieldEventLoop'), 'scan yield is event-loop only, not a progress paint API');
    ok(!depsSrc.includes('prog?.flush()'), 'scan must not drive progress paints');
    ok(depsSrc.includes('setActivity'), 'scan must update activity on every edge');
    ok(depsSrc.includes('SCAN_BATCH_ITEMS'), 'scan batch size must be explicit');
    ok(depsSrc.includes('syncScan'), 'scan path must distinguish sync ImportScanner vs parseImports');
    ok(depsSrc.includes('processEdge'), 'scan edge work must be factored out of the pool loop');
    ok(depsSrc.includes('parentDirKey'), 'edge dedupe must share parentDirKey with the resolver');
    const pathSrc = readFileSync(new URL('../../cts/src/utils/path.ts', import.meta.url), 'utf8');
    ok(pathSrc.includes('export function parentDirKey'), 'parentDirKey must live in path utils');
    const yieldSrc = readFileSync(new URL('../../cts/src/utils/yield.ts', import.meta.url), 'utf8');
    ok(yieldSrc.includes('export function yieldEventLoop'), 'event-loop yield lives outside progress');

    const runtimeSrc = readFileSync(new URL('../../cts/src/runtime/index.ts', import.meta.url), 'utf8');
    // With oxc, precache uses ImportScanner on main (null parseImports); Sucrase uses workers.
    ok(runtimeSrc.includes("oxc ? null : parseDriver.scanFile.bind(parseDriver)"),
        'precache must skip ParseDriver scan when oxc is available');
    ok(runtimeSrc.includes('oxc-main'), 'precache log must report oxc-main scan path');
    const writerSrc = readFileSync(new URL('../../cts/src/pack/writer.ts', import.meta.url), 'utf8');
    ok(writerSrc.includes('new ParseDriver(oxc);'), 'pack must use the auxiliary worker pool');
    ok(writerSrc.includes('parseDriver.scanFile(localPath, lang)'), 'pack entryLang scan must use ParseDriver.scanFile');
    ok(writerSrc.includes('needsLangScan'), 'pack must only force parseImports when entryLang is set');
    ok(writerSrc.includes('oxc-main'), 'pack log must report oxc-main scan path');
    const cleanup = writerSrc.slice(writerSrc.lastIndexOf('} finally {'));
    ok(cleanup.indexOf('await parseDriver.terminate()') < cleanup.indexOf('prog?.stop()'),
        'pack must stop the progress producer before closing its UI');
    // Dual-name heritage (PrecompileDriver / compiler worker aliases) must stay gone.
    ok(!parseSrc.includes('PrecompileDriver'), 'ParseDriver is the only public driver name');
    ok(!parseSrc.includes('isCompilerWorker'), 'isParseWorker is the only worker-role check');
    ok(!parseSrc.includes('runCompilerWorker'), 'runParseWorker is the only worker entry');
});

/** Extract `name(...) { ... }` body by brace depth (not non-greedy regex). */
function methodBody(src: string, name: string): string {
    const needle = `${name}(`;
    let from = 0;
    while (true) {
        const idx = src.indexOf(needle, from);
        if (idx < 0) return '';
        // Prefer method definition: preceded by space/newline/private/public, not `this.`
        const pre = src.slice(Math.max(0, idx - 12), idx);
        if (pre.includes('this.')) { from = idx + needle.length; continue; }
        const brace = src.indexOf('{', idx);
        if (brace < 0) return '';
        let depth = 0;
        for (let i = brace; i < src.length; i++) {
            const c = src.charAt(i);
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) return src.slice(idx, i + 1);
            }
        }
        return '';
    }
}

Deno.test('precompile policy: worker scan keeps long named-import edges', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `SYM_${i}`).join(', ');
    const source = `import { ${names} } from "./constants.js";\nexport const x = 1;\n`;
    const root = makePosixTempDir('precompile-scan-long');
    const driver = new ParseDriver(tryLoadOxc(), 2);
    try {
        mkdirSync(root, { recursive: true });
        const file = join(root, 'registry.ts');
        writeFileSync(file, source);
        deepStrictEqual((await driver.scanFile(file)).sort(), ['./constants.js']);
        strictEqual(parseTaskTimeoutMs('transform'), 60_000);
    } finally {
        await driver.terminate();
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test('precompile policy: concurrent scans share the auxiliary worker pool', async () => {
    const root = makePosixTempDir('precompile-scan-pool');
    // Force Sucrase worker scan: oxc path is main-thread only and never spawns.
    const driver = new ParseDriver(null, 3);
    try {
        mkdirSync(root, { recursive: true });
        const files = Array.from({ length: 24 }, (_, i) => {
            const file = join(root, `mod-${i}.ts`);
            writeFileSync(file, `import "./dep-${i}.js";\nexport const n = ${i};\n`);
            return file;
        });
        const scans = files.map(file => driver.scanFile(file));
        // Drain once so ensureWorkers runs for the queued scan tasks.
        await Promise.resolve();
        const workers = Reflect.get(driver, 'workers');
        ok(Array.isArray(workers) && workers.length === 3, 'three scan workers must be live');
        const first = workers[0];
        ok(first !== null && typeof first === 'object', 'first worker must exist');
        const pipe = Reflect.get(first, 'pipe');
        ok(pipe !== null && typeof pipe === 'object', 'worker message pipe must exist');
        const injectMessageError = Reflect.get(pipe, 'onmessageerror');
        ok(typeof injectMessageError === 'function', 'worker transport error hook must exist');
        injectMessageError(new Error('injected transport failure'));

        const results = await Promise.all(scans);
        for (let i = 0; i < results.length; i++) {
            deepStrictEqual(results[i], [`./dep-${i}.js`]);
        }
    } finally {
        await driver.terminate();
        Deno.removeSync(root, { recursive: true });
    }
});
