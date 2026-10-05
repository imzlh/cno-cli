import { createRuntime, loadConfigFile, formatError, extname, resolveFile, BinResolver, errMsg, log, loadPack } from '../../cts/src/api';
import type { ConfigOptions, ModuleFormat } from '../../cts/src/api';
import { dispatchLoadEvent } from '../../cts/src/runtime/event-mux';
import { entryAndDir, entryUrl, hasUrlScheme, sourceExtension } from '../utils';
import { CliCommandError } from '../command-error';
import type { Args } from '../../cno/src/utils/args';
import { flagsToConfig } from '../config';
import { applyLocationFlag, effectiveRuntimeFlags, openKernelRuntime, type KernelContext, type KernelRuntime } from '../kernel';

const os = import.meta.use('os');
const console = import.meta.use('console');
const engine = import.meta.use('engine');
const streams = import.meta.use('streams');
const fs = import.meta.use('fs');

interface RunOpts {
    file: string;
    args: string[];
    flags: Record<string, string | boolean>;
    rawArgs: Args;
    kernel: KernelContext;
    config?: Partial<ConfigOptions>;
    /** When false, import.meta.main stays false (Deno.test modules). Default true. */
    asMain?: boolean;
    /** Called after the entry has evaluated, while its module namespace is live. */
    onEvaluated?: (namespace: Record<string, unknown>) => void | Promise<void>;
}

function isJspackFile(entry: string): boolean {
    return extname(entry).toLowerCase() === '.jspack';
}

function shouldLoadSourceEntry(entry: string, explicitExt: string | undefined): boolean {
    if (explicitExt !== undefined) return true;
    // Extensionless local files default to TypeScript; URL-like entries use the
    // normal module loader.
    if (hasUrlScheme(entry)) return false;
    return extname(entry) === '';
}

function readEntrySource(entry: string): string {
    return engine.decodeString(fs.readFile(resolveFile(entry)));
}

interface NpmRunSpec {
    root: string;
    hasSubpath: boolean;
}

function parseNpmRunSpec(spec: string): NpmRunSpec | null {
    if (!spec.startsWith('npm:')) return null;
    let rest = spec.slice(4);
    while (rest.startsWith('/')) rest = rest.slice(1);
    if (!rest) return null;

    if (rest.startsWith('@')) {
        const scopeSlash = rest.indexOf('/');
        if (scopeSlash <= 1) return null;
        const scope = rest.slice(0, scopeSlash);
        const tail = rest.slice(scopeSlash + 1);
        const versionAt = tail.indexOf('@');
        const subSlash = tail.indexOf('/');
        if (versionAt !== -1 && (subSlash === -1 || versionAt < subSlash)) {
            const pkg = tail.slice(0, versionAt);
            const after = tail.slice(versionAt + 1);
            const versionSlash = after.indexOf('/');
            const version = versionSlash === -1 ? after : after.slice(0, versionSlash);
            return { root: `npm:${scope}/${pkg}@${version}`, hasSubpath: versionSlash !== -1 };
        }
        if (subSlash !== -1) return { root: `npm:${scope}/${tail.slice(0, subSlash)}`, hasSubpath: true };
        return { root: `npm:${scope}/${tail}`, hasSubpath: false };
    }

    const versionAt = rest.indexOf('@');
    const subSlash = rest.indexOf('/');
    if (versionAt !== -1 && (subSlash === -1 || versionAt < subSlash)) {
        const pkg = rest.slice(0, versionAt);
        const after = rest.slice(versionAt + 1);
        const versionSlash = after.indexOf('/');
        const version = versionSlash === -1 ? after : after.slice(0, versionSlash);
        return { root: `npm:${pkg}@${version}`, hasSubpath: versionSlash !== -1 };
    }
    if (subSlash !== -1) return { root: `npm:${rest.slice(0, subSlash)}`, hasSubpath: true };
    return { root: `npm:${rest}`, hasSubpath: false };
}

function resolveNpmRunEntry(runtime: ReturnType<typeof createRuntime>, entry: string, dir: string): { entry: string; npmBin: boolean } {
    const parsed = parseNpmRunSpec(entry);
    if (!parsed) return { entry, npmBin: false };

    try {
        runtime.resolver.resolve(parsed.root, `${dir}/<npm-run>`);
    } catch (e) {
        if (!parsed.hasSubpath) throw e;
        log.debug('run', () => `npm root pre-resolve failed for ${parsed.root}: ${errMsg(e)}`);
    }

    const resolved = new BinResolver(runtime.resolver.lockStore, { cacheDir: runtime.config.cacheDir }).resolve(entry, dir);
    if (resolved) return { entry: resolved.entry, npmBin: true };
    if (parsed.hasSubpath) return { entry, npmBin: false };
    throw new Error(`npm package has no bin entrypoint: ${entry}`);
}

