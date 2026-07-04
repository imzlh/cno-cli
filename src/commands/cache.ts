import { createRuntime, loadConfigFile, joinPaths, cwd, stripJsonc } from '../../cts/src/api';
import type { ConfigOptions } from '../../cts/src/api';
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
    const projectDir = cwd();
    const fileCfg = loadConfigFile(projectDir);
    const cfg = buildCacheConfig(fileCfg, flags);

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
    // Also seed package.json/deno.json declared deps (including devDependencies) —
    // dev-tool bins invoked later by `cno task` (e.g. a "dev" script) aren't reachable
    // from the entry file's static import graph, so they'd never get precached otherwise.
    await runtime.precacheEntryAndSpecifiers(info.specPath, info.localPath, [...collectSpecifiers(projectDir)], projectDir);
    console.log(`${C.green('✔')} ${runtime.resolver.lockSize} modules cached`);
    console.log(`  ${C.dim('Lock:')} ${runtime.resolver.lockPath}`);
}

async function runCacheNoArgs(flags: Record<string, string | boolean>): Promise<void> {
    const dir = os.cwd;
    const fileCfg = loadConfigFile(dir);
    const cfg = buildCacheConfig(fileCfg, flags);
    const runtime = createRuntime(cfg, dir);
    const specs = collectSpecifiers(dir);

    if (specs.size === 0) {
        console.error(`${C.warn('⚠')} No imports in deno.json or dependencies in package.json`);
        os.exit(1); return;
    }

    await runtime.precacheFromSpecifiers([...specs], dir);

    console.log(`${C.green('✔')} ${runtime.resolver.lockSize} modules cached`);
    console.log(`  ${C.dim('Lock:')} ${runtime.resolver.lockPath}`);
}

function buildCacheConfig(
    fileCfg: Partial<ConfigOptions>,
    flags: Record<string, string | boolean>,
): Partial<ConfigOptions> {
    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        disableLock: false,
        persistLock: true,   // `cno cache` is the only command that writes cts.lock
    };

    if (flags['silent'] === true) cfg.silent = true;
    if (flags['no-oxc'] === true) cfg.enableOxc = false;
    if (flags['ignore-scripts'] === true) cfg.ignoreScripts = true;

    const npmMode = flags['npm-mode'];
    if (npmMode === 'normal' || npmMode === 'soft' || npmMode === 'hard') {
        cfg.nodeModulesMode = npmMode;
    }

    if (typeof flags['cache-dir'] === 'string') cfg.cacheDir = flags['cache-dir'] as string;
    // No default lockDir: resolveLockTarget() picks the project root (deno.json /
    // package.json), falling back to the cache dir. --lock-dir still overrides.
    if (typeof flags['lock-dir'] === 'string') cfg.lockDir = flags['lock-dir'] as string;

    return cfg;
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

    // package.json dependencies. In Node-style projects package scripts expect
    // devDependencies to be available too, so no-arg cache should prepare them.
    const pkgP = joinPaths(dir, 'package.json');
    if (fs.exists(pkgP)) {
        let pkg: Record<string, any> | null = null;
        try { pkg = JSON.parse(engine.decodeString(fs.readFile(pkgP))); } catch {}
        if (pkg) {
            for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
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
