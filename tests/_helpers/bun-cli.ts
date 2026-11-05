/**
 * Shared harness for bun CLI tests: every case spawns a fresh `cno` child
 * with an isolated cache seeded from the checkout's polyfill sources.
 */

import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from './bytes.ts';

export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

export function commandEnv(cacheDir: string, extra: Record<string, string> = {}): Record<string, string> {
    const env = Deno.env.toObject();
    // Do not let a developer's global CTS/NODE settings change this isolated run.
    env.CTS_CACHE_DIR = cacheDir;
    env.CTS_LOCK_DIR = '';
    env.CTS_SILENT = 'true';
    env.NODE_OPTIONS = '';
    delete env.__CNO_TEST_CHILD;
    env.ALL_PROXY = '';
    env.HTTP_PROXY = '';
    env.HTTPS_PROXY = '';
    env.all_proxy = '';
    env.http_proxy = '';
    env.https_proxy = '';
    env.no_proxy = '*';
    env.NO_PROXY = '*';
    return { ...env, ...extra };
}

export async function runCno(
    args: string[],
    cwd: string,
    cacheDir: string,
    env: Record<string, string> = {},
): Promise<CommandResult> {
    const executable = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(executable, {
        args,
        cwd,
        env: commandEnv(cacheDir, env),
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

export function outputOf(result: CommandResult): string {
    return `${result.stdout}\n${result.stderr}`;
}

export function copyPolyfillSource(src: string, dst: string): void {
    Deno.mkdirSync(dst, { recursive: true });
    for (const entry of Deno.readDirSync(src)) {
        const from = join(src, entry.name);
        const to = join(dst, entry.name);
        if (entry.isDirectory) copyPolyfillSource(from, to);
        else if (entry.isFile && entry.name.endsWith('.ts')) Deno.copyFileSync(from, to);
    }
}

/** Copies the setup-managed polyfill sources into a cache directory. */
export function prepareCache(cacheDir: string): void {
    for (const name of ['node', 'bun', 'utils']) {
        copyPolyfillSource(join(Deno.cwd(), 'cno', 'src', name), join(cacheDir, name));
    }
}

/** Seeds `<root>/cno/src` so a child's own `setup` stays offline. */
export function prepareLocalSetupSource(root: string): void {
    for (const name of ['node', 'bun', 'utils']) {
        copyPolyfillSource(join(Deno.cwd(), 'cno', 'src', name), join(root, 'cno', 'src', name));
    }
}

export function jsonLine(result: CommandResult, prefix: string): Record<string, unknown> {
    const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith(prefix));
    ok(line, `missing ${prefix} line in:\n${outputOf(result)}`);
    return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

export function normalizedPath(value: unknown): string {
    return String(value).replaceAll('\\', '/');
}

export async function runBunProbe(
    root: string,
    entry: string,
    cacheDir: string,
    options: string[],
): Promise<Record<string, unknown>> {
    prepareCache(cacheDir);
    const result = await runCno([
        'run',
        `--cache-dir=${cacheDir}`,
        '--cached-only',
        '--no-http',
        '--no-jsr',
        '--no-lock',
        '--no-node',
        ...options,
        entry,
        '--frozen',
        'script-value',
    ], root, cacheDir);
    strictEqual(result.code, 0, outputOf(result));
    return jsonLine(result, 'BUN_RUN:');
}
