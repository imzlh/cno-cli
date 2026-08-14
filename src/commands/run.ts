import { createRuntime, loadConfigFile, fatal, formatError, extname, resolveFile, BinResolver, errMsg, log, loadPack, parseSize } from '../../cts/src/api';
import type { ConfigOptions, ModuleFormat } from '../../cts/src/api';
import { dispatchLoadEvent } from '../../cts/src/runtime/event-mux';
import { entryAndDir } from '../utils';
import { Inspector } from '../inspector';
import { parseInspectFlags } from './inspect';
import { installInspectorBridge, uninstallInspectorBridge } from '../inspector/bridge';
import setArgs, { type Args } from '../../cno/src/utils/args';
import { loadEnvFiles } from '../../cno/src/node/_internal/envfile';
import { applyNodeOptionConfig } from './node-options';
import { applyMaxOldSpaceSize } from './flags-config';

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

// Smallest --max-stack-size that still leaves room for the runtime's own
// bootstrap. Below this the overflow happens inside createRuntime (before the
// entry ever runs) and the failure is reported badly or not at all:
//
//   OBSERVED (2026-08-01, 32GB/tier-high Windows box, `cno run hello.js`):
//     64KB..160KB -> exit code 0, script never ran. At 160KB stderr is
//                    EMPTY too: a completely silent false success, 5/5 runs.
//     192KB..304KB -> exit code 1 (a diagnostic, at least).
//     312KB+       -> runs normally.
//
// The exit-code-0 cases come from fatal() in cts/src/errors.ts: formatError()
// runs String.prototype.replace on the message, which itself overflows the
// (already exhausted) stack, so os.exit(1) is never reached and the process
// falls off the end with status 0. CI reads that as success.
//
// Rejecting the value up front converts the worst failure mode (silent
// success) into a clear, non-zero, actionable error. The floor is set with
// headroom over the 312KB measured here because bootstrap depth varies with
// platform and build.
const MIN_USABLE_STACK_SIZE = 512 * 1024;

function validateStackSize(bytes: number | undefined): number | undefined {
    if (bytes === undefined) return undefined;
    // 0 means "engine default" — pass through untouched.
    if (bytes === 0) return bytes;
    if (bytes < MIN_USABLE_STACK_SIZE) {
        const kb = Math.round(bytes / 1024);
        const minKb = MIN_USABLE_STACK_SIZE / 1024;
        throw new Error(
            `--max-stack-size=${kb}KB is too small to start the runtime `
            + `(minimum ${minKb}KB). The overflow would happen during startup, `
            + `before your script runs.`,
        );
    }
    return bytes;
}

function entryUrl(entry: string): string {
    // `+` not `*`: with zero-or-more, a Windows drive letter like `D:` matches as
    // a URL scheme and returns early, so the drive-letter branch below was
    // unreachable and `import.meta.url` came out as a bare `D:/...` path.
    // A single-letter scheme is always a drive on Windows, never a scheme —
    // `hasUrlScheme` below already got this right.
    if (/^[a-z][a-z0-9+\-.]+:/i.test(entry) && !entry.startsWith('/')) return entry;
    const normalized = entry.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
    return normalized.startsWith('/') ? `file://${normalized}` : normalized;
}

/**
 * Map CLI flags onto a cts config.
 *
 * This mapping is the ONLY path that carries flags into the config for any
 * invocation naming a subcommand explicitly. cts re-parses `os.args` itself in
 * `createConfig` (cts/src/config.ts:314, CLI_TPL), but its `parseArgs`
 * (cts/src/utils/misc.ts:675) *breaks at the first positional token* — so
 * `cno run --no-http x.js` and `cno eval --no-http '…'` lose every flag while
 * `cno --no-http x.js` keeps them. Anything not mapped here is silently
 * dropped for the subcommand forms, which is how `--memory-limit` came to let
 * a script allocate 4 GB. Exported so `eval` shares it rather than
 * hand-rolling a subset (it previously mapped only silent/no-lock, leaving
 * --no-http/--no-node/--memory-limit dead on `cno eval`).
 */
