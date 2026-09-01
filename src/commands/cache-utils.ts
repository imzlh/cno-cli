import { joinPaths, stripJsonc } from '../../cts/src/utils';
import type { ConfigOptions } from '../../cts/src/types';
import { flagsToConfig } from './config-flags';

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
        ...flagsToConfig(flags),
        disableLock: false,
        persistLock: true,
    };

    if (flags['ignore-scripts'] === true) cfg.ignoreScripts = true;

    const npmMode = flags['npm-mode'];
    if (npmMode === 'normal' || npmMode === 'soft' || npmMode === 'hard') {
        cfg.nodeModulesMode = npmMode;
    }

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
                    if (typeof value === 'string' && value.trim() && !isPrefixMapping(value)) {
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

/**
 * Trailing-slash import-map target (`"@/": "./"`, `"fresh/": "jsr:@fresh/core@2/"`).
 * These are directory prefixes, not modules: the value only becomes a specifier
 * once a subpath is appended, so precaching it verbatim asks the resolver for a
 * directory and fails the whole scan. Reachable subpaths arrive via the entry graph.
 */
function isPrefixMapping(value: string): boolean {
    return value.trim().endsWith('/');
}

function dependencySpecifier(name: string, value: string): string {
    const range = value.trim();
    if (range.startsWith('npm:')) return `npm:${range.slice(4)}`;
    return `npm:${name}@${range}`;
}

const REGISTRY_PROTOCOLS = ['workspace:', 'file:', 'link:', 'portal:', 'git:', 'github:', 'gitlab:', 'bitbucket:'];

/** http(s) archive URLs npm accepts as dependency versions (not git remotes). */
function isTarballUrlRange(value: string): boolean {
    if (!(value.startsWith('https://') || value.startsWith('http://'))) return false;
    // Strip query/hash; accept common npm pack extensions.
    const path = value.split(/[?#]/, 1)[0]!.toLowerCase();
    return path.endsWith('.tgz')
        || path.endsWith('.tar.gz')
        || path.endsWith('.tar')
        || path.endsWith('.tar.bz2');
}

function isRegistryDependencyRange(value: string): boolean {
    const range = value.trim();
    if (!range) return false;
    if (range.startsWith('.') || range.startsWith('/') || range.startsWith('~/')) return false;
    if (REGISTRY_PROTOCOLS.some(p => range.startsWith(p))) return false;
    // Direct http(s) tarball URLs (sheetjs CDN, etc.) are installable.
    if (isTarballUrlRange(range)) return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(range)) return false;
    return true;
}
