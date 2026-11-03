import { join } from 'node:path';

/**
 * Seed a fake npm cache entry: `npm/<pkg>@<version>/` with a package.json and
 * arbitrary payload files. Scoped names nest under their `@scope` directory.
 * Returns the package directory.
 */
export async function writeCachedNpmPackage(
    cacheDir: string,
    name: string,
    version: string,
    pkg: Record<string, unknown>,
    files: Record<string, string>,
): Promise<string> {
    const slash = name.indexOf('/');
    const dir = name.startsWith('@') && slash !== -1
        ? join(cacheDir, 'npm', name.slice(0, slash), `${name.slice(slash + 1)}@${version}`)
        : join(cacheDir, 'npm', `${name}@${version}`);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, 'package.json'), JSON.stringify({ name, version, ...pkg }));
    for (const [path, text] of Object.entries(files)) {
        const file = join(dir, path);
        await Deno.mkdir(join(file, '..'), { recursive: true });
        await Deno.writeTextFile(file, text);
    }
    return dir;
}

/** Seed the `meta.json` registry record (and its timestamp sentinel) for a package. */
export async function writeCachedNpmMeta(
    cacheDir: string,
    name: string,
    versions: Record<string, Record<string, unknown>> = {},
    tags: Record<string, string> = {},
): Promise<void> {
    const dir = join(cacheDir, 'npm', name);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, 'meta.json'), JSON.stringify({
        versions,
        'dist-tags': tags,
    }));
    await Deno.writeTextFile(join(dir, 'meta.json.ts'), String(Date.now()));
}
