import { os } from '../../cts/src/utils';
import { createRuntime } from '../../cts/src/runtime';
import { loadConfigFile } from '../../cts/src/config';
import { fatal } from '../../cts/src/errors';
import { joinPaths } from '../../cts/src/utils/path';
import type { ConfigOptions, ModuleInfo } from '../../cts/src/types';

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
        noLock: opts.flags['no-lock'] === true,
    };

    const runtime = createRuntime(cfg, cwd);

    const info: ModuleInfo = {
        specPath:  evalPath,
        localPath: evalPath,
        format:    'esm',
        fileKind:  'source',
    };

    try {
        const mod = runtime.loader.loadSource(opts.code, info, { main: true });
        await mod.eval();
    } catch (e) {
        fatal(e, '<eval>');
    }

    runtime.flushLock();
}
