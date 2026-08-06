import type { ConfigOptions } from '../../cts/src/api';
import { createRuntime, fatal, joinPaths, loadConfigFile } from '../../cts/src/api';
import { Inspector } from '../inspector';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import { parseInspectFlags } from './inspect';
import { applyNodeOptionConfig } from './node-options';
import { flagsToConfig } from './run';

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

    // specs/run/_070_location: polyfill may already have location=undefined.
    const loc = opts.flags['location'];
    if (typeof loc === 'string' && loc.length > 0) {
        try { os.setenv('CNO_LOCATION', loc); } catch { /* */ }
        try {
            const apply = Reflect.get(globalThis, '__cno_applyLocation');
            if (typeof apply === 'function') apply(loc);
        } catch { /* */ }
    }

    // cts's own re-parse of os.args (createConfig → parseArgs) breaks at the
    // first positional token, so the `eval` subcommand form loses every flag.
    // Building a bespoke config here meant --no-http/--no-node/--memory-limit
    // and friends were silently dead on `cno eval` while working on `cno run`:
    // OBSERVED `cno eval --no-http "import('http://…')"` actually performed the
    // fetch, and `cno eval --memory-limit=64MB` retained 300k objects and
    // exited 0. Share run's mapping so a flag cannot be live on one command and
    // dead on another.
    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...flagsToConfig(opts.flags),
    };
    // Preserved from the original bespoke config: eval has no entry directory
    // to lock against, so an absent --no-lock still means "no lock".
    if (cfg.disableLock === undefined) cfg.disableLock = opts.flags['no-lock'] === true;
    if (cfg.silent === undefined) cfg.silent = opts.flags['silent'] === true;
    applyNodeOptionConfig(cfg, opts.flags);

    const inspect = parseInspectFlags(opts.flags);
    let dbg: Inspector | null = null;
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
    // See the note in src/commands/run.ts: --polyfill had no consumer in cno.
    if (runtime.config.polyfill) {
        try {
            await runtime.loadPolyfill(runtime.config.polyfill);
        } catch (e) {
            fatal(e, `loading polyfill ${runtime.config.polyfill}`);
        }
    }
    installInspectorBridge({
        entryFile: evalPath,
        addInitHook: (hook) => runtime.addInitHook(hook),
        getCurrentInspector: () => dbg,
        setCurrentInspector: (inspector) => { dbg = inspector; },
    });

    try {
        const code = opts.flags.print === true ? printableCode(opts.code, format) : opts.code;
        const mod = runtime.loadSourceEntry(code, evalPath, { main: true }, { lang: ext, format });
        // See ModuleCompiler.evalTracked: `cno eval` code that require()s its own
        // <eval> path would otherwise abort the process.
        await runtime.compiler.evalTracked(mod);
    } catch (e) {
        fatal(e, '<eval>');
    } finally {
        uninstallInspectorBridge();
    }

    runtime.flushLock();
}
