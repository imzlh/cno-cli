/**
 * Pack hazard gates: full-byte extract integrity, attribute/view identity,
 * sourceOnly / ABI fallback. Drives shipped pack APIs + cno pack/run.
 */
import { ok, strictEqual } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import {
    decodePack,
    encodePack,
    bytesEqual,
    hasExpectedContent,
    safeExtractBaseName,
    type PackManifest,
} from '../../cts/src/api/index.ts';
import { attributeViewId, specScheme } from '../../cts/src/pack/identity.ts';
import { sizeBucketForModule, summarizePackSizes } from '../../cts/src/pack/size.ts';
import { moduleViewRef } from '../../cts/src/types.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function runCno(args: string[], cwd: string, cacheDir?: string): Promise<{ code: number; output: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const env: Record<string, string> = {
        ALL_PROXY: '', HTTPS_PROXY: '', HTTP_PROXY: '',
        all_proxy: '', https_proxy: '', http_proxy: '',
        NO_PROXY: '*', no_proxy: '*',
    };
    if (cacheDir) env.CTS_CACHE_DIR = cacheDir;
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        env,
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        output: decoder.decode(output.stdout) + decoder.decode(output.stderr),
    };
}

Deno.test('pack identity: attribute views use ctsview, not path suffixes', () => {
    const base = 'pack:/payload.ts';
    strictEqual(attributeViewId(base, 'source', { type: 'text' }), moduleViewRef(base, 'text'));
    strictEqual(attributeViewId(base, 'source', { type: 'bytes' }), moduleViewRef(base, 'binary'));
    strictEqual(attributeViewId(base, 'source', { type: 'json' }), moduleViewRef(base, 'json'));
    strictEqual(attributeViewId(base, 'source', undefined), base);
    strictEqual(specScheme('pack:/x'), 'pack');
    strictEqual(specScheme('npm:foo@1'), 'npm');
    strictEqual(specScheme('./rel'), null);
    strictEqual(specScheme('C:/win'), null);
});

Deno.test('pack size: buckets and unique-range aggregation', () => {
    strictEqual(sizeBucketForModule('pack:/src/entry.ts'), 'workspace');
    strictEqual(sizeBucketForModule('pack:/lib/util.ts?x=1'), 'workspace');
    strictEqual(sizeBucketForModule('pack:npm/lodash@4.17.21/index.js'), 'npm:lodash@4.17.21');
    strictEqual(sizeBucketForModule('pack:npm/@scope/pkg@1.0.0/dist/a.js'), 'npm:@scope/pkg@1.0.0');
    strictEqual(sizeBucketForModule('pack:jsr/@std/path@1.0.0/mod.ts'), 'jsr:@std/path@1.0.0');
    // Writer embeds https://host/path as pack:https///host/path
    strictEqual(sizeBucketForModule('pack:https///example.com/a/b.js'), 'https://example.com');
    strictEqual(sizeBucketForModule('pack:http///cdn.example/x.js?v=1'), 'http://cdn.example');
    strictEqual(sizeBucketForModule('pack:local/abc/file.ts'), 'local');

    // Shared source range must be counted once (bytecode + one source payload).
    const manifest: PackManifest = {
        entry: 'pack:/a.ts',
        bytecodeVersion: 'test',
        edges: {},
        modules: {
            'pack:/a.ts': {
                localPath: 'pack:/a.ts', format: 'esm', fileKind: 'source',
                offset: 0, length: 100, sourceOffset: 1000, sourceLength: 50,
            },
            'pack:/b.ts': {
                localPath: 'pack:/b.ts', format: 'esm', fileKind: 'source',
                offset: 100, length: 20, sourceOffset: 1000, sourceLength: 50,
            },
            'pack:npm/foo@1.0.0/index.js': {
                localPath: 'pack:npm/foo@1.0.0/index.js', format: 'esm', fileKind: 'source',
                offset: 200, length: 30, sourceOffset: 2000, sourceLength: 10,
            },
        },
    };
    const { total, rows } = summarizePackSizes(manifest);
    // 100 + 50 + 20 + 30 + 10 = 210 (shared source 50 once)
    strictEqual(total, 210);
    strictEqual(rows[0]!.name, 'workspace');
    strictEqual(rows[0]!.bytes, 170);
    strictEqual(rows[1]!.name, 'npm:foo@1.0.0');
    strictEqual(rows[1]!.bytes, 40);
});

