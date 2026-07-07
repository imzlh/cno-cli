import { createRuntime, loadConfigFile, fatal, formatError, extname, BinResolver, errMsg, log } from '../../cts/src/api';
import type { ConfigOptions, ModuleFormat } from '../../cts/src/api';
import { entryAndDir } from '../utils';
import { Inspector } from '../inspector';
import { parseInspectFlags } from './inspect';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import setArgs, { type Args } from '../../cno/src/utils/args';
import { loadEnvFiles } from '../../cno/src/node/_internal/envfile';
import { applyNodeOptionConfig } from './node-options';

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
    config?: Partial<ConfigOptions>;
}

function entryUrl(entry: string): string {
    if (/^[a-z][a-z0-9+\-.]*:/i.test(entry) && !entry.startsWith('/')) return entry;
    const normalized = entry.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
    return normalized.startsWith('/') ? `file://${normalized}` : normalized;
}

function flagsToConfig(flags: Record<string, string | boolean>): Partial<ConfigOptions> {
    const c: Partial<ConfigOptions> = {};
    const s = (k: string) => typeof flags[k] === 'string' ? flags[k] : undefined;
    const b = (k: string) => flags[k] === true || flags[k] === 'true' ? true : undefined;
    if (s('cache-dir'))     c.cacheDir = s('cache-dir');
    if (b('no-lock'))       c.disableLock = true;
    if (b('frozen'))        c.frozen = true;
    if (s('lock-dir'))      c.lockDir = s('lock-dir');
    if (b('no-http'))       c.enableHttp = false;
    if (b('no-jsr'))        c.enableJsr = false;
    if (b('no-node'))       c.enableNode = false;
    if (b('no-oxc')) c.enableOxc = false;
    if (b('silent'))        c.silent = true;
    if (b('disable-cache')) c.enableCache = false;
    if (b('cached-only')) c.cachedOnly = true;
    if (s('polyfill'))      c.polyfill = s('polyfill');
    applyNodeOptionConfig(c, flags);
    // Deferred npm lifecycle scripts only run during `cno cache`, never during `cno run`.
    c.ignoreScripts = true;
    return c;
}

function publishWorkerRuntimeConfig(cfg: Partial<ConfigOptions>): void {
    Reflect.set(globalThis, '__cno_worker_runtime_config', {
        cacheDir: cfg.cacheDir,
        lockDir: cfg.lockDir,
        enableHttp: cfg.enableHttp,
        enableJsr: cfg.enableJsr,
        enableNode: cfg.enableNode,
        enableCache: cfg.enableCache,
        cachedOnly: cfg.cachedOnly,
        enableOxc: cfg.enableOxc,
        frozen: cfg.frozen,
        disableLock: cfg.disableLock,
        ignoreScripts: cfg.ignoreScripts,
        polyfill: cfg.polyfill,
        conditions: cfg.conditions,
        importMap: cfg.importMap,
        pathAliases: cfg.pathAliases,
        baseUrl: cfg.baseUrl,
    });
}

function explicitExtFromFlags(flags: Record<string, string | boolean>): string | null {
    const ext = flags.ext;
    if (typeof ext !== 'string' || ext.length === 0) return null;
    return ext.startsWith('.') ? ext.slice(1) : ext;
}

function sourceLangFromFlags(flags: Record<string, string | boolean>): string {
    return explicitExtFromFlags(flags) ?? 'ts';
}

function entryLangFromFlags(flags: Record<string, string | boolean>): string {
    return explicitExtFromFlags(flags) ?? '';
}

function hasExplicitExt(flags: Record<string, string | boolean>): boolean {
    return explicitExtFromFlags(flags) !== null;
}

function shouldLoadSourceEntry(entry: string, flags: Record<string, string | boolean>): boolean {
    if (hasExplicitExt(flags)) return true;
    if (/^[a-z][a-z0-9+\-.]*:/i.test(entry) && !entry.startsWith('/')) return false;
    return extname(entry) === '';
}

function readEntrySource(entry: string): string {
    return engine.decodeString(fs.readFile(entry));
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

type NodePreload = { kind: 'require' | 'import' | 'loader'; specifier: string };
type NodeModulePreloader = { _preloadModules(requests: string[]): void };

function collectValueFlags(tokens: string[], names: Set<string>): string[] {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === undefined || !token.startsWith('--')) continue;
        const eq = token.indexOf('=');
        const name = token.slice(2, eq === -1 ? undefined : eq);
        if (!names.has(name)) continue;
        if (eq !== -1) {
            out.push(token.slice(eq + 1));
            continue;
        }
        const value = tokens[i + 1];
        if (value !== undefined) {
            out.push(value);
            i++;
        }
    }
    return out;
}

function envValue(name: string): string | undefined {
    try {
        return os.getenv(name) ?? undefined;
    } catch {
        return undefined;
    }
}

function isInternalWorkerClose(value: unknown): boolean {
    return (typeof value === 'object' || typeof value === 'function')
        && value !== null
        && Reflect.get(value, '__cno_worker_close') === true;
}

function splitNodeOptions(value: string | undefined): string[] {
    if (!value) return [];
    const out: string[] = [];
    let current = '';
    let quote = '';
    let escaped = false;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i]!;
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = '';
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (current) {
                out.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current) out.push(current);
    return out;
}

