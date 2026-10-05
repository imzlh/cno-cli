const os = import.meta.use('os');
import { SUBCOMMANDS, normalizeArgs, type NormalizedArgs, type Args, type Subcommand as CnoSubcommand } from '../cno/src/utils/args';

export type Subcommand = CnoSubcommand | null;
export type Flags = Record<string, string | boolean>;

export interface ParsedOption {
    name: string;
    value: string | boolean;
    /** Original spelling, including a separate value when present. */
    tokens: string[];
}

export interface OptionDefinition {
    name: string;
    value: 'none' | 'required' | 'optional' | 'inspect';
    aliases: readonly string[];
    consumer: 'kernel' | 'runtime' | 'command' | 'noop';
    prefix: boolean;
    commands: readonly CnoSubcommand[];
}

export interface ParsedCli {
    cmd: Subcommand;
    readonly command: Subcommand;
    readonly entry: string | undefined;
    positional: string[];
    /** Command configuration only. Kernel-only options never enter this map. */
    flags: Flags;
    kernelFlags: Flags;
    kernelOptions: ParsedOption[];
    commandOptions: ParsedOption[];
    readonly prefixFlags: string[];
    readonly actionFlags: string[];
    readonly prefixArgs: string[];
    rawArgs: NormalizedArgs;
    readonly kernelArgs: string[];
    readonly commandArgs: string[];
    readonly scriptArgs: string[];
}

const ALL_COMMANDS: readonly CnoSubcommand[] = SUBCOMMANDS;
const RUNTIMES: readonly CnoSubcommand[] = ['run', 'serve', 'eval', 'test', 'cache', 'pack', 'repl'];
const PROGRAMS: readonly CnoSubcommand[] = ['run', 'serve', 'test'];
const registry = new Map<string, OptionDefinition>();

function define(names: string[], options: Partial<Omit<OptionDefinition, 'name'>>): void {
    for (const name of names) {
        registry.set(name, {
            name, value: 'none', aliases: [],
            consumer: 'command', prefix: false, commands: [], ...options,
        });
    }
}

// This is the sole CLI option vocabulary. Tokenization, validation, forwarding
// and runtime preparation all use these definitions.
define(['inspect', 'inspect-brk', 'inspect-wait'], { value: 'inspect', consumer: 'kernel', prefix: true });
define(['require', 'import', 'loader', 'conditions'], { value: 'required', consumer: 'kernel', prefix: true });
define(['memory-limit', 'max-stack-size', 'max-old-space-size'], { value: 'required', consumer: 'kernel', prefix: true });
define(['v8-flags'], { value: 'optional', consumer: 'kernel', prefix: true });
define(['cache-dir', 'lock-dir'], { value: 'required', consumer: 'runtime', prefix: true, commands: RUNTIMES });
define(['frozen', 'disable-cache', 'cached-only', 'no-http', 'no-jsr', 'no-node', 'no-oxc'], { consumer: 'runtime', prefix: true, commands: RUNTIMES });
define(['no-lock'], { consumer: 'runtime', prefix: true, commands: ['run', 'serve', 'eval', 'test', 'pack', 'repl'] });
define(['polyfill'], { value: 'required', consumer: 'runtime', prefix: true, commands: ['run', 'serve', 'eval', 'test'] });
define(['ext'], { value: 'required', consumer: 'runtime', prefix: true, commands: ['run', 'serve', 'eval', 'test', 'pack'] });
define(['location'], { value: 'required', consumer: 'runtime', prefix: true, commands: ['run', 'serve', 'eval', 'test'] });
define(['env', 'env-file', 'preload'], { value: 'required', consumer: 'runtime', prefix: true, commands: PROGRAMS });
define(['precache', 'reload'], { consumer: 'runtime', prefix: true, commands: PROGRAMS });
define(['system-proxy', 'skip-cert-verify', 'silent'], { consumer: 'runtime', prefix: true, commands: ALL_COMMANDS });
define(['help', 'version'], { prefix: true, commands: ALL_COMMANDS });
define(['port', 'host'], { value: 'required', commands: ['serve'] });
define(['concurrency', 'filter'], { value: 'required', commands: ['test'] });
define(['fail-fast', 'permit-no-files'], { commands: ['test'] });
define(['out'], { value: 'optional', commands: ['pack'] });
define(['cwd'], { value: 'required', commands: ['task'] });
define(['eval'], { value: 'optional', commands: ['task', 'eval'] });
define(['print'], { commands: ['eval'] });
define(['npm-mode'], { value: 'required', commands: ['cache'] });
define(['ignore-scripts'], { commands: ['cache'] });
define([
    'allow-all', 'allow-net', 'allow-read', 'allow-write', 'allow-env', 'allow-run', 'allow-ffi', 'allow-sys', 'allow-import',
    'deny-net', 'deny-read', 'deny-write', 'deny-env', 'deny-run', 'deny-ffi', 'deny-sys', 'deny-import', 'no-prompt',
    'unstable', 'unstable-bare-node-builtins', 'unstable-byonm', 'unstable-sloppy-imports', 'unstable-workspaces', 'unstable-detect-cjs',
    'check', 'no-check', 'quiet', 'no-config', 'no-remote', 'lock-write', 'no-npm', 'no-warnings',
], { consumer: 'noop', prefix: true, commands: ALL_COMMANDS });
define(['cert', 'import-map', 'lock', 'log-level', 'seed'], { value: 'required', consumer: 'noop', prefix: true, commands: ALL_COMMANDS });
// Task consumes config; other commands accept the Deno compatibility spelling.
define(['config'], { value: 'required', consumer: 'command', prefix: true, commands: ALL_COMMANDS });