Deno.test('pack integrity: full-byte compare rejects same-length tamper', () => {
    const dir = makePosixTempDir('pack-integrity-unit');
    try {
        const path = join(dir, '0-payload.ts');
        const good = encoder.encode('export const m = "PACK_GOOD_MARKER";\n');
        const bad = encoder.encode('export const m = "PACK_BAD__MARKER";\n');
        strictEqual(good.byteLength, bad.byteLength);
        writeFileSync(path, good);
        ok(hasExpectedContent(path, good));
        ok(!hasExpectedContent(path, bad));
        writeFileSync(path, bad);
        ok(!hasExpectedContent(path, good));
        ok(bytesEqual(good, good));
        ok(!bytesEqual(good, bad));
        strictEqual(safeExtractBaseName('pack:/../../etc/passwd', 3), '3-passwd');
        strictEqual(safeExtractBaseName('pack:/mod.ts?query', 0), '0-mod.ts');
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test({
    name: 'pack hazards: sourceOnly modules, ABI fallback, and memory-only load',
    timeout: 120000,
}, async () => {
    const projectDir = makePosixTempDir('pack-hazard-proj');
    const runDir = makePosixTempDir('pack-hazard-run');
    const cacheDir = makePosixTempDir('pack-hazard-cache');
    try {
        writeFileSync(join(projectDir, 'payload.ts'), `export const marker: string = 'HAZARD_SOURCE_OK_';\n`);
        writeFileSync(join(projectDir, 'entry.ts'), `
import text from './payload.ts' with { type: 'text' };
import { marker } from './payload.ts';
console.log('VIEW', text.includes('HAZARD_SOURCE_OK_'));
console.log('SRC', marker);
console.log('DONE');
`.trimStart());

        const packed = await runCno(['pack', 'entry.ts', '-q', '-o', 'h.jspack', '--no-oxc'], projectDir, cacheDir);
        strictEqual(packed.code, 0, packed.output);
        const packPath = join(projectDir, 'h.jspack');
        const packBytes = new Uint8Array(readFileSync(packPath));
        const decoded = decodePack(packBytes);

        // Modules whose *own* source contains import attributes must be
        // sourceOnly — serialized bytecode drops attribute semantics on the
        // importer, not on the attribute target (which becomes a ctsview:).
        const entryEntry = decoded.manifest.modules[decoded.manifest.entry];
        ok(entryEntry?.sourceOnly === true,
            `entry with import attributes must be sourceOnly: ${JSON.stringify(entryEntry)}`);
        const payloadEntries = Object.entries(decoded.manifest.modules)
            .filter(([id]) => id.includes('payload.ts'));
        ok(payloadEntries.length >= 1, 'payload module missing');

        Deno.copyFileSync(packPath, join(runDir, 'h.jspack'));
        const warm = await runCno([join(runDir, 'h.jspack')], runDir, cacheDir);
        strictEqual(warm.code, 0, warm.output);
        strictEqual(warm.output.includes('VIEW true'), true, warm.output);
        strictEqual(warm.output.includes('SRC HAZARD_SOURCE_OK_'), true, warm.output);
        strictEqual(existsSync(join(cacheDir, 'pack-extract')), false,
            'memory pack load must not create pack-extract');

        // ABI mismatch: force source fallback path (still sourceOnly-safe).
        const abi: PackManifest = structuredClone(decoded.manifest);
        abi.bytecodeVersion = 'incompatible-hazard-abi';
        const abiPath = join(runDir, 'h-abi.jspack');
        writeFileSync(abiPath, encodePack(abi, decoded.blob));
        const abiRun = await runCno([abiPath], runDir, cacheDir);
        strictEqual(abiRun.code, 0, abiRun.output);
        strictEqual(abiRun.output.includes('VIEW true'), true, abiRun.output);
        strictEqual(abiRun.output.includes('DONE'), true, abiRun.output);
        strictEqual(existsSync(join(cacheDir, 'pack-extract')), false);

        // cno pack must not leave a project cts.lock (cache-owned side effect).
        strictEqual(existsSync(join(projectDir, 'cts.lock')), false);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
        Deno.removeSync(cacheDir, { recursive: true });
    }
});

Deno.test({
    name: 'pack hazards: incomplete graph fails closed with no artifact',
    timeout: 60000,
}, async () => {
    const projectDir = makePosixTempDir('pack-hazard-incomplete');
    try {
        writeFileSync(join(projectDir, 'entry.ts'), `import './missing-mod.ts';\n`);
        const out = join(projectDir, 'out.jspack');
        const result = await runCno(['pack', 'entry.ts', '-o', 'out.jspack', '--no-oxc'], projectDir);
        strictEqual(result.code !== 0, true, result.output);
        strictEqual(result.output.includes('missing-mod'), true, result.output);
        strictEqual(existsSync(out), false);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
    }
});
