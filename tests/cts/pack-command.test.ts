import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import {
    decodePack,
    encodePack,
    encodePackHeader,
    readBlob,
    readSourceBlob,
    type PackManifest,
} from '../../cts/src/api/index.ts';

const decoder = new TextDecoder();
const nativeCrypto = import.meta.use('crypto');

function replaceAsciiOnce(bytes: Uint8Array, from: string, to: string): void {
    const needle = new TextEncoder().encode(from);
    const replacement = new TextEncoder().encode(to);
    strictEqual(replacement.byteLength, needle.byteLength);
    outer: for (let i = 0; i <= bytes.byteLength - needle.byteLength; i++) {
        for (let j = 0; j < needle.byteLength; j++) {
            if (bytes[i + j] !== needle[j]) continue outer;
        }
        bytes.set(replacement, i);
        return;
    }
    throw new Error(`Could not find ${from} in encoded pack`);
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
    const needle = new TextEncoder().encode(value);
    outer: for (let i = 0; i <= bytes.byteLength - needle.byteLength; i++) {
        for (let j = 0; j < needle.byteLength; j++) {
            if (bytes[i + j] !== needle[j]) continue outer;
        }
        return true;
    }
    return false;
}

function packExtractDir(packBytes: Uint8Array): string {
    let cacheDir: string | undefined;
    try { cacheDir = Deno.env.get('CTS_CACHE_DIR') || undefined; } catch {}
    if (!cacheDir) {
        let home = '';
        try { home = Deno.env.get('HOME') ?? ''; } catch {}
        cacheDir = join(home, '.cts');
    }
    const hash = nativeCrypto.hexEncode(nativeCrypto.sha256(packBytes));
    return join(cacheDir, 'pack-extract', hash);
}

function corruptExtractedFile(packBytes: Uint8Array, nameSuffix: string, from: string, to: string): void {
    const extractDir = packExtractDir(packBytes);
    let corrupted = 0;
    for (const entry of Deno.readDirSync(extractDir)) {
        if (!entry.isFile || !entry.name.endsWith(nameSuffix)) continue;
        const path = join(extractDir, entry.name);
        const bytes = new Uint8Array(readFileSync(path));
        replaceAsciiOnce(bytes, from, to);
        writeFileSync(path, bytes);
        corrupted++;
    }
    if (corrupted === 0) throw new Error(`Could not find extracted *${nameSuffix} in ${extractDir}`);
}

function corruptExtractedPayload(packBytes: Uint8Array): void {
    corruptExtractedFile(packBytes, '-payload.ts', 'PACK_ATTRIBUTE_SOURCE', 'PACK_ATTRIBUTE_TAMPER');
}

async function runCno(args: string[], cwd: string): Promise<{ code: number; output: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        env: {
            ALL_PROXY: '', HTTPS_PROXY: '', HTTP_PROXY: '',
            all_proxy: '', https_proxy: '', http_proxy: '',
            NO_PROXY: '*', no_proxy: '*',
        },
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        output: decoder.decode(output.stdout) + decoder.decode(output.stderr),
    };
}

function writeMixedProject(root: string): void {
    mkdirSync(join(root, 'lib'), { recursive: true });

    writeFileSync(join(root, 'data.json'), JSON.stringify({ greeting: 'hello from json' }));

    writeFileSync(join(root, 'lib', 'inner.cjs'), `module.exports = { prefix: () => 'CJS-Hello' };\n`);

    writeFileSync(join(root, 'lib', 'greet.cjs'), `
const inner = require('./inner.cjs');
module.exports = { cjsGreet: (name) => \`\${inner.prefix()}, \${name} (via cjs)\` };
`.trimStart());

    writeFileSync(join(root, 'lib', 'esm-helper.ts'), `
import data from '../data.json' with { type: 'json' };
export function esmGreet(name: string): string {
    return \`\${data.greeting}, \${name} (via esm)\`;
}
`.trimStart());

    writeFileSync(join(root, 'lib', 'dynamic-mod.ts'), `export const dynamicMessage = 'hello from dynamic import';\n`);
    writeFileSync(join(root, 'lib', 'hidden.ts'), `export const hidden = true;\n`);

    writeFileSync(join(root, 'entry.ts'), `
import { esmGreet } from './lib/esm-helper.ts';
import * as greetMod from './lib/greet.cjs';
import dataValue from 'data:text/javascript,export default "DATA_OK"';
import { basename as pathBasename } from 'node:path';

async function main() {
    console.log(esmGreet('world'));
    console.log(dataValue, pathBasename('/pack/node/path.txt'));

    const cjsGreet = (greetMod as any).cjsGreet ?? (greetMod as any).default?.cjsGreet;
    console.log(cjsGreet('world'));

    const dyn = await import('./lib/dynamic-mod.ts');
    console.log(dyn.dynamicMessage);

    try {
        const unresolvableId = ['hidden'].join('');
        await import('./lib/' + unresolvableId + '.ts');
        console.log('ERROR: unresolvable dynamic import unexpectedly succeeded');
    } catch (e) {
        console.log('caught expected pack resolution error');
    }

    console.log('DONE');
}

main();
`.trimStart());
}