for (const [name, shortNames] of [
    ['reload', ['-r']], ['silent', ['-q']], ['allow-all', ['-A']],
    ['print', ['-p']], ['out', ['-o']], ['conditions', ['-C']],
    ['help', ['-h']], ['version', ['-v']],
] as const) registry.get(name)!.aliases = shortNames;
registry.get('cache-dir')!.commands = [...RUNTIMES, 'setup', 'exec'];

export const OPTION_REGISTRY: ReadonlyMap<string, OptionDefinition> = registry;
const aliases = new Map([...registry.values()].flatMap(def => def.aliases.map(alias => [alias, def.name] as const)));
const subcommands = new Set<string>(SUBCOMMANDS);

function isNoopFamily(name: string): boolean {
    return name.startsWith('allow-') || name.startsWith('deny-') || name.startsWith('unstable-');
}

interface TokenizerOptions { nodeOptions?: boolean }

function optionHead(token: string, mode: TokenizerOptions): { name: string; inline?: string } {
    const equals = token.indexOf('=');
    const head = equals < 0 ? token : token.slice(0, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    if (mode.nodeOptions && head === '-r') return { name: 'require', inline };
    const alias = aliases.get(head);
    if (alias) return { name: alias, inline };
    if (!token.startsWith('--') && token.length > 2) {
        const short = token.slice(0, 2);
        const name = mode.nodeOptions && short === '-r' ? 'require' : aliases.get(short);
        if (name && registry.get(name)?.value !== 'none') return { name, inline: token.slice(2).replace(/^=/, '') };
    }
    // A single dash only introduces registered short spellings. Keep unknown
    // long-looking tokens distinct so `-inspect` cannot activate --inspect.
    const name = head.startsWith('--') ? head.slice(2) : head.length === 2 ? head.slice(1) : head;
    return { name, inline };
}

function canConsumeValue(token: string | undefined, mode: TokenizerOptions): token is string {
    if (token === undefined || token === '--') return false;
    if (!token.startsWith('-') || token === '-') return true;
    if (token.startsWith('--')) return false;
    const name = optionHead(token, mode).name;
    return !registry.has(name) && !isNoopFamily(name) && token !== '-e';
}

function isInspectAddress(token: string | undefined): token is string {
    return token !== undefined && /^(?:\d+|[A-Za-z0-9.-]+:\d+|\[[0-9A-Fa-f:.%]+\]:\d+)$/.test(token);
}

function readOption(tokens: string[], index: number, mode: TokenizerOptions = {}): ParsedOption {
    const token = tokens[index]!;
    const { name, inline } = optionHead(token, mode);
    const kind = registry.get(name)?.value;
    if (inline !== undefined) {
        const value = (kind === 'none' || kind === 'inspect') && (inline === 'true' || inline === 'false')
            ? inline === 'true' : inline;
        return { name, value, tokens: [token] };
    }
    const next = tokens[index + 1];
    if ((kind === 'inspect' && isInspectAddress(next)) ||
        ((kind === 'required' || kind === 'optional') && canConsumeValue(next, mode))) {
        return { name, value: next!, tokens: [token, next!] };
    }
    return { name, value: true, tokens: [token] };
}

/** Tokenize an already isolated option region, preserving every occurrence. */
export function tokenizeOptions(tokens: string[], mode: TokenizerOptions = {}): ParsedOption[] {
    const options: ParsedOption[] = [];
    for (let i = 0; i < tokens.length;) {
        const token = tokens[i]!;
        if (mode.nodeOptions && (!token.startsWith('-') || token === '-' || token === '--')) {
            throw new Error(`Unexpected argument in NODE_OPTIONS: ${token}`);
        }
        if (token === '--') break;
        const option = readOption(tokens, i, mode);
        options.push(option);
        i += option.tokens.length;
    }
    return options;
}

/** NODE_OPTIONS uses whitespace and double quotes, not shell expansion. */
export function splitNodeOptions(value: string | undefined): string[] {
    if (!value) return [];
    const tokens: string[] = [];
    let token = '', quoted = false, started = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i]!;
        if (char === '"') { quoted = !quoted; started = true; continue; }
        if (quoted && char === '\\') {
            if (++i === value.length) throw new Error('invalid value for NODE_OPTIONS (invalid escape)');
            token += value[i];
            continue;
        }
        if (!quoted && /\s/.test(char)) {
            if (started) tokens.push(token);
            token = ''; started = false;
            continue;
        }
        token += char; started = true;
    }
    if (quoted) throw new Error('invalid value for NODE_OPTIONS (unterminated string)');
    if (started) tokens.push(token);
    return tokens;
}

