import { createRuntime } from '../../cts/src/runtime/index';
import { loadConfigFile } from '../../cts/src/config';
import { fatal, formatError } from '../../cts/src/errors';
import { entryAndDir } from '../utils';
import type { ConfigOptions } from '../../cts/src/types';
import { Inspector } from '../inspector';
import { parseInspectFlags } from './inspect';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import setArgs, { type Args } from '../../cno/src/utils/args';

const os = import.meta.use('os');
const console = import.meta.use('console');

interface RunOpts {
    file: string;
    args: string[];
    flags: Record<string, string | boolean>;
    rawArgs: Args;
}

function flagsToConfig(flags: Record<string, string | boolean>): Partial<ConfigOptions> {
    const c: Partial<ConfigOptions> = {};
    const s = (k: string) => typeof flags[k] === 'string' ? flags[k] as string : undefined;
    const b = (k: string) => flags[k] === true || flags[k] === 'true' ? true : undefined;
    if (s('cache-dir'))     c.cacheDir = s('cache-dir');
    if (b('no-lock'))       c.disableLock = true;
    if (b('frozen'))        c.frozen = true;
    if (s('lock-dir'))      c.lockDir = s('lock-dir');
    if (b('no-http'))       c.enableHttp = false;
    if (b('no-jsr'))        c.enableJsr = false;
    if (b('no-node'))       c.enableNode = false;
    if (b('no-oxc') || b('no-swc')) c.enableOxc = false;
    if (b('silent'))        c.silent = true;
    if (b('disable-cache')) c.enableCache = false;
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
            host:          inspect.host,
            entryFile:     entry,
            breakOnStart:  inspect.breakOnStart,
            waitForClient: inspect.waitForClient,
        });

		await dbg.attach();
	}

    const runtime = createRuntime(cfg, dir);
    installInspectorBridge({
        entryFile: entry,
        addInitHook: (hook) => runtime.addInitHook(hook),
        getCurrentInspector: () => dbg,
        setCurrentInspector: (inspector) => { dbg = inspector; },
    });

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
        setArgs(opts.rawArgs);
        const mod = await runtime.loadEntry(entry, {});
        await mod.eval();
    } catch (e) {
        fatal(e, entry);
    } finally {
        uninstallInspectorBridge();
    }

    runtime.flushLock();
}
