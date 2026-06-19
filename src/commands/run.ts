import { createRuntime } from '../../cts/src/runtime';
import { loadConfigFile } from '../../cts/src/config';
import { fatal, formatError } from '../../cts/src/errors';
import { resources } from '../../cts/src/resources';
import { entryAndDir } from '../utils';
import { preExitHooks } from '../main';
import type { ConfigOptions } from '../../cts/src/types';
import { Inspector } from '../inspector';
import { parseInspectFlags } from './inspect';

const os = import.meta.use('os');
const console = import.meta.use('console');
const timers = import.meta.use('timers');

interface RunOpts {
    file: string;
    args: string[];
    flags: Record<string, string | boolean>;
}

const INSPECTOR_DETACH_GRACE_MS = 250;
const INSPECTOR_DETACH_POLL_MS = 25;

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

    // Register forceStop so Ctrl+C can unblock the main thread when it is
    // frozen inside serviceWhilePaused() → dc.waitRequest().
    const forceStopHook = dbg ? () => (dbg as NonNullable<typeof dbg>).forceStop() : null;
    if (forceStopHook) preExitHooks.push(forceStopHook);

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

    const baselineRefHandles = typeof os.refHandleCount === 'function' ? os.refHandleCount() : 0;

    try {
        const mod = await runtime.loadEntry(entry, {});
        await mod.eval();
    } catch (e) {
        fatal(e, entry);
    }

    // A long-running program (HTTP server, listener, timer, etc.) may schedule
    // its first ref'd handle a tick or two AFTER top-level evaluation resolves.
    // Give those async startups a short grace window before deciding this is a
    // short script and tearing down the inspector.
    if (dbg && await shouldDetachInspector(baselineRefHandles)) {
        if (forceStopHook) {
            const idx = preExitHooks.indexOf(forceStopHook);
            if (idx !== -1) preExitHooks.splice(idx, 1);
        }
        await dbg.detach();
    }

    runtime.flushLock();
}

async function shouldDetachInspector(baselineRefHandles: number): Promise<boolean> {
    if (typeof os.refHandleCount !== 'function') return false;
    if (os.refHandleCount() > baselineRefHandles) return false;

    const deadline = Date.now() + INSPECTOR_DETACH_GRACE_MS;
    while (Date.now() < deadline) {
        await new Promise<void>((resolve) => timers.setTimeout(resolve, INSPECTOR_DETACH_POLL_MS));
        if (os.refHandleCount() > baselineRefHandles) return false;
    }
    return os.refHandleCount() <= baselineRefHandles;
}
