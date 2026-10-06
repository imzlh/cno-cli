import { parseSize } from '../cts/src/api';
import type { ConfigOptions } from '../cts/src/api';
import { flagsFromOptions, tokenizeOptions, type Flags } from './cli';
import { readEnv } from './env';

const MIN_USABLE_STACK_SIZE = 512 * 1024;

const WORKER_RUNTIME_STRING_KEYS = ['cacheDir', 'lockDir', 'polyfill', 'baseUrl', 'jsxPragma', 'jsxFragmentPragma'] as const satisfies readonly (keyof ConfigOptions)[];
const WORKER_RUNTIME_BOOLEAN_KEYS = [
    'enableHttp', 'enableJsr', 'enableNode', 'enableCache', 'cachedOnly',
    'enableOxc', 'frozen', 'disableLock', 'ignoreScripts', 'silent',
] as const satisfies readonly (keyof ConfigOptions)[];
const WORKER_RUNTIME_NUMBER_KEYS = ['memoryLimit', 'maxStackSize', 'requestTimeout', 'jsrCacheTTL'] as const satisfies readonly (keyof ConfigOptions)[];

export const WORKER_RUNTIME_CONFIG_KEYS = [
    ...WORKER_RUNTIME_STRING_KEYS,
    ...WORKER_RUNTIME_BOOLEAN_KEYS,
    ...WORKER_RUNTIME_NUMBER_KEYS,
    'conditions', 'importMap', 'importMapScopes', 'pathAliases',
] as const satisfies readonly (keyof ConfigOptions)[];

function validateStackSize(bytes: number | undefined): number | undefined {
    if (bytes === undefined || bytes === 0) return bytes;
    if (bytes < MIN_USABLE_STACK_SIZE) {
        throw new Error(`--max-stack-size must be at least ${MIN_USABLE_STACK_SIZE / 1024}KB`);
    }
    return bytes;
}

function sizeFlag(name: string, value: string | undefined): number | undefined {
    const bytes = parseSize(value);
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) {
        throw new Error(`--${name} must be a finite, non-negative safe integer number of bytes`);
    }
    return bytes;
}

/** Map normalized values; argv and environment option parsing belong to the CLI. */
export function flagsToConfig(flags: Flags, defaults: Flags = {}): Partial<ConfigOptions> {
    const explicit = flags;
    flags = { ...defaults, ...flags };
    const cfg: Partial<ConfigOptions> = {};
    const stringFlag = (name: string): string | undefined => {
        const value = flags[name];
        return typeof value === 'string' ? value : undefined;
    };

    const cacheDir = stringFlag('cache-dir');
    if (cacheDir) cfg.cacheDir = cacheDir;
    const lockDir = stringFlag('lock-dir');
    if (lockDir) cfg.lockDir = lockDir;
    for (const [name, key, enabled] of [
        ['no-lock', 'disableLock', true], ['frozen', 'frozen', true],
        ['disable-cache', 'enableCache', false], ['cached-only', 'cachedOnly', true],
        ['no-http', 'enableHttp', false], ['no-jsr', 'enableJsr', false],
        ['no-node', 'enableNode', false], ['no-oxc', 'enableOxc', false],
        ['silent', 'silent', true],
    ] as const) {
        const value = flags[name];
        if (value === true || value === 'true') cfg[key] = enabled;
        else if (value === false || value === 'false') cfg[key] = !enabled;
    }
    const polyfill = stringFlag('polyfill');
    if (polyfill) cfg.polyfill = polyfill;
    const memoryLimit = stringFlag('memory-limit');
    if (memoryLimit) cfg.memoryLimit = sizeFlag('memory-limit', memoryLimit);
    const maxStackSize = stringFlag('max-stack-size');
    if (maxStackSize) cfg.maxStackSize = validateStackSize(sizeFlag('max-stack-size', maxStackSize));

    applyMaxOldSpaceSize(cfg, explicit, defaults);
    const conditions = [defaults.conditions, explicit.conditions].flatMap(value =>
        typeof value === 'string' ? value.split(',').map(part => part.trim()).filter(Boolean) : [],
    );
    if (conditions.length) cfg.conditions = conditions;
    return cfg;
}

