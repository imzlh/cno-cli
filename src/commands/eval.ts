import type { ConfigOptions } from '../../cts/src/api';
import { createRuntime, joinPaths, loadConfigFile } from '../../cts/src/api';
import { Inspector } from '../inspector';
import { CliCommandError } from '../command-error';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import { parseInspectFlags } from './inspect';
import { flagsToConfig, publishWorkerRuntimeConfig } from './config-flags';
import { applyLocationFlag, entryUrl } from './run';

const os = import.meta.use('os');

interface EvalOpts {
    code: string;
    flags: Record<string, string | boolean>;
}

function extFromFlags(flags: Record<string, string | boolean>): string {
    const ext = flags.ext;
    if (typeof ext !== 'string' || ext.length === 0) return 'ts';
    return ext.startsWith('.') ? ext.slice(1) : ext;
}

function formatForExt(ext: string): 'esm' | 'cjs' {
    return ext === 'cjs' || ext === 'cts' ? 'cjs' : 'esm';
}

function printableCode(code: string, format: 'esm' | 'cjs'): string {
    return format === 'cjs'
        ? `console.log(${code})`
        : `console.log(await (${code}))`;
}

export async function runEval(opts: EvalOpts): Promise<void> {
    const cwd      = os.cwd;
    const ext      = extFromFlags(opts.flags);
    const format   = formatForExt(ext);
    const evalPath = joinPaths(cwd, `<eval>.${ext}`);
    const fileCfg  = loadConfigFile(cwd);

    applyLocationFlag(opts.flags);

    // CTS stops parsing at eval's source argument, so reuse run's CLI mapping.
    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...flagsToConfig(opts.flags),
    };
    // Preserved from the original bespoke config: eval has no entry directory
    // to lock against, so an absent --no-lock still means "no lock".
    if (cfg.disableLock === undefined) cfg.disableLock = opts.flags['no-lock'] === true;
    if (cfg.silent === undefined) cfg.silent = opts.flags['silent'] === true;
    cfg.ignoreScripts = true;

    const inspect = parseInspectFlags(opts.flags);
    let dbg: Inspector | null = null;
    let bridgeInstalled = false;
    try {
        if (inspect) {
            dbg = new Inspector({
                port: inspect.port,
                host: inspect.host,
                entryFile: evalPath,
                breakOnStart: inspect.breakOnStart,
                waitForClient: inspect.waitForClient,
            });
            await dbg.attach();
        }

        const runtime = createRuntime(cfg, cwd);
        publishWorkerRuntimeConfig(runtime.config);
        installInspectorBridge({
            entryFile: evalPath,
            addInitHook: (hook) => runtime.addInitHook(hook),
            getCurrentInspector: () => dbg,
            setCurrentInspector: (inspector) => { dbg = inspector; },
        });
        bridgeInstalled = true;

        // See the note in src/commands/run.ts: --polyfill had no consumer in cno.
        if (runtime.config.polyfill) {
            try {
                await runtime.loadPolyfill(runtime.config.polyfill);
            } catch (e) {
                throw new CliCommandError(e, `loading polyfill ${runtime.config.polyfill}`);
            }
        }

        Reflect.set(globalThis, '__mainScript', entryUrl(evalPath));
        const code = opts.flags.print === true ? printableCode(opts.code, format) : opts.code;
        const mod = runtime.loadSourceEntry(code, evalPath, { main: true }, { lang: ext, format });
        // See ModuleCompiler.evalTracked: `cno eval` code that require()s its own
        // <eval> path would otherwise abort the process.
        await runtime.compiler.evalTracked(mod);
        runtime.flushLock();
    } catch (e) {
        if (e instanceof CliCommandError) throw e;
        throw new CliCommandError(e, '<eval>');
    } finally {
        // A completed eval must not remain alive solely for the inspector pipe.
        dbg?.allowProcessExit();
        if (bridgeInstalled) uninstallInspectorBridge();
    }
}
