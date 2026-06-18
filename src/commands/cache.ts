import { createRuntime } from '../../cts/src/runtime';
import { loadConfigFile } from '../../cts/src/config';
import { joinPaths } from '../../cts/src/utils/path';
import { stripJsonc } from '../../cts/src/utils/misc';
import type { ConfigOptions } from '../../cts/src/types';
import { C } from '../help';
import { entryAndDir } from '../utils';

// TODO: make it fully async
const os = import.meta.use('os');
const console = import.meta.use('console');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

export async function runCache(file: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
    if (!file) {
        await runCacheNoArgs(flags);
        return;
    }
    const { entry } = entryAndDir(file);
    const projectDir = String(os.cwd).replace(/\\/g, '/');
    const fileCfg = loadConfigFile(projectDir);
    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        silent: flags['silent'] === true,
        noLock: false,
        enableOxc: flags['no-oxc'] === true || flags['no-swc'] === true ? false : fileCfg.enableOxc,
        ignoreScripts: flags['ignore-scripts'] === true,
        cacheDir: typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] as string : undefined,
        lockDir:  typeof flags['lock-dir']  === 'string' ? flags['lock-dir']  as string : projectDir,
    };

    const runtime = createRuntime(cfg, projectDir);
    let info;
    try {
        info = runtime.resolver.resolve(entry, `${os.cwd}/<cache-cmd>`);
    } catch (e) {
        console.error(`${C.warn('⚠')} Cannot resolve entry: ${entry}`);
        console.error(`  ${(e instanceof Error ? e.message : String(e))}`);
        os.exit(1);
        return;
    }
    await runtime.precache(info.specPath, info.localPath);
    const lockDir = cfg.lockDir ?? projectDir;
    console.log(`${C.green('✔')} ${runtime.resolver.lockSize} modules cached`);
    console.log(`  ${C.dim('Lock:')} ${joinPaths(lockDir, 'cts.lock')}`);
}

async function runCacheNoArgs(flags: Record<string, string | boolean>): Promise<void> {
    const dir = os.cwd;
    const fileCfg = loadConfigFile(dir);
    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        silent: flags['silent'] === true,
        noLock: false,
        enableOxc: flags['no-oxc'] === true || flags['no-swc'] === true ? false : fileCfg.enableOxc,
        ignoreScripts: flags['ignore-scripts'] === true,
        cacheDir: typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] as string : undefined,
        lockDir:  typeof flags['lock-dir']  === 'string' ? flags['lock-dir']  as string : undefined,
    };
    const runtime = createRuntime(cfg, dir);
    const specs = collectSpecifiers(dir);

    if (specs.size === 0) {
        console.error(`${C.warn('⚠')} No imports in deno.json or dependencies in package.json`);
        os.exit(1); return;
    }

    await runtime.precacheFromSpecifiers([...specs], dir);

    const lockDir = cfg.lockDir ?? dir;
    console.log(`${C.green('✔')} ${runtime.resolver.lockSize} modules cached`);
    console.log(`  ${C.dim('Lock:')} ${joinPaths(lockDir, 'cts.lock')}`);
}

function collectSpecifiers(dir: string): Set<string> {
    const specs = new Set<string>();

    // deno.json / deno.jsonc imports
    for (const name of ['deno.json', 'deno.jsonc']) {
        const p = joinPaths(dir, name);
        if (!fs.exists(p)) continue;
        let dc: Record<string, any> | null = null;
        try { dc = JSON.parse(stripJsonc(engine.decodeString(fs.readFile(p)))); } catch {}
        if (dc?.imports && typeof dc.imports === 'object') {
            for (const [, value] of Object.entries(dc.imports)) {
                if (typeof value === 'string' && value.trim()) {
                    specs.add(value);
                }
            }
        }
        // Don't break — also check package.json below
    }

    // package.json dependencies / devDependencies
    const pkgP = joinPaths(dir, 'package.json');
    if (fs.exists(pkgP)) {
        let pkg: Record<string, any> | null = null;
        try { pkg = JSON.parse(engine.decodeString(fs.readFile(pkgP))); } catch {}
        if (pkg) {
            for (const field of ['dependencies', 'devDependencies'] as const) {
                const deps = pkg[field];
                if (!deps || typeof deps !== 'object') continue;
                for (const [name, version] of Object.entries(deps)) {
                    if (typeof version === 'string') {
                        specs.add(`npm:${name}@${version}`);
                    }
                }
            }
        }
    }

    return specs;
}