export function flagsToConfig(
    flags: Record<string, string | boolean>,
    execArgv: string[] = [],
): Partial<ConfigOptions> {
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
    // --memory-limit / --max-stack-size were parsed by the CLI and printed in
    // --help but never mapped into the config, so `cfg.memoryLimit` stayed
    // undefined and cts/src/config.ts:353 then applied the memory-TIER DEFAULT
    // instead. Net effect: `--memory-limit=16MB` let a script allocate 4 GB and
    // exit 0. cts already owns the parsing (`parseSize`, accepting 256MB/1GB/4MB)
    // and already calls engine.setMemoryLimit at :355 — only this mapping was
    // missing. Pass the raw string through; cts validates and throws on garbage.
    if (s('memory-limit'))   c.memoryLimit = parseSize(s('memory-limit'));
    if (s('max-stack-size')) c.maxStackSize = validateStackSize(parseSize(s('max-stack-size')));
    applyMaxOldSpaceSize(c, flags, execArgv);
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
        // Scoped import-map entries are part of the same map and were the one
        // piece never published, so a worker could inherit the bare mappings
        // while silently losing their per-scope overrides.
        importMapScopes: cfg.importMapScopes,
        pathAliases: cfg.pathAliases,
        baseUrl: cfg.baseUrl,
        // A Worker runs on its own JSRuntime (TJS_NewRuntimeWorker ->
        // TJS_DefaultOptions -> mem_limit = 0) and re-derives its config from
        // os.args, which does NOT carry the parent's CLI flags. So
        // --memory-limit / --max-stack-size were silently dropped at the
        // thread boundary and the worker fell back to the memory-TIER default.
        // OBSERVED before this: a worker allocated 600MB under
        // --memory-limit=16MB (37x) and the parent still exited 0. The
        // CTS_MEMORY_LIMIT *env var* was enforced correctly, because env is
        // inherited — only the flag path was broken.
        memoryLimit: cfg.memoryLimit,
        maxStackSize: cfg.maxStackSize,
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

/**
 * True when `entry` carries a real URL scheme (npm:, http:, jsr:, file:…).
 *
 * A scheme must be at least TWO characters here, because on Windows a bare
 * absolute path starts with a one-letter drive prefix that is otherwise
 * indistinguishable from a scheme: `/^[a-z][a-z0-9+\-.]*:/i` happily matches
 * the `C:` of `C:/tmp/script`. No real scheme is a single letter, so requiring
 * two is safe and removes the ambiguity. (`entryUrl` above uses the same `+`
 * quantifier for the same reason; it previously used `*` and so returned a bare
 * `D:/...` path where a `file:///` URL was wanted.)
 */
function hasUrlScheme(entry: string): boolean {
    return /^[a-z][a-z0-9+\-.]+:/i.test(entry) && !entry.startsWith('/');
}

function shouldLoadSourceEntry(entry: string, flags: Record<string, string | boolean>): boolean {
    if (hasExplicitExt(flags)) return true;
    // Before hasUrlScheme required two characters, every Windows absolute path
    // took the `return false` branch, so an extensionless entry fell through to
    // loadEntry → guessFileKind (cts/src/resolve/protocols/base.ts:20), which
    // maps "no extension" to fileKind 'binary'. A binary module evaluates to
    // nothing, so OBSERVED (5/5 runs, Windows): `cno run <extensionless>` exited
    // 0 with EMPTY stdout and EMPTY stderr and never ran the script — CI scores
    // that a pass. `--ext=js` masked it by taking the branch above, and POSIX
    // masked it because the leading `/` failed the second half of the test.
    // help.ts documents extensionless entries as defaulting to ts.
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

/**
 * Tokenize NODE_OPTIONS the way node's own `ParseNodeOptionsEnvVar` does —
 * verified differentially against node v24.18 by round-tripping `--title`:
 *
 *   a\b        → `a\b`     backslash is LITERAL outside double quotes
 *   a\\b       → `a\\b`    …including a doubled one
 *   "a\b"      → `ab`      inside double quotes it escapes the next char
 *   "a\"b"     → `a"b`     …so an escaped quote does not close the string
 *   a'b        → `a'b`     single quotes are not quote characters
 *   'a b'      → `'a`      …so they do not protect the space
 *
 * The only separator is the SPACE character: node splits on `' '` alone, so a
 * tab or newline stays inside the token (`--a<TAB>--b` is one option name and
 * node rejects it as such). Splitting on `\t`/`\n` invented tokens node never
 * produces, and escaping `\` everywhere broke every unquoted Windows path —
 * `--require C:\tmp\x.cjs` became `C:tmpx.cjs`.
 */
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
        // kind === 'loader'. --loader was parsed, classified here and then
        // dropped by both branches above, so OBSERVED: a hook module passed via
        // --loader never ran and nothing was reported. Honouring it needs ESM
        // loader-hook registration, which is an explicit no-op in this build
        // (cno/src/node/module/mod.ts:854 Module.register). Warning is the
        // honest behaviour: a resolve/load hook that silently does not run
        // changes which code the program actually executes, and the user has no
        // way to tell. Not fatal, because node accepts the flag.
        console.error(
            `cno: warning: --loader=${preload.specifier} is not supported `
            + '(ESM loader hooks are unimplemented); the hook will NOT run',
        );
    }
}

