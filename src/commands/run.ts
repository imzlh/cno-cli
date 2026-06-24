import { createRuntime } from '../../cts/src/runtime';
import { loadConfigFile } from '../../cts/src/config';
import { fatal, formatError } from '../../cts/src/errors';
import { resources } from '../../cts/src/resources';
import { entryAndDir } from '../utils';
import type { ConfigOptions } from '../../cts/src/types';
import { Inspector } from '../inspector';
import { parseInspectFlags } from './inspect';
import { setDenoArgs } from '../../cno/src/utils/args';

const os = import.meta.use('os');
const console = import.meta.use('console');

interface RunOpts {
    file: string;
    args: string[];
    flags: Record<string, string | boolean>;
}

function flagsToConfig(flags: Record<string, string | boolean>): Partial<ConfigOptions> {
    const c: Partial<ConfigOptions> = {};
    const s = (k: string) => typeof flags[k] === 'string' ? flags[k] as string : undefined;
    const b = (k: string) => flags[k] === true || flags[k] === 'true' ? true : undefined;
    if (s('cache-dir'))     c.cacheDir = s('cache-dir');
    if (b('no-lock'))       c.noLock = true;
    if (b('frozen'))        c.frozen = true;
    if (s('lock-dir'))      c.lockDir = s('lock-dir');
    if (b('no-http'))       c.enableHttp = false;
    if (b('no-jsr'))        c.enableJsr = false;
    if (b('no-node'))       c.enableNode = false;
    if (b('no-oxc') || b('no-swc')) c.enableOxc = false;
    if (b('silent'))        c.silent = true;
    if (b('disable-cache')) c.disableCache = true;
    if (s('polyfill'))      c.polyfill = s('polyfill');
    // postinstall scripts only run during `cno cache`, never during `cno run`
    c.ignoreScripts = true;
    return c;
}

export async function runFile(opts: RunOpts): Promise<void> {
    const { entry, dir } = entryAndDir(opts.file);
    const fileCfg = loadConfigFile(dir);
    const cliCfg  = flagsToConfig(opts.flags);

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...cliCfg,
    };

    // CDP debug session MUST attach before createRuntime so our engine.onModule
    // wrapper is in place before CTS's hookEngine() installs its handler.
    const inspect = parseInspectFlags(opts.flags);
    let dbg: any = null;
    if (inspect) {
        dbg = new Inspector({
            port:          inspect.port,
            entryFile:     entry,
            breakOnStart:  inspect.breakOnStart,
            waitForClient: inspect.waitForClient,
        });

		await dbg.attach();
	}

    const runtime = createRuntime(cfg, dir);

    // Wire up CDP scriptParsed hook (installed by DebugSession.attach)
    if (dbg?.scriptInitHook) {
        runtime.addInitHook(dbg.scriptInitHook);
    }

    if (opts.flags['precache'] || opts.flags['reload']) {
        try {
            const info = runtime.resolver.resolve(entry, `${os.cwd}/<precache>`);
            await runtime.precache(info.specPath, info.localPath);
        } catch (e) {
            console.error(formatError(e, 'pre-caching'));
        }
    }

    try {
        setDenoArgs(opts.args);
        const mod = await runtime.loadEntry(entry, {});
        await mod.eval();
    } catch (e) {
        fatal(e, entry);
    }

    runtime.flushLock();
}
