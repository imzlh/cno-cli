import { createRuntime, cwd, loadConfigFile } from '../../cts/src/api';
import { C } from '../help';
import { entryAndDir } from '../utils';
import { buildCacheConfig, collectSpecifiers } from './cache-utils';

const os = import.meta.use('os');
const console = import.meta.use('console');

function isProjectEntry(entry: string): boolean {
    const colon = entry.indexOf(':');
    if (colon < 2 || colon > 8) return true;
    const proto = entry.slice(0, colon);
    for (let i = 0; i < proto.length; i++) {
        const c = proto.charCodeAt(i);
        if (c < 97 || c > 122) return true;
    }
    return proto === 'file';
}

export async function runCache(files: string[], flags: Record<string, string | boolean>): Promise<void> {
    if (files.length === 0) {
        await runCacheNoArgs(flags);
        return;
    }
    const projectDir = cwd();
    const fileCfg = loadConfigFile(projectDir);
    const cfg = buildCacheConfig(fileCfg, flags);
    const runtime = createRuntime(cfg, projectDir);

    const entries: string[] = [];
    let hasProjectEntry = false;
    for (const file of files) {
        const { entry } = entryAndDir(file);
        try {
            runtime.resolver.resolve(entry, `${os.cwd}/<cache-cmd>`);
            entries.push(entry);
            if (isProjectEntry(entry)) hasProjectEntry = true;
        } catch (e) {
            console.error(`${C.warn('⚠')} Cannot resolve entry: ${entry}`);
            console.error(`  ${(e instanceof Error ? e.message : String(e))}`);
            os.exit(1);
            return;
        }
    }
    // Also seed package.json declared deps (including devDependencies) —
    // dev-tool bins invoked later by `cno task` (e.g. a "dev" script) aren't reachable
    // from the entry file's static import graph, so they'd never get precached otherwise.
    // deno.json imports are import-map aliases; reachable aliases are handled by the
    // entry scan, while unrelated aliases often belong to tests or optional tooling.
    const extra = hasProjectEntry ? collectSpecifiers(projectDir, { denoImports: false }) : [];
    await runtime.precacheFromSpecifiers([...entries, ...extra], projectDir);
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

export { buildCacheConfig, collectSpecifiers } from './cache-utils';