function applyLocationFlag(flags: Record<string, string | boolean>): void {
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
    // A portable pack must not inherit deno.json/tsconfig/package settings
    // from whichever directory happens to contain it at run time.
    const fileCfg = isPack ? {} : loadConfigFile(dir);
    const cliCfg  = flagsToConfig(opts.flags, execArgv);

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        ...opts.config,
        ...cliCfg,
    };
    // A .jspack container has no real project directory to resolve/lock
    // against — its module graph is fully described by its own manifest.
    if (isPack) cfg.disableLock = true;

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

    // --polyfill was advertised ("Custom polyfill bundle"), parsed, mapped into
    // the config and forwarded to workers — but cno never loaded it. The loader
    // exists (cts/src/runtime/index.ts:754 loadPolyfill) and the *standalone*
    // cts binary calls it (cts/main.ts:239/269); cno's bundle contained the
    // definition and zero call sites, so OBSERVED `--polyfill=/nonexistent.js`
    // exited 0 with no diagnostic instead of failing. A polyfill bundle exists
    // to redefine globals, so silently skipping it means the program runs in a
    // different environment than the user asked for. Mirrors cts/main.ts,
    // including fatal() on a bad bundle rather than continuing unpolyfilled.
    if (runtime.config.polyfill) {
        try {
            await runtime.loadPolyfill(runtime.config.polyfill);
        } catch (e) {
            fatal(e, `loading polyfill ${runtime.config.polyfill}`);
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

    try {
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
        // Fire the global 'load' event now that the *user* entry has evaluated.
        //
        // The native EV_LOAD (circu.js/src/utils.c:469) is dispatched by
        // TJS_EvalModuleContent for the C-level main module — cno's own
        // bootstrap — which runs before any user entry exists. So it was not
        // merely displaced by the single-slot onEvent setter; it was
        // unreachable: OBSERVED that a raw receiver installed at the top of a
        // `cno run` entry sees EV 0 and EV 2 but never EV 3.
        //
        // Deno fires 'load' after the entry module evaluates (measured against
        // 2.9.3: `load` prints after the module body, before any timer), so the
        // event has to be synthesised here. After eval, and inside the try, so
        // a failed entry does not report a successful load.
        //
        // dispatchLoadEvent() is idempotent, which is what makes it safe for
        // `cno test` to reach both this site and startTest's.
        await opts.onEvaluated?.(mod.namespace);
        dispatchLoadEvent();
    } catch (e) {
        if (isInternalWorkerClose(e)) throw e;
        fatal(e, entry);
    } finally {
        // Once the entry has settled, the inspector alone must not pin the loop.
        dbg?.allowProcessExit();
        uninstallInspectorBridge();
    }

    runtime.flushLock();
}
