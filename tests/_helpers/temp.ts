import { join } from 'node:path';

export function makeTempDir(prefix: string): string {
    return Deno.makeTempDirSync({ prefix: `cno-${prefix}-${Deno.pid}-` });
}

export function makePosixTempDir(prefix: string): string {
    return makeTempDir(prefix).replaceAll('\\', '/');
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = makeTempDir(prefix);
    try {
        return await fn(dir);
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
}

export async function withTempPath<T>(prefix: string, fn: (path: string, dir: string) => T | Promise<T>): Promise<T> {
    return withTempDir(prefix, (dir) => fn(join(dir, 'data'), dir));
}