function nodeExecArgv(execArgv: string[]): string[] {
    const fromEnv = splitNodeOptions(envValue('NODE_OPTIONS'));
    if (fromEnv.length === 0) return execArgv;
    return [...fromEnv, ...execArgv];
}

function collectNodePreloads(execArgv: string[]): NodePreload[] {
    const out: NodePreload[] = [];
    for (let i = 0; i < execArgv.length; i++) {
        const token = execArgv[i];
        if (token === '--require' || token === '-r' || token === '--import' || token === '--loader') {
            const specifier = execArgv[i + 1];
            if (specifier !== undefined) {
                out.push({
                    kind: token === '--import' ? 'import' : token === '--loader' ? 'loader' : 'require',
                    specifier,
                });
                i++;
            }
            continue;
        }
        for (const kind of ['require', 'import', 'loader'] as const) {
            const prefix = `--${kind}=`;
            if (token.startsWith(prefix)) out.push({ kind, specifier: token.slice(prefix.length) });
        }
    }
    return out;
}

async function runDenoPreloads(runtime: ReturnType<typeof createRuntime>, actionArgs: string[]): Promise<void> {
    const preloads = collectValueFlags(actionArgs, new Set(['preload']));
    for (const specifier of preloads) {
        await (await runtime.loadModule(specifier, { preload: true })).eval();
    }
}

async function runNodePreloads(runtime: ReturnType<typeof createRuntime>, execArgv: string[]): Promise<void> {
    for (const preload of collectNodePreloads(nodeExecArgv(execArgv))) {
        if (preload.kind === 'require') {
            const process = Reflect.get(globalThis, 'process') as { getBuiltinModule?: (id: string) => unknown } | undefined;
            const nodeModule = process?.getBuiltinModule?.('node:module') as NodeModulePreloader | undefined;
            if (!nodeModule?._preloadModules) throw new Error('node:module preload support is unavailable');
            nodeModule._preloadModules([preload.specifier]);
            continue;
        }
        if (preload.kind === 'import') {
            await (await runtime.loadEntry(preload.specifier, { nodePreload: true }, '')).eval();
        }
    }
}

export async function runFile(opts: RunOpts): Promise<void> {
    const isStdin = opts.file === '-';
    loadEnvFiles(collectValueFlags(opts.rawArgs.actionArgs, new Set(['env', 'env-file'])), (msg) => console.error(`Warning ${msg}`));
    const { entry, dir } = isStdin
        ? { entry: `${os.cwd}/$deno$stdin.${sourceLangFromFlags(opts.flags)}`, dir: os.cwd }
        : entryAndDir(opts.file);
    const fileCfg = loadConfigFile(dir);
    const cliCfg  = flagsToConfig(opts.flags);

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...opts.config,
        ...cliCfg,
    };

    // CDP debug session MUST attach before createRuntime so our engine.onModule
    // wrapper is in place before CTS's hookEngine() installs its handler.
    const inspect = parseInspectFlags(opts.flags);
    let dbg: Inspector | null = null;
    if (inspect) {
        dbg = new Inspector({
            port:          inspect.port,
            host:          inspect.host,
            entryFile:     entry,
            breakOnStart:  inspect.breakOnStart,
            waitForClient: inspect.waitForClient,
        });

		await dbg.attach();
	}

    const runtime = createRuntime(cfg, dir);
    installInspectorBridge({
        entryFile: entry,
        addInitHook: (hook) => runtime.addInitHook(hook),
        getCurrentInspector: () => dbg,
        setCurrentInspector: (inspector) => { dbg = inspector; },
    });

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

    try {
        publishWorkerRuntimeConfig(runtime.config);
        setArgs(opts.rawArgs);
        await runDenoPreloads(runtime, opts.rawArgs.actionArgs);
        await runNodePreloads(runtime, opts.rawArgs.internalArgs);
        Reflect.set(globalThis, '__mainScript', entryUrl(entry));
        const resolved = isStdin ? { entry, npmBin: false } : resolveNpmRunEntry(runtime, entry, dir);
        const runEntry = resolved.entry;
        const sourceLang = sourceLangFromFlags(opts.flags);
        const entryLang = entryLangFromFlags(opts.flags);
        const npmBinSourceEntry = resolved.npmBin && extname(runEntry) === '';
        const sourceOpts: { lang: string; format?: ModuleFormat } = npmBinSourceEntry
            ? { lang: 'js', format: 'cjs' }
            : { lang: sourceLang };
        const useSourceEntry = isStdin || npmBinSourceEntry || (!resolved.npmBin && shouldLoadSourceEntry(runEntry, opts.flags));
        const mod = isStdin
            ? runtime.loadSourceEntry(await readStdinSource(), entry, {}, { lang: sourceLang })
            : useSourceEntry
            ? runtime.loadSourceEntry(readEntrySource(runEntry), runEntry, {}, sourceOpts)
            : await runtime.loadEntry(runEntry, {}, entryLang);
        await mod.eval();
    } catch (e) {
        if (isInternalWorkerClose(e)) throw e;
        fatal(e, entry);
    } finally {
        uninstallInspectorBridge();
    }

    runtime.flushLock();
}
