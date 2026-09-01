import { createRuntime, cwd, loadConfigFile, writePack, basename, extname, dirname, joinPaths, resolvePath, isAbsolute, fmtBytes, summarizePackSizes } from '../../cts/src/api';
import type { PackManifest } from '../../cts/src/api';
import { C } from '../help';
import { entryAndDir } from '../utils';
import { CliExit } from '../command-error';
import { buildCacheConfig } from './cache-utils';

const console = import.meta.use('console');
const fs = import.meta.use('fs');

/** Languages the transformer understands for an explicit `--ext`. */
const PACK_LANGS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

function isExistingDirectory(path: string): boolean {
    try {
        return fs.stat(path).isDirectory;
    } catch {
        return false;
    }
}

function defaultOutPath(entry: string, dir: string): string {
    const colon = entry.indexOf(':');
    const hasProtocol = colon >= 2 && /^[a-z][a-z0-9+.-]*$/i.test(entry.slice(0, colon));
    const scheme = hasProtocol ? entry.slice(0, colon).toLowerCase() : '';
    let candidate = entry;
    if (scheme === 'data' || scheme === 'blob' || scheme === 'node') {
        candidate = `${scheme}-module`;
    } else if (hasProtocol) {
        candidate = entry.slice(colon + 1);
    }
    const suffix = candidate.search(/[?#]/);
    if (suffix !== -1) candidate = candidate.slice(0, suffix);
    const base = basename(candidate);
    const rawStem = basename(base, extname(base)) || 'app';
    let stem = '';
    for (let i = 0; i < rawStem.length; i++) {
        const ch = rawStem[i]!;
        const code = ch.charCodeAt(0);
        stem += code < 32 || '<>:"/\\|?*'.includes(ch) ? '-' : ch;
    }
    stem = stem.replace(/[. ]+$/, '') || 'app';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
    return `${dir}/${stem}.jspack`;
}

export async function runPack(files: string[], flags: Record<string, string | boolean>): Promise<void> {
    if (flags['help'] === true || flags['h'] === true) {
        showPackHelp();
        return;
    }
    if (files.length !== 1) {
        console.error(`Usage: ${C.cyan('cno pack')} ${C.cyan('<entry>')} [-o out.jspack]`);
        if (files.length > 1) console.error('Pack accepts exactly one entry file.');
        throw new CliExit(1);
    }
    const file = files[0]!;
    if (flags['out'] === true || flags['out'] === '') {
        console.error(`${C.warn('⚠')} Pack failed: -o/--out requires a file path`);
        throw new CliExit(1);
    }

    const outputDir = cwd();
    const { entry, dir: entryDir } = entryAndDir(file);
    const projectDir = findProjectDir(entryDir);
    const fileCfg = loadConfigFile(projectDir);
    const cfg = buildCacheConfig(fileCfg, flags);
    // Packing may populate the shared dependency cache, but only `cno cache`
    // owns persistent lock updates and lifecycle-script execution.
    cfg.persistLock = false;
    cfg.ignoreScripts = true;

    const outPath = typeof flags['out'] === 'string' ? flags['out'] : defaultOutPath(entry, outputDir);
    const remoteEntry = !isAbsolute(entry) && /^[a-z][a-z0-9+.-]*:/i.test(entry);
    if (!remoteEntry && resolvePath(outPath) === resolvePath(entry)) {
        console.error(`${C.warn('⚠')} Pack failed: output path must not overwrite the entry source`);
        throw new CliExit(1);
    }
    if (extname(outPath).toLowerCase() !== '.jspack') {
        console.error(`${C.warn('⚠')} Pack failed: output path must end with .jspack`);
        throw new CliExit(1);
    }
    // Reject directories before entering writePack's file-replacement path.
    if (isExistingDirectory(outPath)) {
        console.error(`${C.warn('⚠')} Pack failed: output path is a directory`);
        throw new CliExit(1);
    }

    const explicitExtValue = typeof flags['ext'] === 'string'
        ? (flags['ext'].startsWith('.') ? flags['ext'].slice(1) : flags['ext'])
        : undefined;
    const explicitExt = explicitExtValue || undefined;
    // An unknown language silently becomes "no transform" and is recorded in the
    // manifest, so the ABI-mismatch recompile would mis-parse the entry.
    if (explicitExt !== undefined && !PACK_LANGS.has(explicitExt.toLowerCase())) {
        console.error(`${C.warn('⚠')} Pack failed: --ext must be one of ${[...PACK_LANGS].join(', ')}`);
        throw new CliExit(1);
    }
    const entryLang = explicitExt ?? (extname(entry) === '' ? 'ts' : undefined);
    const runtime = createRuntime(cfg, projectDir);
    try {
        const manifest = await writePack(runtime, entry, projectDir, outPath, { entryLang });
        if (flags['silent'] !== true) {
            const size = fs.stat(outPath).size;
            console.log(`${C.green('✔')} Packed ${Object.keys(manifest.modules).length} modules (${fmtBytes(size)})`);
            console.log(`  ${C.dim('Out:')} ${resolvePath(outPath)}`);
            printSizeBreakdown(manifest);
        }
    } catch (e) {
        console.error(`${C.warn('⚠')} Pack failed: ${e instanceof Error ? e.message : String(e)}`);
        throw new CliExit(1);
    } finally {
        runtime.cleanup();
    }
}

/** Print packed size share from unique blob ranges (workspace / npm / jsr / …). */
function printSizeBreakdown(manifest: PackManifest): void {
    const { total, rows } = summarizePackSizes(manifest);
    if (total <= 0 || rows.length === 0) return;

    const labelW = Math.min(40, Math.max(...rows.map(r => r.name.length), 9));
    console.log(`  ${C.dim('Size:')}`);
    for (const { name, bytes } of rows) {
        const pct = ((bytes / total) * 100).toFixed(1);
        const label = name.length > labelW ? `${name.slice(0, labelW - 1)}…` : name.padEnd(labelW);
        console.log(`    ${label}  ${fmtBytes(bytes).padStart(8)}  ${pct.padStart(5)}%`);
    }
}

function showPackHelp(): void {
    console.log(`
${C.bold('USAGE')}
  ${C.cyan('cno pack')} ${C.cyan('<entry>')} [${C.cyan('-o')} ${C.dim('<file.jspack>')}]

${C.bold('OPTIONS')}
  ${C.cyan('-o')}, ${C.cyan('--out')} ${C.dim('<path>')}      Output path (default: <entry>.jspack in the current directory)
  ${C.cyan('--cached-only')}             Refuse dependency downloads
  ${C.cyan('--cache-dir')} ${C.dim('<path>')}         Override the CTS dependency cache
  ${C.cyan('--ext')} ${C.dim('<ts|js|tsx|jsx>')}       Language for an extensionless entry (default: ts)
  ${C.cyan('--no-oxc')}                  Disable OXC acceleration
  ${C.cyan('--silent')}, ${C.cyan('-q')}              Suppress progress and success output

Only statically discoverable module edges are included. A computed import that
is absent from the manifest fails at runtime instead of reading the source tree.
    `.trim());
}

function findProjectDir(start: string): string {
    let dir = start;
    for (;;) {
        for (const name of ['deno.json', 'deno.jsonc', 'tsconfig.json', 'package.json']) {
            if (fs.exists(joinPaths(dir, name))) return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) return start;
        dir = parent;
    }
}