Deno.test({ name: 'pack command: packs a mixed ESM/CJS/JSON project and runs from a different directory', timeout: 120000 }, async () => {
    const projectDir = makePosixTempDir('pack-project');
    const runDir = makePosixTempDir('pack-rundir');
    try {
        writeMixedProject(projectDir);

        const packResult = await runCno(['pack', 'entry.ts', '-o', 'app.jspack'], projectDir);
        strictEqual(packResult.code, 0, packResult.output);
        strictEqual(packResult.output.includes(join(projectDir, 'app.jspack')), true, packResult.output);
        strictEqual(/Packed \d+ modules \([\d.]+[KMG]?B\)/.test(packResult.output), true, packResult.output);
        strictEqual(packResult.output.includes('✅'), false, 'pack should print one final module summary');
        strictEqual(existsSync(join(projectDir, 'cts.lock')), false, 'pack must not persist project lock state');

        const secondPack = await runCno(['pack', 'entry.ts', '-q', '-o', 'app-repeat.jspack'], projectDir);
        strictEqual(secondPack.code, 0, secondPack.output);
        const firstBytes = new Uint8Array(readFileSync(join(projectDir, 'app.jspack')));
        const secondBytes = new Uint8Array(readFileSync(join(projectDir, 'app-repeat.jspack')));
        deepStrictEqual(secondBytes, firstBytes, 'identical inputs must produce byte-for-byte reproducible packs');
        strictEqual(containsAscii(firstBytes, projectDir), false,
            'the complete artifact must not leak the pack-time project path');

        // Move the .jspack container to a directory with none of the original
        // source files, proving it carries no dependency on the pack-time paths.
        const packedPath = join(projectDir, 'app.jspack');
        const relocatedPath = join(runDir, 'app.jspack');
        Deno.copyFileSync(packedPath, relocatedPath);

        const runResult = await runCno([relocatedPath], runDir);
        strictEqual(runResult.code, 0, runResult.output);
        strictEqual(runResult.output.includes('hello from json, world (via esm)'), true, runResult.output);
        strictEqual(runResult.output.includes('DATA_OK path.txt'), true, runResult.output);
        strictEqual(runResult.output.includes('CJS-Hello, world (via cjs)'), true, runResult.output);
        strictEqual(runResult.output.includes('hello from dynamic import'), true, runResult.output);
        strictEqual(runResult.output.includes('caught expected pack resolution error'), true, runResult.output);
        strictEqual(runResult.output.includes('DONE'), true, runResult.output);
        strictEqual(runResult.output.includes('ERROR:'), false, runResult.output);

        const decoded = decodePack(new Uint8Array(readFileSync(packedPath)));
        strictEqual(Object.keys(decoded.manifest.modules).some(id => id.startsWith('pack:node/')), false,
            'runtime-provided node modules must not enter the container');
        decoded.manifest.bytecodeVersion = 'incompatible-review-abi';
        const sourceFallbackPath = join(runDir, 'source-fallback.jspack');
        writeFileSync(sourceFallbackPath, encodePack(decoded.manifest, decoded.blob));
        const fallbackResult = await runCno([sourceFallbackPath], runDir);
        strictEqual(fallbackResult.code, 0, fallbackResult.output);
        strictEqual(fallbackResult.output.includes('DONE'), true, fallbackResult.output);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
    }
});

