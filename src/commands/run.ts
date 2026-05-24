import { os, console } from '../../cts/src/utils';
import { createRuntime } from '../../cts/src/runtime';
import { loadConfigFile } from '../../cts/src/config';
import { fatal, formatError } from '../../cts/src/errors';
import { dirname, normalizePath, isAbsolute, joinPaths } from '../../cts/src/utils/path';
import type { ConfigOptions } from '../../cts/src/types';

interface RunOpts {
    file: string;
    args: string[];
    flags: Record<string, string | boolean>;
}

function entryAndDir(raw: string): { entry: string; dir: string } {
    const hasProto = /^[a-z][a-z0-9+\-.]*:/i.test(raw) && !raw.startsWith('/');
    let entry: string;
    if (hasProto || raw.startsWith('/') || isAbsolute(raw)) {
        entry = raw;
    } else {
        const cwd = String(os.cwd).replace(/\\/g, '/');
        entry = normalizePath(joinPaths(cwd, raw.replace(/\\/g, '/')));
    }
    return { entry, dir: hasProto ? (os.cwd as string) : dirname(entry) };
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
    if (b('silent'))        c.silent = true;
    if (b('disable-cache')) c.disableCache = true;
    if (s('polyfill'))      c.polyfill = s('polyfill');
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

    const runtime = createRuntime(cfg, dir);

    if (opts.flags['precache'] || opts.flags['reload']) {
        try {
            const info = runtime.resolver.resolve(entry, `${os.cwd}/<precache>`);
            await runtime.precache(info.specPath, info.localPath);
        } catch (e) {
            console.error(formatError(e, 'pre-caching'));
        }
    }

    try {
        const mod = await runtime.loadEntry(entry, {});
        await mod.eval();
    } catch (e) {
        fatal(e, entry);
    }

    runtime.flushLock();
}
