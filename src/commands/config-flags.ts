import { parseSize } from '../../cts/src/api';
import type { ConfigOptions } from '../../cts/src/api';
import { applyMaxOldSpaceSize } from './flags-config';
import { applyNodeOptionConfig } from './node-options';

const MIN_USABLE_STACK_SIZE = 512 * 1024;

const WORKER_RUNTIME_STRING_KEYS = ['cacheDir', 'lockDir', 'polyfill', 'baseUrl'] as const satisfies readonly (keyof ConfigOptions)[];
const WORKER_RUNTIME_BOOLEAN_KEYS = [
    'enableHttp', 'enableJsr', 'enableNode', 'enableCache', 'cachedOnly',
    'enableOxc', 'frozen', 'disableLock', 'ignoreScripts',
] as const satisfies readonly (keyof ConfigOptions)[];
const WORKER_RUNTIME_NUMBER_KEYS = ['memoryLimit', 'maxStackSize'] as const satisfies readonly (keyof ConfigOptions)[];

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

export function flagsToConfig(
    flags: Record<string, string | boolean>,
    execArgv: string[] = [],
): Partial<ConfigOptions> {
    const cfg: Partial<ConfigOptions> = {};
    const stringFlag = (name: string): string | undefined =>
        typeof flags[name] === 'string' ? flags[name] : undefined;
    const booleanFlag = (name: string): boolean =>
        flags[name] === true || flags[name] === 'true';

    if (stringFlag('cache-dir')) cfg.cacheDir = stringFlag('cache-dir');
    if (stringFlag('lock-dir')) cfg.lockDir = stringFlag('lock-dir');
    if (booleanFlag('no-lock')) cfg.disableLock = true;
    if (booleanFlag('frozen')) cfg.frozen = true;
    if (booleanFlag('disable-cache')) cfg.enableCache = false;
    if (booleanFlag('cached-only')) cfg.cachedOnly = true;
    if (booleanFlag('no-http')) cfg.enableHttp = false;
    if (booleanFlag('no-jsr')) cfg.enableJsr = false;
    if (booleanFlag('no-node')) cfg.enableNode = false;
    if (booleanFlag('no-oxc')) cfg.enableOxc = false;
    if (booleanFlag('silent') || booleanFlag('q')) cfg.silent = true;
    if (stringFlag('polyfill')) cfg.polyfill = stringFlag('polyfill');
    if (stringFlag('memory-limit')) cfg.memoryLimit = parseSize(stringFlag('memory-limit'));
    if (stringFlag('max-stack-size')) cfg.maxStackSize = validateStackSize(parseSize(stringFlag('max-stack-size')));

    applyMaxOldSpaceSize(cfg, flags, execArgv);
    applyNodeOptionConfig(cfg, flags);
    return cfg;
}

export function publishWorkerRuntimeConfig(cfg: Partial<ConfigOptions>): void {
    const workerConfig: Record<string, unknown> = {};
    for (const key of WORKER_RUNTIME_CONFIG_KEYS) workerConfig[key] = cfg[key];
    Reflect.set(globalThis, '__cno_worker_runtime_config', workerConfig);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
    if (!isRecord(value)) return undefined;
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string') result[key] = entry;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function nestedStringRecord(value: unknown): Record<string, Record<string, string>> | undefined {
    if (!isRecord(value)) return undefined;
    const result: Record<string, Record<string, string>> = {};
    for (const [key, entry] of Object.entries(value)) {
        const nested = stringRecord(entry);
        if (nested) result[key] = nested;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function stringArrayRecord(value: unknown): Record<string, string[]> | undefined {
    if (!isRecord(value)) return undefined;
    const result: Record<string, string[]> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (Array.isArray(entry) && entry.every((item) => typeof item === 'string')) {
            result[key] = entry.slice();
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
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
        if (typeof number === 'number' && Number.isFinite(number) && number >= 0) cfg[key] = number;
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
