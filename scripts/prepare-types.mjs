#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the declarations aligned with the APIs this runtime implements.
const version = '2.9.0';
const sha256 = 'bea783df0dc2556b40b3aa8644788400904b4f56e7c45ff112279bfe94faa5bf';
const source = `https://github.com/denoland/deno/releases/download/v${version}/lib.deno.d.ts`;
const destination = fileURLToPath(new URL('../node_modules/.cache/cno-types/lib.deno.d.ts', import.meta.url));

function checksum(contents) {
    return createHash('sha256').update(contents).digest('hex');
}

async function prepareTypes() {
    try {
        if (checksum(await readFile(destination)) === sha256) return;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Unable to download Deno ${version} types: HTTP ${response.status}`);
    }
    const contents = Buffer.from(await response.arrayBuffer());
    if (checksum(contents) !== sha256) {
        throw new Error(`Deno ${version} types failed SHA-256 verification`);
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    console.log(`Prepared Deno ${version} types`);
}

await prepareTypes();