Deno.test({ name: 'pack command: preserves query/hash identities and source import-attribute views', timeout: 120000 }, async () => {
    const projectDir = makePosixTempDir('pack-identities');
    const runDir = makePosixTempDir('pack-identities-run');
    try {
        writeFileSync(join(projectDir, 'counter.ts'), `
const next = Number(Reflect.get(globalThis, '__packQueryCount') ?? 0) + 1;
Reflect.set(globalThis, '__packQueryCount', next);
export const value = next;
`.trimStart());
        writeFileSync(join(projectDir, 'payload.ts'), `export const payloadMarker: string = 'PACK_ATTRIBUTE_SOURCE';\n`);
        writeFileSync(join(projectDir, 'attribute.cjs'), `
module.exports = async function () {
    const { default: text } = await import('./payload.ts', { with: { type: 'text' } });
    return text.includes('PACK_ATTRIBUTE_SOURCE');
};
`.trimStart());
        writeFileSync(join(projectDir, 'entry.ts'), `
import { value as query } from './counter.ts?query';
import { value as hash } from './counter.ts#hash';
import { payloadMarker as queryCollision } from './payload.ts#cts-view=text';
import text from './payload.ts' with { type: 'text' };
import bytes from './payload.ts' with { type: 'bytes' };
import cjsAttribute from './attribute.cjs';

console.log('IDENTITIES', query, hash);
console.log('QUERY_COLLISION', queryCollision);
console.log('ATTR_TEXT', text.includes('PACK_ATTRIBUTE_SOURCE'));
console.log('ATTR_BYTES', new TextDecoder().decode(bytes).includes('PACK_ATTRIBUTE_SOURCE'));
console.log('ATTR_CJS', await cjsAttribute());
`.trimStart());

        const packed = await runCno(['pack', 'entry.ts', '-o', 'nested/out.jspack', '--no-oxc'], projectDir);
        strictEqual(packed.code, 0, packed.output);
        strictEqual(existsSync(join(projectDir, 'nested', 'out.jspack')), true);
        const decoded = decodePack(new Uint8Array(readFileSync(join(projectDir, 'nested', 'out.jspack'))));
        const counterEntries = Object.entries(decoded.manifest.modules)
            .filter(([id]) => id.startsWith('pack:/counter.ts'))
            .map(([, entry]) => entry);
        strictEqual(counterEntries.length, 2);
        strictEqual(counterEntries[0]!.sourceOffset, counterEntries[1]!.sourceOffset,
            'query/hash variants should share original source bytes');
        Deno.copyFileSync(join(projectDir, 'nested', 'out.jspack'), join(runDir, 'out.jspack'));
        const packedBytes = new Uint8Array(readFileSync(join(runDir, 'out.jspack')));

        // Run twice against the same extracted container. Import-attribute modules
        // must stay source-only even after the first run has warmed normal caches.
        for (let run = 0; run < 2; run++) {
            const result = await runCno([join(runDir, 'out.jspack')], runDir);
            strictEqual(result.code, 0, result.output);
            strictEqual(result.output.includes('IDENTITIES 1 2'), true, result.output);
            strictEqual(result.output.includes('QUERY_COLLISION PACK_ATTRIBUTE_SOURCE'), true, result.output);
            strictEqual(result.output.includes('ATTR_TEXT true'), true, result.output);
            strictEqual(result.output.includes('ATTR_BYTES true'), true, result.output);
            strictEqual(result.output.includes('ATTR_CJS true'), true, result.output);
            if (run === 0) corruptExtractedPayload(packedBytes);
        }
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
    }
});

