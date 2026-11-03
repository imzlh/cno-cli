import { dirname, joinPaths, normalizePath, resolvePath } from '../cts/src/utils/path';
import type { ConfigOptions } from '../cts/src/types';
import { readEnv } from './env';

/** Files that make a directory a complete packaged Bun payload. */
const PAYLOAD_FILES = ['index.js', 'sqlite.js'] as const;

/**
 * Candidate payload directories for an executable, most specific first.
 * Pure string work, so callers can test layouts without touching the disk.
 */
export function bunDirCandidates(executable: string): string[] {
    const dir = dirname(executable);
    return ([
        // Staged build (build/stage/cno) and relocatable archives.
        joinPaths(dir, 'lib', 'cno', 'bun'),
        // Installed layouts: <prefix>/bin/cno with <prefix>/lib[64]/cno/bun.
        joinPaths(dir, '..', 'lib', 'cno', 'bun'),
        joinPaths(dir, '..', 'lib64', 'cno', 'bun'),
    ]).map(normalizePath);
}

/** Repository dist trees reachable from an executable inside a CMake build tree. */
function developmentCandidates(executable: string, isFile: (path: string) => boolean): string[] {
    const dir = dirname(executable);
    const candidates: string[] = [];
    // build/stage/cno -> <repo>/dist, and build/cno -> <repo>/dist. The CMake
    // cache marks a real build tree, so installed binaries never probe upward.
    if (isFile(normalizePath(joinPaths(dir, '..', 'CMakeCache.txt')))) {
        candidates.push(normalizePath(joinPaths(dir, '..', '..', 'dist', 'lib', 'cno', 'bun')));
    }
    if (isFile(joinPaths(dir, 'CMakeCache.txt'))) {
        candidates.push(normalizePath(joinPaths(dir, '..', 'dist', 'lib', 'cno', 'bun')));
    }
    return candidates;
}

/**
 * Locate packaged Bun code with stat calls only; no payload file is read or
 * parsed. Never consults the Bun sources, caches, or the network.
 */
function discoverBunDir(): string | undefined {
    const override = readEnv('CNO_BUN_DIR');
    // An explicit, even missing, directory must not silently select another
    // installation. CTS reports a missing payload only when Bun is imported.
    if (override) return resolvePath(override);

    const os = import.meta.use('os');
    const fs = import.meta.use('fs');
    const isFile = (path: string): boolean => {
        try {
            return fs.stat(path).isFile;
        } catch {
            return false;
        }
    };
    let executable: string | undefined;
    try {
        executable = os.exePath || undefined;
    } catch {
        // An unreadable executable path only disables discovery.
    }
    if (!executable) return undefined;

    for (const candidate of [...bunDirCandidates(executable), ...developmentCandidates(executable, isFile)]) {
        // Optional payloads do not make ordinary CLI startup fail.
        if (PAYLOAD_FILES.every(name => isFile(joinPaths(candidate, name)))) return resolvePath(candidate);
    }
    return undefined;
}

// The discovery stats ~6-10 paths; CNO_BUN_DIR is fixed once env files are
// loaded, so the process-wide result is memoized.
let discovered: string | undefined;
let discoveredYet = false;

export function resolveBunDir(): string | undefined {
    if (!discoveredYet) {
        discoveredYet = true;
        discovered = discoverBunDir();
    }
    return discovered;
}

/**
 * Fill config.bunDir for runtimes the caller is about to create. BunHandler
 * snapshots cfg.bunDir when the runtime is constructed, so this must precede
 * createRuntime; a dir arriving through a worker runtime config wins.
 */
export function applyBunDir(config: Partial<ConfigOptions>): void {
    if (config.bunDir !== undefined) return;
    const dir = resolveBunDir();
    if (dir !== undefined) config.bunDir = dir;
}
