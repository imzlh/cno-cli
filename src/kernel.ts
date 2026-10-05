import { createRuntime, cwd, joinPaths } from '../cts/src/api';
import type { ConfigOptions } from '../cts/src/api';
import setArgs, { type Args } from '../cno/src/utils/args';
import { flagsFromOptions, optionValues, OPTION_REGISTRY, parseNodeOptions, type Flags, type ParsedCli } from './cli';
import { CliCommandError } from './command-error';
import { flagsToConfig, publishWorkerRuntimeConfig } from './config';
import { loadEnvFiles, readEnv } from './env';
import { Inspector } from './inspector';
import { installInspectorBridge } from './inspector/bridge';
import { inspectOptions, type InspectOptions } from './inspector/options';

type NodePreload = { kind: 'require' | 'import' | 'loader'; specifier: string };

export interface KernelContext {
    readonly config: Partial<ConfigOptions>;
    readonly inspect: InspectOptions | null;
    /** Prefix defaults for commands, excluding options owned exclusively by the kernel. */
    readonly runtimeFlags: Flags;
    readonly preloads: readonly string[];
    readonly nodePreloads: readonly NodePreload[];
}

type KernelCli = Pick<ParsedCli, 'kernelOptions' | 'commandOptions'>;

/** Prepare common runtime settings exactly once, before dispatching a command. */
export function prepareKernel(cli: KernelCli, options: { inheritNodeOptions?: boolean } = {}): KernelContext {
    const runtimeOptions = [...cli.kernelOptions, ...cli.commandOptions].filter(option =>
        OPTION_REGISTRY.get(option.name)?.consumer === 'runtime',
    );
    loadEnvFiles(optionValues(runtimeOptions, ['env', 'env-file']), message => console.error(`Warning ${message}`));

    // An env file can supply NODE_OPTIONS; validate it before any runtime or
    // Inspector has been started. The CLI registry owns its option grammar too.
    const nodeOptions = options.inheritNodeOptions === false ? [] : parseNodeOptions(readEnv('NODE_OPTIONS') ?? undefined);
    const prefixOptions = cli.kernelOptions.filter(option =>
        OPTION_REGISTRY.get(option.name)?.consumer === 'kernel',
    );
    const kernelOptions = [...nodeOptions, ...prefixOptions];
    const kernelFlags = flagsFromOptions(kernelOptions);
    const nodePreloads: NodePreload[] = [];
    for (const option of kernelOptions) {
        if ((option.name === 'require' || option.name === 'import' || option.name === 'loader') && typeof option.value === 'string') {
            nodePreloads.push({ kind: option.name, specifier: option.value });
        }
    }
    return {
        config: flagsToConfig(flagsFromOptions(prefixOptions), flagsFromOptions(nodeOptions)),
        inspect: inspectOptions(kernelFlags),
        runtimeFlags: flagsFromOptions(cli.kernelOptions.filter(option => {
            const definition = OPTION_REGISTRY.get(option.name);
            return definition?.consumer === 'runtime' || (definition?.consumer === 'command' && definition.prefix);
        })),
        preloads: optionValues(runtimeOptions, ['preload']),
        nodePreloads,
    };
}

/** Commands receive only their own controls plus prepared runtime defaults. */
export function effectiveRuntimeFlags(kernel: KernelContext, commandFlags: Flags): Flags {
    return { ...kernel.runtimeFlags, ...commandFlags };
}

export function applyLocationFlag(flags: Flags): void {
    const location = flags.location;
    if (typeof location !== 'string' || location.length === 0) return;
    const os = import.meta.use('os');
    os.setenv('CNO_LOCATION', location);
    const apply = Reflect.get(globalThis, '__cno_applyLocation');
    if (typeof apply === 'function') apply(location);
}

export interface KernelRuntime {
    runtime: ReturnType<typeof createRuntime>;
    initialize(rawArgs?: Args): Promise<void>;
    finish(): void;
    close(): Promise<void>;
}

/** Own Inspector ordering and lifecycle for every command that executes code. */
export async function openKernelRuntime(
    kernel: KernelContext,
    entry: string,
    config: Partial<ConfigOptions>,
    dir: string,
    options: { repl?: boolean } = {},
): Promise<KernelRuntime> {
    let inspector: Inspector | null = null;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let bridge: ReturnType<typeof installInspectorBridge> | undefined;
    let finished = false;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = (async () => {
            const errors: unknown[] = [];
            try { await (bridge ? bridge.dispose() : inspector?.detach()); }
            catch (error) { errors.push(error); }
            try { runtime?.cleanup(); }
            catch (error) { errors.push(error); }
            if (errors.length) throw errors[0];
        })();
        return closePromise;
    };
    try {
        if (kernel.inspect) {
            const inspect = kernel.inspect;
            inspector = new Inspector({
                ...inspect,
                entryFile: entry,
                breakOnStart: options.repl ? false : inspect.breakOnStart,
                waitForClient: inspect.waitForClient || (options.repl === true && inspect.breakOnStart),
            });
            // Attach before CTS installs engine.onModule so script hooks compose.
            await inspector.attach();
        }
        runtime = createRuntime(config, dir);
        const activeRuntime = runtime;
        bridge = installInspectorBridge({
            entryFile: entry,
            onOpen: value => { if (finished) value.allowProcessExit(); },
            getCurrentInspector: () => inspector,
            setCurrentInspector: value => { inspector = value; },
        });
        activeRuntime.addInitHook((specPath, info) => {
            if (!closed) inspector?.scriptInitHook?.(specPath, info);
        });
        return {
            runtime,
            async initialize(rawArgs) {
                if (closed) throw new Error('Kernel runtime is closed');
                try {
                    publishWorkerRuntimeConfig(activeRuntime.config);
                    if (rawArgs) setArgs(rawArgs);
                    if (activeRuntime.config.polyfill) {
                        try {
                            await activeRuntime.loadPolyfill(activeRuntime.config.polyfill);
                        } catch (error) {
                            throw new CliCommandError(error, `loading polyfill ${activeRuntime.config.polyfill}`);
                        }
                    }
                    for (const specifier of kernel.preloads) {
                        await activeRuntime.compiler.evalTracked(await activeRuntime.loadModule(specifier, { preload: true }));
                    }
                    for (const preload of kernel.nodePreloads) {
                        if (preload.kind === 'require') {
                            activeRuntime.compiler.cjs.preloadModule(preload.specifier, joinPaths(cwd(), '__cno_require_preload__.js'));
                        } else if (preload.kind === 'import') {
                            await activeRuntime.compiler.evalTracked(await activeRuntime.loadEntry(preload.specifier, { nodePreload: true }, ''));
                        } else {
                            console.error(`cno: warning: --loader=${preload.specifier} is not supported (ESM loader hooks are unimplemented); the hook will NOT run`);
                        }
                    }
                } catch (error) {
                    try { await close(); } catch { /* preserve initialization failure */ }
                    throw error;
                }
            },
            finish() {
                if (closed) return;
                finished = true;
                inspector?.allowProcessExit();
            },
            close,
        };
    } catch (error) {
        try { await close(); } catch { /* preserve runtime construction failure */ }
        throw error;
    }
}