Deno.test({ name: 'pack command: help and quiet mode are useful and side-effect free', timeout: 60000 }, async () => {
    const projectDir = makePosixTempDir('pack-help-quiet');
    try {
        const help = await runCno(['pack', '--help'], projectDir);
        strictEqual(help.code, 0, help.output);
        strictEqual(help.output.includes('cno pack <entry>'), true, help.output);
        strictEqual(help.output.includes('--cached-only'), true, help.output);

        writeFileSync(join(projectDir, 'entry.ts'), `console.log('quiet pack');\n`);
        const quiet = await runCno(['pack', 'entry.ts', '-q', '-o', 'quiet.jspack', '--no-oxc'], projectDir);
        strictEqual(quiet.code, 0, quiet.output);
        strictEqual(quiet.output, '');
        strictEqual(existsSync(join(projectDir, 'quiet.jspack')), true);
        strictEqual(existsSync(join(projectDir, 'cts.lock')), false);

        writeFileSync(join(projectDir, '--dash.ts'), `console.log('dash entry');\n`);
        const dashEntry = await runCno(['pack', '-q', '-o', 'dash.jspack', '--', '--dash.ts'], projectDir);
        strictEqual(dashEntry.code, 0, dashEntry.output);
        strictEqual(existsSync(join(projectDir, 'dash.jspack')), true);

        const remoteEntry = await runCno([
            'pack', 'data:text/javascript,export%20default%20%22REMOTE_PACK%22', '-q', '--no-oxc',
        ], projectDir);
        strictEqual(remoteEntry.code, 0, remoteEntry.output);
        strictEqual(existsSync(join(projectDir, 'data-module.jspack')), true);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
    }
});

Deno.test({ name: 'pack runtime: concurrent first extraction is atomic', timeout: 60000 }, async () => {
    const projectDir = makePosixTempDir('pack-concurrent-project');
    const runDir = makePosixTempDir('pack-concurrent-run');
    try {
        writeFileSync(join(projectDir, 'entry.ts'), `console.log('CONCURRENT_PACK_OK');\n`);
        const packed = await runCno(['pack', 'entry.ts', '-q', '-o', 'app.jspack', '--no-oxc'], projectDir);
        strictEqual(packed.code, 0, packed.output);
        const artifact = join(projectDir, 'app.jspack');
        const cacheDir = join(runDir, 'fresh-cache');
        const results = await Promise.all(Array.from({ length: 4 }, () =>
            runCno([`--cache-dir=${cacheDir}`, artifact], runDir)));
        for (const result of results) {
            strictEqual(result.code, 0, result.output);
            strictEqual(result.output.includes('CONCURRENT_PACK_OK'), true, result.output);
        }
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
    }
});

Deno.test({ name: 'pack command: extensionless entries match run language defaults', timeout: 60000 }, async () => {
    const projectDir = makePosixTempDir('pack-extensionless');
    const runDir = makePosixTempDir('pack-extensionless-run');
    try {
        writeFileSync(join(projectDir, 'dep.ts'), `export const value: string = 'EXTENSIONLESS_TS';\n`);
        writeFileSync(join(projectDir, 'script'), `#!/usr/bin/env cno\nimport { value } from './dep.ts';\nconst typed: string = value;\nconsole.log(typed);\n`);

        const packed = await runCno(['pack', 'script', '-o', 'script.jspack', '--no-oxc'], projectDir);
        strictEqual(packed.code, 0, packed.output);
        Deno.copyFileSync(join(projectDir, 'script.jspack'), join(runDir, 'script.jspack'));
        const result = await runCno([join(runDir, 'script.jspack')], runDir);
        strictEqual(result.code, 0, result.output);
        strictEqual(result.output.includes('EXTENSIONLESS_TS'), true, result.output);

        const fallback = decodePack(new Uint8Array(readFileSync(join(projectDir, 'script.jspack'))));
        fallback.manifest.bytecodeVersion = 'incompatible-extensionless-abi';
        writeFileSync(join(runDir, 'script-fallback.jspack'), encodePack(fallback.manifest, fallback.blob));
        const fallbackResult = await runCno([join(runDir, 'script-fallback.jspack')], runDir);
        strictEqual(fallbackResult.code, 0, fallbackResult.output);
        strictEqual(fallbackResult.output.includes('EXTENSIONLESS_TS'), true, fallbackResult.output);

        writeFileSync(join(projectDir, 'plain'), `console.log('EXTENSIONLESS_JS');\n`);
        const jsPacked = await runCno(['pack', 'plain', '--ext=js', '-o', 'plain.jspack', '--no-oxc'], projectDir);
        strictEqual(jsPacked.code, 0, jsPacked.output);
        Deno.copyFileSync(join(projectDir, 'plain.jspack'), join(runDir, 'plain.jspack'));
        const jsResult = await runCno([join(runDir, 'plain.jspack')], runDir);
        strictEqual(jsResult.code, 0, jsResult.output);
        strictEqual(jsResult.output.includes('EXTENSIONLESS_JS'), true, jsResult.output);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
    }
});