/** Environment options use the same grammar, restricted to runtime startup. */
export function parseNodeOptions(value: string | undefined): ParsedOption[] {
    const options = tokenizeOptions(splitNodeOptions(value), { nodeOptions: true });
    for (const option of options) {
        if (registry.get(option.name)?.consumer !== 'kernel' && option.name !== 'no-warnings') {
            throw new Error(`Unknown option in NODE_OPTIONS: ${option.tokens[0]}`);
        }
    }
    const missing = missingOptionValues(options);
    if (missing.length) throw new Error(`Missing value for --${missing[0]} in NODE_OPTIONS`);
    return options;
}

/** Repeated values stay ordered, even across aliases and option regions. */
export function optionValues(options: readonly ParsedOption[], names: readonly string[]): string[] {
    return options.flatMap(option => names.includes(option.name) && typeof option.value === 'string' ? [option.value] : []);
}

export function flagsFromOptions(options: readonly ParsedOption[]): Flags {
    const flags: Flags = {};
    for (const option of options) {
        const previous = Object.hasOwn(flags, option.name) ? flags[option.name] : undefined;
        const value = option.name === 'conditions' && typeof previous === 'string' && typeof option.value === 'string'
            ? `${previous},${option.value}` : option.value;
        Object.defineProperty(flags, option.name, { value, enumerable: true, configurable: true, writable: true });
    }
    return flags;
}

function commandAllows(name: string, command: CnoSubcommand): boolean {
    const definition = registry.get(name);
    return definition?.consumer === 'kernel' || definition?.commands.includes(command) === true || isNoopFamily(name);
}

export function commandOptionTokensFor(cli: Pick<ParsedCli, 'commandOptions'>, command: CnoSubcommand): string[] {
    return cli.commandOptions.filter(option => registry.get(option.name)?.consumer !== 'kernel' && commandAllows(option.name, command))
        .flatMap(option => option.tokens);
}

