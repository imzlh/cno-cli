import { createRuntime, loadConfigFile, formatError, extname, resolveFile, BinResolver, errMsg, log, loadPack, toFileUrl, hasSchemeId } from '../../cts/src/api';
import type { ConfigOptions, ModuleFormat } from '../../cts/src/api';
import { dispatchLoadEvent } from '../../cts/src/runtime/event-mux';
import { entryAndDir } from '../utils';
import { CliCommandError } from '../command-error';
import { loadEnvFiles } from './env-file';
import { Inspector } from '../inspector';
import { parseInspectFlags } from './inspect';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import setArgs, { type Args } from '../../cno/src/utils/args';
import { flagsToConfig, publishWorkerRuntimeConfig } from './config-flags';

export { flagsToConfig } from './config-flags';

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
    /** When false, import.meta.main stays false (Deno.test modules). Default true. */
    asMain?: boolean;
    /** Called after the entry has evaluated, while its module namespace is live. */
    onEvaluated?: (namespace: Record<string, unknown>) => void | Promise<void>;
}

function isJspackFile(entry: string): boolean {
    return extname(entry).toLowerCase() === '.jspack';
}

export function entryUrl(entry: string): string {
    if (hasUrlScheme(entry)) return entry;
    return toFileUrl(entry);
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

/** True for URL schemes, excluding one-letter Windows drive prefixes. */
function hasUrlScheme(entry: string): boolean {
    return hasSchemeId(entry) && !entry.startsWith('/');
}

function shouldLoadSourceEntry(entry: string, flags: Record<string, string | boolean>): boolean {
    if (hasExplicitExt(flags)) return true;
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

/** Match Node's NODE_OPTIONS grammar: spaces split, double quotes group, and
 * backslashes escape only within quoted strings. */
function splitNodeOptions(value: string | undefined): string[] {
    if (!value) return [];
    const out: string[] = [];
    let current = '';
    let inString = false;
    let escaped = false;
    let started = false;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i]!;
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            started = true;
            continue;
        }
        if (inString) {
            if (ch === '\\') escaped = true;
            else current += ch;
            continue;
        }
        if (ch === ' ') {
            // A quoted empty argument ("" ) is still an argument.
            if (current || started) {
                out.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += ch;
    }
    if (escaped) {
        throw new Error('invalid value for NODE_OPTIONS (invalid escape)');
    }
    if (inString) {
        throw new Error('invalid value for NODE_OPTIONS (unterminated string)');
    }
    if (current || started) out.push(current);
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
        // Bracketed like the entry eval — a preload module is an entry too, and a
        // self-require() from one would abort the process. See evalTracked.
        await runtime.compiler.evalTracked(await runtime.loadModule(specifier, { preload: true }));
    }
}

async function runNodePreloads(runtime: ReturnType<typeof createRuntime>, execArgv: string[]): Promise<void> {
    for (const preload of collectNodePreloads(execArgv)) {
        if (preload.kind === 'require') {
            const process = Reflect.get(globalThis, 'process') as { getBuiltinModule?: (id: string) => unknown } | undefined;
            const nodeModule = process?.getBuiltinModule?.('node:module') as NodeModulePreloader | undefined;
            if (!nodeModule?._preloadModules) throw new Error('node:module preload support is unavailable');
            nodeModule._preloadModules([preload.specifier]);
            continue;
        }
        if (preload.kind === 'import') {
            await runtime.compiler.evalTracked(
                await runtime.loadEntry(preload.specifier, { nodePreload: true }, ''),
            );
            continue;
        }
        // Loader hooks are not implemented; warn rather than silently ignoring
        // a flag that can change module resolution.
        console.error(
            `cno: warning: --loader=${preload.specifier} is not supported `
            + '(ESM loader hooks are unimplemented); the hook will NOT run',
        );
    }
}

export function applyLocationFlag(flags: Record<string, string | boolean>): void {
    // specs/run/_070_location: --location=URL configures globalThis.location via CNO_LOCATION.
    const loc = flags['location'];
    if (typeof loc === 'string' && loc.length > 0) {
        try { os.setenv('CNO_LOCATION', loc); } catch { /* */ }
        // Polyfill may already be loaded; re-apply if helper is present.
        try {
            const apply = Reflect.get(globalThis, '__cno_applyLocation');
            if (typeof apply === 'function') apply(loc);
        } catch { /* */ }
    }
}

export async function runFile(opts: RunOpts): Promise<void> {
    const isStdin = opts.file === '-';
    loadEnvFiles(collectValueFlags(opts.rawArgs.actionArgs, new Set(['env', 'env-file'])), (msg) => console.error(`Warning ${msg}`));
    // Env files may define NODE_OPTIONS. Validate it immediately after loading
    // them, before location/preload/runtime startup can cause side effects.
    const execArgv = nodeExecArgv(opts.rawArgs.internalArgs);
    applyLocationFlag(opts.flags);
    let { entry, dir } = isStdin
        ? { entry: `${os.cwd}/$deno$stdin.${sourceLangFromFlags(opts.flags)}`, dir: os.cwd }
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
    const cliCfg  = flagsToConfig(opts.flags, execArgv);
    cliCfg.ignoreScripts = true;

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...opts.config,
        ...cliCfg,
    };
    // Packs have no project lockfile to update.
    if (isPack) cfg.disableLock = true;

    // CDP debug session MUST attach before createRuntime so our engine.onModule
    // wrapper is in place before CTS's hookEngine() installs its handler.
    const inspect = parseInspectFlags(opts.flags);
    let dbg: Inspector | null = null;
    let bridgeInstalled = false;
    try {
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
        bridgeInstalled = true;

        // Wire up CDP scriptParsed hook (installed by DebugSession.attach)
        if (dbg?.scriptInitHook) {
            runtime.addInitHook(dbg.scriptInitHook);
        }

        // Load a configured polyfill before user code; continuing after failure
        // would ignore the requested runtime environment.
        if (runtime.config.polyfill) {
            try {
                await runtime.loadPolyfill(runtime.config.polyfill);
            } catch (e) {
                throw new CliCommandError(e, `loading polyfill ${runtime.config.polyfill}`);
            }
        }

        if (!isPack && (opts.flags['precache'] || opts.flags['reload'])) {
            try {
                const info = runtime.resolver.resolve(entry, `${os.cwd}/<precache>`);
                await runtime.precache(info.specPath, info.localPath);
            } catch (e) {
                console.error(formatError(e, 'pre-caching'));
            }
        }

        publishWorkerRuntimeConfig(runtime.config);
        setArgs(opts.rawArgs);
        await runDenoPreloads(runtime, opts.rawArgs.actionArgs);
        await runNodePreloads(runtime, execArgv);
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
            const sourceLang = sourceLangFromFlags(opts.flags);
            const entryLang = entryLangFromFlags(opts.flags);
            const npmBinSourceEntry = resolved.npmBin && extname(runEntry) === '';
            const sourceOpts: { lang: string; format?: ModuleFormat; main?: boolean } = npmBinSourceEntry
                ? { lang: 'js', format: 'cjs' }
                : { lang: sourceLang };
            if (!asMain) sourceOpts.main = false;
            const useSourceEntry = isStdin || npmBinSourceEntry || (!resolved.npmBin && shouldLoadSourceEntry(runEntry, opts.flags));
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
        dbg?.allowProcessExit();
        if (bridgeInstalled) uninstallInspectorBridge();
    }
}