Deno.test({ name: 'pack command: loads configuration from a nested entry project', timeout: 60000 }, async () => {
    const outerDir = makePosixTempDir('pack-config-outer');
    const projectDir = join(outerDir, 'project');
    const runDir = makePosixTempDir('pack-config-run');
    try {
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, 'deno.json'), JSON.stringify({ imports: { 'configured-dep': './dep.ts' } }));
        writeFileSync(join(projectDir, 'dep.ts'), `export const configured = 'CONFIG_OK';\n`);
        writeFileSync(join(outerDir, 'shared.ts'), `export const shared = 'OUTSIDE_ROOT_OK';\n`);
        writeFileSync(join(projectDir, 'entry.ts'), `
import { configured } from 'configured-dep';
import { shared } from '../shared.ts';
console.log(configured, shared);
`.trimStart());

        const packed = await runCno(['pack', 'project/entry.ts', '-o', 'configured.jspack', '--no-oxc'], outerDir);
        strictEqual(packed.code, 0, packed.output);
        const decoded = decodePack(new Uint8Array(readFileSync(join(outerDir, 'configured.jspack'))));
        strictEqual(JSON.stringify(decoded.manifest).includes(outerDir), false, 'manifest leaked the pack-time absolute path');
        Deno.copyFileSync(join(outerDir, 'configured.jspack'), join(runDir, 'configured.jspack'));
        const result = await runCno([join(runDir, 'configured.jspack')], runDir);
        strictEqual(result.code, 0, result.output);
        strictEqual(result.output.includes('CONFIG_OK'), true, result.output);
        strictEqual(result.output.includes('OUTSIDE_ROOT_OK'), true, result.output);
    } finally {
        Deno.removeSync(outerDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
    }
});

Deno.test({ name: 'pack command: includes local npm CJS packages and nested dependencies', timeout: 120000 }, async () => {
    const projectDir = makePosixTempDir('pack-local-npm');
    const runDir = makePosixTempDir('pack-local-npm-run');
    try {
        const pkgDir = join(projectDir, 'node_modules', 'pack-parent');
        const childDir = join(pkgDir, 'node_modules', 'pack-child');
        mkdirSync(childDir, { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'pack-parent', version: '1.0.0', main: 'index.cjs',
            dependencies: { 'pack-child': '1.0.0' },
        }));
        writeFileSync(join(pkgDir, 'index.cjs'), `module.exports = require('pack-child') + ':parent';\n`);
        writeFileSync(join(childDir, 'package.json'), JSON.stringify({
            name: 'pack-child', version: '1.0.0', main: 'index.cjs',
        }));
        writeFileSync(join(childDir, 'index.cjs'), `module.exports = 'child';\n`);
        writeFileSync(join(projectDir, 'entry.ts'), `import value from 'pack-parent'; console.log('LOCAL_NPM', value);\n`);

        const packed = await runCno(['pack', 'entry.ts', '-o', 'npm.jspack', '--no-oxc'], projectDir);
        strictEqual(packed.code, 0, packed.output);
        Deno.copyFileSync(join(projectDir, 'npm.jspack'), join(runDir, 'npm.jspack'));
        const result = await runCno([join(runDir, 'npm.jspack')], runDir);
        strictEqual(result.code, 0, result.output);
        strictEqual(result.output.includes('LOCAL_NPM child:parent'), true, result.output);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
    }
});

