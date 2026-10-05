import { createRuntime, cwd, loadConfigFile } from '../../cts/src/api';
import { C } from '../help';
import { entryAndDir, hasUrlScheme } from '../utils';
import { CliExit } from '../command-error';
import { buildCacheConfig, collectSpecifiers } from './cache-utils';
import { ensureNodePolyfills } from './setup';
import { effectiveRuntimeFlags, type KernelContext } from '../kernel';

const console = import.meta.use('console');

function isProjectEntry(entry: string): boolean {
    return !hasUrlScheme(entry) || /^file:/i.test(entry);
}

export async function runCache(
    files: string[],
    commandFlags: Record<string, string | boolean>,
    kernel?: KernelContext,
): Promise<void> {
    const flags = kernel ? effectiveRuntimeFlags(kernel, commandFlags) : commandFlags;
    const projectDir = cwd();
    const fileCfg = loadConfigFile(projectDir);
    const cfg = buildCacheConfig(fileCfg, flags, kernel?.config);
    // npm lifecycle scripts (`node postinstall.mjs`) resolve node: against cacheDir/node
    await ensureNodePolyfills(typeof cfg.cacheDir === 'string' ? cfg.cacheDir : undefined);
    const runtime = createRuntime(cfg, projectDir);

    try {
        const entries: string[] = [];
        let hasProjectEntry = false;
        for (const file of files) {
            const { entry } = entryAndDir(file);
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
        // Explicit local entries seed package deps, including dev tools; their
        // graph supplies import-map aliases. No-arg cache includes both sources.
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
