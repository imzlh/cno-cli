import { joinPaths, stripJsonc } from '../../cts/src/utils';
import type { ConfigOptions } from '../../cts/src/types';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonObject(path: string): JsonObject | null {
    try {
        const value: unknown = JSON.parse(stripJsonc(engine.decodeString(fs.readFile(path))));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

export function buildCacheConfig(
    fileCfg: Partial<ConfigOptions>,
    flags: Record<string, string | boolean>,
): Partial<ConfigOptions> {
    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        disableLock: false,
        persistLock: true,
    };

    if (flags['silent'] === true) cfg.silent = true;
    if (flags['no-oxc'] === true) cfg.enableOxc = false;
    if (flags['ignore-scripts'] === true) cfg.ignoreScripts = true;
    if (flags['cached-only'] === true) cfg.cachedOnly = true;

    const npmMode = flags['npm-mode'];
    if (npmMode === 'normal' || npmMode === 'soft' || npmMode === 'hard') {
        cfg.nodeModulesMode = npmMode;
    }

    if (typeof flags['cache-dir'] === 'string') cfg.cacheDir = flags['cache-dir'];
    if (typeof flags['lock-dir'] === 'string') cfg.lockDir = flags['lock-dir'];

    return cfg;
}

export interface CollectSpecifiersOptions {
    denoImports?: boolean;
    packageDependencies?: boolean;
}

export function collectSpecifiers(dir: string, opts: CollectSpecifiersOptions = {}): Set<string> {
    const includeDenoImports = opts.denoImports !== false;
    const includePackageDependencies = opts.packageDependencies !== false;
    const specs = new Set<string>();

    if (includeDenoImports) {
        for (const name of ['deno.json', 'deno.jsonc']) {
            const p = joinPaths(dir, name);
            if (!fs.exists(p)) continue;
            const dc = readJsonObject(p);
            if (isRecord(dc?.imports)) {
                for (const [, value] of Object.entries(dc.imports)) {
                    if (typeof value === 'string' && value.trim()) {
                        specs.add(value);
                    }
                }
            }
        }
    }

    if (includePackageDependencies) {
        const pkgP = joinPaths(dir, 'package.json');
        if (fs.exists(pkgP)) {
            const pkg = readJsonObject(pkgP);
            if (pkg) {
                for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
                    const deps = pkg[field];
                    if (!isRecord(deps)) continue;
                    for (const [name, version] of Object.entries(deps)) {
                        if (typeof version === 'string' && isRegistryDependencyRange(version)) {
                            specs.add(dependencySpecifier(name, version));
                        }
                    }
                }
            }
        }
    }

    return specs;
}

function dependencySpecifier(name: string, value: string): string {
    const range = value.trim();
    if (range.startsWith('npm:')) return `npm:${range.slice(4)}`;
    return `npm:${name}@${range}`;
}

const REGISTRY_PROTOCOLS = ['workspace:', 'file:', 'link:', 'portal:', 'git:', 'github:', 'gitlab:', 'bitbucket:'];

function isRegistryDependencyRange(value: string): boolean {
    const range = value.trim();
    if (!range) return false;
    if (range.startsWith('.') || range.startsWith('/') || range.startsWith('~/')) return false;
    if (REGISTRY_PROTOCOLS.some(p => range.startsWith(p))) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(range)) return false;
    return true;
}
