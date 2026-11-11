import { loadConfigFile } from '../../cts/src/config';
import { createRuntime } from '../../cts/src/runtime/index';
import { cwd, dirname, fileUrlToPath, joinPaths } from '../../cts/src/utils/path';
import { C } from '../help';
import { entryAndDir, hasUrlScheme } from '../utils';
import { CliExit } from '../command-error';
import { buildCacheConfig, collectSpecifiers } from './cache-utils';
import { ensureNodePolyfills } from './setup';
import { effectiveRuntimeFlags, type KernelContext } from '../kernel';

const console = import.meta.use('console');
const fs = import.meta.use('fs');

const PROJECT_MANIFESTS = ['deno.json', 'deno.jsonc', 'tsconfig.json', 'package.json'] as const;

function isProjectEntry(entry: string): boolean {
    return !hasUrlScheme(entry) || /^file:/i.test(entry);
}

function localEntryDirectory(entry: string): string | null {
    if (!hasUrlScheme(entry)) return dirname(entry);
    if (!/^file:/i.test(entry)) return null;
    try {
        return dirname(fileUrlToPath(entry));
    } catch {
        return null;
    }
}

/** Nearest project manifest root, if this local entry belongs to one. */
function findProjectDir(start: string): string | null {
    let dir = start;
    for (;;) {
        if (PROJECT_MANIFESTS.some(name => fs.exists(joinPaths(dir, name)))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * A resolver owns one config/import map. Refuse to silently apply the first
 * project's config when one invocation names entries from multiple projects.
 */
function cacheProjectDir(entries: readonly string[], invocationDir: string): string {
    const localDirs = entries
        .map(localEntryDirectory)
        .filter((dir): dir is string => dir !== null);
    if (localDirs.length === 0) return invocationDir;

    const projectDirs = new Set<string>();
    for (const dir of localDirs) {
        const projectDir = findProjectDir(dir);
        if (projectDir) projectDirs.add(projectDir);
    }
    if (projectDirs.size > 1) {
        console.error(`${C.warn('⚠')} Cache entries belong to different project config roots:`);
        for (const dir of projectDirs) console.error(`  ${dir}`);
        console.error('Run cno cache separately for each project.');
        throw new CliExit(1);
    }

    // With no manifest, the entry still owns its resolution context. In
    // particular, do not inherit an unrelated deno.json from the caller cwd.
    return projectDirs.values().next().value ?? localDirs[0]!;
}

export async function runCache(
    files: string[],
    commandFlags: Record<string, string | boolean>,
    kernel?: KernelContext,
): Promise<void> {
    const flags = kernel ? effectiveRuntimeFlags(kernel, commandFlags) : commandFlags;
    const invocationDir = cwd();
    const parsedEntries = files.map(file => entryAndDir(file).entry);
    const projectDir = cacheProjectDir(parsedEntries, invocationDir);
    const fileCfg = loadConfigFile(projectDir);
    const cfg = buildCacheConfig(fileCfg, flags, kernel?.config);
    // npm lifecycle scripts (`node postinstall.mjs`) resolve node: against cacheDir/node
    await ensureNodePolyfills(typeof cfg.cacheDir === 'string' ? cfg.cacheDir : undefined);
    const runtime = createRuntime(cfg, projectDir);

    try {
        const entries: string[] = [];
        let hasProjectEntry = false;
        for (const entry of parsedEntries) {
            try {
                runtime.resolver.resolve(entry, `${projectDir}/<cache-cmd>`);
                entries.push(entry);
                if (isProjectEntry(entry)) hasProjectEntry = true;
            } catch (e) {
                console.error(`${C.warn('⚠')} Cannot resolve entry: ${entry}`);
                console.error(`  ${(e instanceof Error ? e.message : String(e))}`);
                throw new CliExit(1);
            }
        }
        // Local entries seed package deps (incl. dev tools) for import-map aliases.
        if (files.length === 0 || hasProjectEntry) {
            entries.push(...collectSpecifiers(projectDir, { denoImports: files.length === 0 }));
        }
        if (entries.length === 0) {
            console.error(`${C.warn('⚠')} No imports in deno.json or dependencies in package.json`);
            throw new CliExit(1);
        }
        await runtime.precacheFromSpecifiers(entries, projectDir);
        console.log(`${C.green('✔')} ${runtime.resolver.lockSize} modules cached`);
        console.log(`  ${C.dim('Lock:')} ${runtime.resolver.lockPath}`);
    } finally {
        runtime.cleanup();
    }
}

export { buildCacheConfig, collectSpecifiers } from './cache-utils';
