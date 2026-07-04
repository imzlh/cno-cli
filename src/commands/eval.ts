import { createRuntime, loadConfigFile, fatal, joinPaths } from '../../cts/src/api';
import type { ConfigOptions } from '../../cts/src/api';
import { Inspector } from '../inspector';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import { parseInspectFlags } from './inspect';

const os = import.meta.use('os');

interface EvalOpts {
    code: string;
    flags: Record<string, string | boolean>;
}

export async function runEval(opts: EvalOpts): Promise<void> {
    const cwd      = os.cwd as string;
    const evalPath = joinPaths(cwd, '<eval>.ts');
    const fileCfg  = loadConfigFile(cwd);

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        silent: opts.flags['silent'] === true,
        disableLock: opts.flags['no-lock'] === true,
    };

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
        const mod = runtime.loadSourceEntry(opts.code, evalPath, { main: true });
        await mod.eval();
    } catch (e) {
        fatal(e, '<eval>');
    } finally {
        uninstallInspectorBridge();
    }

    runtime.flushLock();
}