Deno.test({ name: 'pack command: rejects incomplete CJS graphs and invalid CLI output arguments', timeout: 60000 }, async () => {
    const projectDir = makePosixTempDir('pack-invalid-cli');
    try {
        const entry = join(projectDir, 'entry.cjs');
        writeFileSync(entry, `require('./missing.cjs');\n`);

        const missingDep = await runCno(['pack', 'entry.cjs', '-o', 'out.jspack', '--no-oxc'], projectDir);
        strictEqual(missingDep.code !== 0, true, missingDep.output);
        strictEqual(missingDep.output.includes('missing.cjs'), true, missingDep.output);
        strictEqual(existsSync(join(projectDir, 'out.jspack')), false);

        const missingOut = await runCno(['pack', 'entry.cjs', '-o', '--no-oxc'], projectDir);
        strictEqual(missingOut.code !== 0, true, missingOut.output);
        strictEqual(missingOut.output.includes('requires a file path'), true, missingOut.output);

        const multiple = await runCno(['pack', 'entry.cjs', 'other.cjs'], projectDir);
        strictEqual(multiple.code !== 0, true, multiple.output);
        strictEqual(multiple.output.includes('exactly one entry'), true, multiple.output);

        const overwrite = await runCno(['pack', 'entry.cjs', '-o', 'entry.cjs'], projectDir);
        strictEqual(overwrite.code !== 0, true, overwrite.output);
        strictEqual(overwrite.output.includes('must not overwrite'), true, overwrite.output);
        strictEqual(new TextDecoder().decode(readFileSync(entry)).includes('missing.cjs'), true);

        const wrongExtension = await runCno(['pack', 'entry.cjs', '-o', 'entry.bin'], projectDir);
        strictEqual(wrongExtension.code !== 0, true, wrongExtension.output);
        strictEqual(wrongExtension.output.includes('must end with .jspack'), true, wrongExtension.output);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
    }
});

