import type { ConfigOptions } from '../../cts/src/api';
import { createRuntime, fatal, joinPaths, loadConfigFile } from '../../cts/src/api';
import { Inspector } from '../inspector';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import { parseInspectFlags } from './inspect';
import { applyNodeOptionConfig } from './node-options';

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

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        silent: opts.flags['silent'] === true,
        disableLock: opts.flags['no-lock'] === true,
    };
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
    installInspectorBridge({
        entryFile: evalPath,
        addInitHook: (hook) => runtime.addInitHook(hook),
        getCurrentInspector: () => dbg,
        setCurrentInspector: (inspector) => { dbg = inspector; },
    });

    try {
        const code = opts.flags.print === true ? printableCode(opts.code, format) : opts.code;
        const mod = runtime.loadSourceEntry(code, evalPath, { main: true }, { lang: ext, format });
        await mod.eval();
    } catch (e) {
        fatal(e, '<eval>');
    } finally {
        uninstallInspectorBridge();
    }

    runtime.flushLock();
}
