import type { ConfigOptions } from '../../cts/src/api';
import { joinPaths, loadConfigFile } from '../../cts/src/api';
import { CliCommandError } from '../command-error';
import { flagsToConfig } from '../config';
import { entryUrl, sourceExtension } from '../utils';
import type { Args } from '../../cno/src/utils/args';
import { applyLocationFlag, effectiveRuntimeFlags, openKernelRuntime, type KernelContext, type KernelRuntime } from '../kernel';

const os = import.meta.use('os');

interface EvalOpts {
    code: string;
    flags: Record<string, string | boolean>;
    kernel: KernelContext;
    rawArgs: Args;
    config?: Partial<ConfigOptions>;
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
    const flags = effectiveRuntimeFlags(opts.kernel, opts.flags);
    const cwd      = os.cwd;
    const ext      = sourceExtension(flags.ext) ?? 'ts';
    const format   = formatForExt(ext);
    const evalPath = joinPaths(cwd, `<eval>.${ext}`);
    const fileCfg  = loadConfigFile(cwd);

    applyLocationFlag(flags);

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...opts.config,
        ...opts.kernel.config,
        ...flagsToConfig(flags),
    };
    cfg.ignoreScripts = true;

    let session: KernelRuntime | undefined;
    try {
        session = await openKernelRuntime(opts.kernel, evalPath, cfg, cwd);
        const { runtime } = session;
        await session.initialize(opts.rawArgs);

        Reflect.set(globalThis, '__mainScript', entryUrl(evalPath));
        const code = flags.print === true ? printableCode(opts.code, format) : opts.code;
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
        session?.finish();
    }
}