async function readStdinSource(): Promise<string> {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(64 * 1024);
    for (;;) {
        const n = await streams.stdin.read(buf);
        if (n === null || n === 0) break;
        chunks.push(buf.slice(0, n));
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return engine.decodeString(all);
}

function isInternalWorkerClose(value: unknown): boolean {
    return (typeof value === 'object' || typeof value === 'function')
        && value !== null
        && Reflect.get(value, '__cno_worker_close') === true;
}

export async function runFile(opts: RunOpts): Promise<void> {
    const isStdin = opts.file === '-';
    const flags = effectiveRuntimeFlags(opts.kernel, opts.flags);
    const explicitExt = sourceExtension(flags.ext);
    const sourceLang = explicitExt ?? 'ts';
    applyLocationFlag(flags);
    let { entry, dir } = isStdin
        ? { entry: `${os.cwd}/$deno$stdin.${sourceLang}`, dir: os.cwd }
        : entryAndDir(opts.file);
    // Symlinked bins (node_modules/.bin → store) need realpath so relative
    // requires resolve inside the package, not under .bin/.
    if (!isStdin) {
        try {
            if (fs.exists(entry)) {
                const real = fs.realpath(entry);
                if (real && real !== entry) {
                    entry = real;
                    dir = entryAndDir(entry).dir;
                }
            }
        } catch { /* keep original entry */ }
    }
    const isPack = !isStdin && isJspackFile(entry);
    // Packs contain their own graph and must not inherit project settings.
    const fileCfg = isPack ? {} : loadConfigFile(dir);
    const cliCfg  = flagsToConfig(flags);
    cliCfg.ignoreScripts = true;

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...opts.config,
        ...opts.kernel.config,
        ...cliCfg,
    };
    // Packs have no project lockfile to update.
    if (isPack) cfg.disableLock = true;

    let session: KernelRuntime | undefined;
    try {
        session = await openKernelRuntime(opts.kernel, entry, cfg, dir);
        const { runtime } = session;
        await session.initialize(opts.rawArgs);
        if (!isPack && (flags['precache'] || flags['reload'])) {
            try {
                const info = runtime.resolver.resolve(entry, `${os.cwd}/<precache>`);
                await runtime.precache(info.specPath, info.localPath);
            } catch (e) {
                console.error(formatError(e, 'pre-caching'));
            }
        }

        const asMain = opts.asMain !== false;
        let mod: Awaited<ReturnType<typeof runtime.loadEntry>>;
        if (isPack) {
            const packStarted = Date.now();
            const { manifest } = loadPack(entry, runtime.resolver);
            const preparedAt = Date.now();
            Reflect.set(globalThis, '__mainScript', entryUrl(manifest.entry));
            mod = asMain
                ? await runtime.loadEntry(manifest.entry, {}, manifest.modules[manifest.entry]?.lang ?? '')
                : await runtime.loadModule(manifest.entry, {}, manifest.modules[manifest.entry]?.lang ?? '');
            log.debug('pack', () => `prepare=${preparedAt - packStarted}ms link=${Date.now() - preparedAt}ms`);
        } else {
            Reflect.set(globalThis, '__mainScript', entryUrl(entry));
            const resolved = isStdin ? { entry, npmBin: false } : resolveNpmRunEntry(runtime, entry, dir);
            const runEntry = resolved.entry;
            const entryLang = explicitExt ?? '';
            const npmBinSourceEntry = resolved.npmBin && extname(runEntry) === '';
            const sourceOpts: { lang: string; format?: ModuleFormat; main?: boolean } = npmBinSourceEntry
                ? { lang: 'js', format: 'cjs' }
                : { lang: sourceLang };
            if (!asMain) sourceOpts.main = false;
            const useSourceEntry = isStdin || npmBinSourceEntry || (!resolved.npmBin && shouldLoadSourceEntry(runEntry, explicitExt));
            mod = isStdin
                ? runtime.loadSourceEntry(await readStdinSource(), entry, {}, { lang: sourceLang, main: asMain })
                : useSourceEntry
                ? runtime.loadSourceEntry(readEntrySource(runEntry), runEntry, {}, sourceOpts)
                : asMain
                ? await runtime.loadEntry(runEntry, {}, entryLang)
                : await runtime.loadModule(runEntry, {}, entryLang);
        }
        const evalStarted = Date.now();
        // evalTracked, not mod.eval(): brackets the entry's evaluation so a
        // self-require() throws ERR_REQUIRE_CYCLE_MODULE instead of aborting the
        // process. See ModuleCompiler.evalTracked.
        await runtime.compiler.evalTracked(mod);
        if (isPack) log.debug('pack', () => `eval=${Date.now() - evalStarted}ms`);
        // Native EV_LOAD covers the C bootstrap rather than the user entry.
        // Dispatch after successful evaluation; this is idempotent for cno test.
        await opts.onEvaluated?.(mod.namespace);
        dispatchLoadEvent();
        runtime.flushLock();
    } catch (e) {
        if (isInternalWorkerClose(e)) throw e;
        if (e instanceof CliCommandError) throw e;
        throw new CliCommandError(e, entry);
    } finally {
        // Once the entry has settled, the inspector alone must not pin the loop.
        session?.finish();
    }
}