/** The command token establishes ownership; an entry establishes passthrough. */
export function parseArgv(argv: string[]): ParsedCli {
    let cmd: Subcommand = null;
    let commandDecided = false;
    let entryFound = false;
    let evalToken: Args['evalToken'];
    const positional: string[] = [];
    const kernelOptions: ParsedOption[] = [];
    const commandOptions: ParsedOption[] = [];
    const synthetic: ParsedOption[] = [];

    const entryStopsOptions = (): boolean => cmd === null || ['run', 'serve', 'exec', 'task', 'eval'].includes(cmd);
    for (let i = 0; i < argv.length;) {
        const token = argv[i]!;
        if (entryFound) { positional.push(...argv.slice(i)); break; }
        if (token === '--') {
            if (cmd === 'test') positional.push('--');
            positional.push(...argv.slice(i + 1));
            break;
        }

        if (!commandDecided && ['-h', '--help', '-v', '--version'].includes(token)) {
            cmd = token === '-h' || token === '--help' ? 'help' : 'version';
            commandDecided = true; i++; continue;
        }
        if (!commandDecided && /^(?:-e|-p|-pe|-ep|--eval|--print)(?:=|$)/.test(token)) {
            const eq = token.indexOf('=');
            const head = eq < 0 ? token : token.slice(0, eq);
            const print = head === '-p' || head === '--print' || head === '-pe' || head === '-ep';
            evalToken = { flag: head as NonNullable<Args['evalToken']>['flag'], inline: eq >= 0 };
            cmd = 'eval'; commandDecided = true;
            if (print) synthetic.push({ name: 'print', value: true, tokens: [] });
            if (eq >= 0) { positional.push(token.slice(eq + 1)); entryFound = true; }
            else if (argv[i + 1] !== undefined) {
                positional.push(argv[++i]!); entryFound = true;
            }
            i++; continue;
        }

        if (token.startsWith('-') && token !== '-') {
            const option = readOption(argv, i);
            (commandDecided ? commandOptions : kernelOptions).push(option);
            i += option.tokens.length;
            continue;
        }
        if (!commandDecided) {
            commandDecided = true;
            if (subcommands.has(token)) cmd = token as CnoSubcommand;
            else { positional.push(token); entryFound = true; }
        } else {
            positional.push(token);
            entryFound = entryStopsOptions();
        }
        i++;
    }

    const separator = cmd === 'test' ? positional.indexOf('--') : -1;
    const scriptArgs = cmd === 'test' ? (separator < 0 ? [] : positional.slice(separator + 1))
        : entryStopsOptions() ? positional.slice(1) : [];
    const rawArgs = normalizeArgs({
        binary: os.args[0], internalArgs: kernelOptions.flatMap(option => option.tokens),
        action: cmd ?? 'run', actionArgs: commandOptions.flatMap(option => option.tokens),
        entry: positional[0] ?? 'repl', args: scriptArgs, evalToken,
    });
    return {
        cmd,
        get command() { return this.cmd; },
        get entry() { return this.positional[0]; },
        positional,
        flags: flagsFromOptions([...commandOptions.filter(option => registry.get(option.name)?.consumer !== 'kernel'), ...synthetic]),
        kernelFlags: flagsFromOptions(kernelOptions),
        kernelOptions, commandOptions, rawArgs,
        get prefixFlags() { return [...new Set(this.kernelOptions.map(option => option.name))]; },
        get actionFlags() { return [...new Set(this.commandOptions.map(option => option.name))]; },
        get prefixArgs() { return this.rawArgs.kernelArgs; },
        get kernelArgs() { return this.rawArgs.kernelArgs; },
        get commandArgs() { return this.rawArgs.commandArgs; },
        get scriptArgs() { return this.rawArgs.scriptArgs; },
    };
}

function unknownOptionTokens(options: ParsedOption[], allowed: (name: string) => boolean): string[] {
    return [...new Set(options.filter(option => !allowed(option.name)).map(option => option.tokens[0]!.split('=')[0]!))];
}

export function unknownKernelFlags(cli: ParsedCli): string[] {
    return unknownOptionTokens(cli.kernelOptions, name => registry.get(name)?.prefix === true || isNoopFamily(name));
}

export function unknownCommandFlags(cli: ParsedCli): string[] {
    return unknownOptionTokens(cli.commandOptions, name => commandAllows(name, cli.cmd ?? 'run'));
}

export function unknownFlags(cli: ParsedCli): string[] {
    return [...new Set([...unknownKernelFlags(cli), ...unknownCommandFlags(cli)])];
}

export function missingOptionValues(options: readonly ParsedOption[]): string[] {
    return [...new Set(options.filter(option => registry.get(option.name)?.value === 'required' &&
        (option.value === true || option.value === '')).map(option => option.name))];
}

/** Validate occurrences, so a later value cannot conceal an earlier omission. */
export function missingFlagValues(cli: ParsedCli): string[] {
    return missingOptionValues([...cli.kernelOptions, ...cli.commandOptions]);
}

export function readArgv(): string[] { return os.args.slice(1); }
