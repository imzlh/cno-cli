import { os, console } from '../../cts/src/utils';
import { createRuntime } from '../../cts/src/runtime';
import { loadConfigFile } from '../../cts/src/config';
import { dirname, normalizePath, isAbsolute, joinPaths } from '../../cts/src/utils/path';
import type { ConfigOptions } from '../../cts/src/types';
import { C } from '../help';

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

export async function runCache(file: string, flags: Record<string, string | boolean>): Promise<void> {
    if (!file) {
        console.error(`Usage: ${C.cyan('cno cache')} ${C.cyan('<file.ts>')}`);
        os.exit(1);
    }
    const { entry, dir } = entryAndDir(file);
    const fileCfg = loadConfigFile(dir);
    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        silent: flags['silent'] === true,
        noLock: false,
        cacheDir: typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] as string : undefined,
        lockDir:  typeof flags['lock-dir']  === 'string' ? flags['lock-dir']  as string : undefined,
    };

    const runtime = createRuntime(cfg, dir);
    const info    = runtime.resolver.resolve(entry, `${os.cwd}/<cache-cmd>`);
    await runtime.precache(info.specPath, info.localPath);
    const lockDir = cfg.lockDir ?? dir;
    console.log(`${C.green('✔')} ${runtime.resolver.lockSize} modules cached`);
    console.log(`  ${C.dim('Lock:')} ${lockDir}/cts.lock`);
}