/** Node's memory cap is a fallback for the cno-specific limit. */
function maxOldSpaceValue(flags: Flags): string | boolean | undefined {
    const v8 = typeof flags['v8-flags'] === 'string'
        ? flagsFromOptions(tokenizeOptions(flags['v8-flags'].split(/[\s,]+/).filter(Boolean)))
        : {};
    return flags['max-old-space-size'] ?? v8['max-old-space-size'];
}

export function applyMaxOldSpaceSize(cfg: Partial<ConfigOptions>, flags: Flags, defaults: Flags = {}): void {
    const raw = maxOldSpaceValue(flags) ?? maxOldSpaceValue(defaults);
    if (raw === undefined || raw === true) return;
    const mb = Number(raw);
    const bytes = Math.floor(mb * 1024 * 1024);
    if (!Number.isFinite(mb) || mb <= 0 || !Number.isSafeInteger(bytes) || bytes < 1) {
        throw new Error('--max-old-space-size must be a positive number of megabytes');
    }
    if (cfg.memoryLimit === undefined && !readEnv('CTS_MEMORY_LIMIT')) cfg.memoryLimit = bytes;
}

export function publishWorkerRuntimeConfig(cfg: Partial<ConfigOptions>): void {
    const snapshot = decodeWorkerRuntimeConfig(cfg);
    const workerConfig = Object.fromEntries(WORKER_RUNTIME_CONFIG_KEYS.map(key => [key, snapshot?.[key]]));
    Reflect.set(globalThis, '__cno_worker_runtime_config', workerConfig);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
    if (!isRecord(value)) return undefined;
    const result = Object.fromEntries(Object.entries(value).flatMap(([key, entry]): Array<[string, string]> =>
        typeof entry === 'string' ? [[key, entry]] : [],
    ));
    return Object.keys(value).length === 0 || Object.keys(result).length > 0 ? result : undefined;
}

function nestedStringRecord(value: unknown): Record<string, Record<string, string>> | undefined {
    if (!isRecord(value)) return undefined;
    const result = Object.fromEntries(Object.entries(value).flatMap(([key, entry]): Array<[string, Record<string, string>]> => {
        const nested = stringRecord(entry);
        return nested ? [[key, nested]] : [];
    }));
    return Object.keys(value).length === 0 || Object.keys(result).length > 0 ? result : undefined;
}

function stringArrayRecord(value: unknown): Record<string, string[]> | undefined {
    if (!isRecord(value)) return undefined;
    const result = Object.fromEntries(Object.entries(value).flatMap(([key, entry]): Array<[string, string[]]> =>
        Array.isArray(entry) && entry.every(item => typeof item === 'string') ? [[key, entry.slice()]] : [],
    ));
    return Object.keys(value).length === 0 || Object.keys(result).length > 0 ? result : undefined;
}

export function decodeWorkerRuntimeConfig(value: unknown): Partial<ConfigOptions> | undefined {
    if (!isRecord(value)) return undefined;

    const cfg: Partial<ConfigOptions> = {};
    for (const key of WORKER_RUNTIME_STRING_KEYS) {
        if (typeof value[key] === 'string') cfg[key] = value[key];
    }
    for (const key of WORKER_RUNTIME_BOOLEAN_KEYS) {
        if (typeof value[key] === 'boolean') cfg[key] = value[key];
    }
    for (const key of WORKER_RUNTIME_NUMBER_KEYS) {
        const number = value[key];
        if (typeof number !== 'number' || number < 0) continue;
        const valid = key === 'memoryLimit' || key === 'maxStackSize'
            ? Number.isSafeInteger(number) : Number.isFinite(number);
        if (valid) cfg[key] = number;
    }
    if (Array.isArray(value.conditions) && value.conditions.every((item) => typeof item === 'string')) {
        cfg.conditions = value.conditions.slice();
    }

    const importMap = stringRecord(value.importMap);
    if (importMap) cfg.importMap = importMap;
    const importMapScopes = nestedStringRecord(value.importMapScopes);
    if (importMapScopes) cfg.importMapScopes = importMapScopes;
    const pathAliases = stringArrayRecord(value.pathAliases);
    if (pathAliases) cfg.pathAliases = pathAliases;

    return Object.keys(cfg).length > 0 ? cfg : undefined;
}