Deno.test({ name: 'pack runtime: validates blob bounds and contains hostile module ids', timeout: 60000 }, async () => {
    const root = makePosixTempDir('pack-hostile');
    const target = join(root, '..', `pack-path-traversal-${Date.now()}.json`);
    try {
        const payload = new TextEncoder().encode('{"safe":true}');
        const hostileId = `pack:/../../../../../../${target.replace(/^\//, '')}`;
        const manifest: PackManifest = {
            entry: hostileId,
            modules: {
                [hostileId]: {
                    localPath: hostileId,
                    format: 'esm',
                    fileKind: 'json',
                    offset: 0,
                    length: payload.byteLength,
                },
            },
            edges: {},
            bytecodeVersion: 'test',
        };
        const hostilePack = join(root, 'hostile.jspack');
        writeFileSync(hostilePack, encodePack(manifest, payload));
        const hostileResult = await runCno([hostilePack], root);
        strictEqual(hostileResult.code, 0, hostileResult.output);
        strictEqual(existsSync(target), false, 'hostile module id escaped the extraction directory');

        const invalidManifest = structuredClone(manifest);
        invalidManifest.modules[hostileId]!.offset = payload.byteLength + 1;
        throws(() => encodePack(invalidManifest, payload), /out of bounds/);

        const invalidMetadata = structuredClone(manifest);
        invalidMetadata.modules[hostileId]!.sourceOnly = true;
        throws(() => encodePack(invalidMetadata, payload), /non-source module has source metadata/);

        const invalidSpecifier = structuredClone(manifest);
        invalidSpecifier.edges[hostileId] = { ['bad\0specifier']: hostileId };
        throws(() => encodePack(invalidSpecifier, payload), /invalid edge/);

        const corruptBytes = encodePack(manifest, payload);
        replaceAsciiOnce(corruptBytes, '"offset":0', '"offset":9');
        const corruptPack = join(root, 'corrupt.jspack');
        writeFileSync(corruptPack, corruptBytes);
        const corruptResult = await runCno([corruptPack], root);
        strictEqual(corruptResult.code !== 0, true, corruptResult.output);
        strictEqual(corruptResult.output.includes('out of bounds'), true, corruptResult.output);
    } finally {
        try { Deno.removeSync(target); } catch {}
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test({ name: 'pack command: surfaces workspace compile failures and writes no artifact', timeout: 60000 }, async () => {
    const projectDir = makePosixTempDir('pack-badproject');
    try {
        // A reachable workspace file that cannot be transpiled — the pack must
        // fail loudly instead of silently dropping the module.
        writeFileSync(join(projectDir, 'broken.ts'), `export const x: = ;\n`);
        writeFileSync(join(projectDir, 'entry.ts'), `import { x } from './broken.ts';\nconsole.log(x);\n`);

        const out = join(projectDir, 'app.jspack');
        const packResult = await runCno(['pack', 'entry.ts', '-o', 'app.jspack', '--no-oxc'], projectDir);

        strictEqual(packResult.code !== 0, true, packResult.output);
        strictEqual(packResult.output.includes('broken.ts'), true, packResult.output);
        strictEqual(existsSync(out), false, 'no artifact should be written on compile failure');
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
    }
});

Deno.test({ name: 'pack runtime: heals same-length asset tamper and overwrites pack output atomically', timeout: 120000 }, async () => {
    const projectDir = makePosixTempDir('pack-asset-integrity');
    const runDir = makePosixTempDir('pack-asset-integrity-run');
    try {
        writeFileSync(join(projectDir, 'marker.json'), JSON.stringify({ tag: 'ASSET_MARKER_OK__' }));
        writeFileSync(join(projectDir, 'entry.ts'), `
import data from './marker.json' with { type: 'json' };
console.log('ASSET_JSON', data.tag);
`.trimStart());

        const packed = await runCno(['pack', 'entry.ts', '-q', '-o', 'asset.jspack', '--no-oxc'], projectDir);
        strictEqual(packed.code, 0, packed.output);
        // Re-pack onto the same path: writer must replace via temp+fsync+rename
        // (Windows-style non-overwriting rename is handled by unlink+retry).
        const repacked = await runCno(['pack', 'entry.ts', '-q', '-o', 'asset.jspack', '--no-oxc'], projectDir);
        strictEqual(repacked.code, 0, repacked.output);
        const first = new Uint8Array(readFileSync(join(projectDir, 'asset.jspack')));
        const second = new Uint8Array(readFileSync(join(projectDir, 'asset.jspack')));
        deepStrictEqual(second, first);

        Deno.copyFileSync(join(projectDir, 'asset.jspack'), join(runDir, 'asset.jspack'));
        const packBytes = new Uint8Array(readFileSync(join(runDir, 'asset.jspack')));
        const decoded = decodePack(packBytes);
        strictEqual(typeof encodePackHeader === 'function', true);
        strictEqual(typeof readBlob === 'function', true);
        strictEqual(typeof readSourceBlob === 'function', true);
        const entry = decoded.manifest.modules[decoded.manifest.entry];
        strictEqual(entry?.fileKind, 'source');

        const warm = await runCno([join(runDir, 'asset.jspack')], runDir);
        strictEqual(warm.code, 0, warm.output);
        strictEqual(warm.output.includes('ASSET_JSON ASSET_MARKER_OK__'), true, warm.output);

        corruptExtractedFile(packBytes, '-marker.json', 'ASSET_MARKER_OK__', 'ASSET_MARKER_BAD_');
        const healed = await runCno([join(runDir, 'asset.jspack')], runDir);
        strictEqual(healed.code, 0, healed.output);
        strictEqual(healed.output.includes('ASSET_JSON ASSET_MARKER_OK__'), true, healed.output);
        strictEqual(healed.output.includes('ASSET_MARKER_BAD_'), false, healed.output);

        // Destination-exists replace path: leave a stale extract file, delete
        // .complete, and ensure the next load still heals content (not size).
        const extractDir = packExtractDir(packBytes);
        let markerPath = '';
        for (const entry of Deno.readDirSync(extractDir)) {
            if (entry.isFile && entry.name.endsWith('-marker.json')) {
                markerPath = join(extractDir, entry.name);
                break;
            }
        }
        strictEqual(markerPath !== '', true, 'marker extract missing');
        writeFileSync(markerPath, new TextEncoder().encode(JSON.stringify({ tag: 'ASSET_MARKER_BAD_' })));
        try { unlinkSync(join(extractDir, '.complete')); } catch {}
        const afterStale = await runCno([join(runDir, 'asset.jspack')], runDir);
        strictEqual(afterStale.code, 0, afterStale.output);
        strictEqual(afterStale.output.includes('ASSET_JSON ASSET_MARKER_OK__'), true, afterStale.output);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
    }
});
