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
import { moduleViewRef } from '../../cts/src/types.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const nativeCrypto = import.meta.use('crypto');

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

function packExtractDir(packBytes: Uint8Array): string {
    let cacheDir: string | undefined;
    try { cacheDir = Deno.env.get('CTS_CACHE_DIR') || undefined; } catch { /* */ }
    if (!cacheDir) {
        let home = '';
        try { home = Deno.env.get('HOME') ?? ''; } catch { /* */ }
        cacheDir = join(home, '.cts');
    }
    const hash = nativeCrypto.hexEncode(nativeCrypto.sha256(packBytes));
    return join(cacheDir, 'pack-extract', hash);
}

function replaceAsciiOnce(bytes: Uint8Array, from: string, to: string): void {
    const needle = encoder.encode(from);
    const replacement = encoder.encode(to);
    strictEqual(replacement.byteLength, needle.byteLength);
    outer: for (let i = 0; i <= bytes.byteLength - needle.byteLength; i++) {
        for (let j = 0; j < needle.byteLength; j++) {
            if (bytes[i + j] !== needle[j]) continue outer;
        }
        bytes.set(replacement, i);
        return;
    }
    throw new Error(`Could not find ${from}`);
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
    name: 'pack hazards: sourceOnly modules, ABI fallback, and same-length source tamper heal',
    timeout: 120000,
}, async () => {
    const projectDir = makePosixTempDir('pack-hazard-proj');
    const runDir = makePosixTempDir('pack-hazard-run');
    try {
        writeFileSync(join(projectDir, 'payload.ts'), `export const marker: string = 'HAZARD_SOURCE_OK_';\n`);
        writeFileSync(join(projectDir, 'entry.ts'), `
import text from './payload.ts' with { type: 'text' };
import { marker } from './payload.ts';
console.log('VIEW', text.includes('HAZARD_SOURCE_OK_'));
console.log('SRC', marker);
console.log('DONE');
`.trimStart());

        const packed = await runCno(['pack', 'entry.ts', '-q', '-o', 'h.jspack', '--no-oxc'], projectDir);
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
        const warm = await runCno([join(runDir, 'h.jspack')], runDir);
        strictEqual(warm.code, 0, warm.output);
        strictEqual(warm.output.includes('VIEW true'), true, warm.output);
        strictEqual(warm.output.includes('SRC HAZARD_SOURCE_OK_'), true, warm.output);

        // Same-length tamper of extracted source must heal from container blob.
        const extractDir = packExtractDir(packBytes);
        let payloadPath = '';
        for (const ent of Deno.readDirSync(extractDir)) {
            if (ent.isFile && ent.name.includes('payload')) {
                payloadPath = join(extractDir, ent.name);
                break;
            }
        }
        ok(payloadPath, 'extracted payload missing');
        const original = new Uint8Array(readFileSync(payloadPath));
        const tampered = original.slice();
        replaceAsciiOnce(tampered, 'HAZARD_SOURCE_OK_', 'HAZARD_SOURCE_BAD');
        writeFileSync(payloadPath, tampered);
        ok(hasExpectedContent(payloadPath, tampered));
        ok(!hasExpectedContent(payloadPath, original), 'same-length tamper must fail full-byte check');

        const healed = await runCno([join(runDir, 'h.jspack')], runDir);
        strictEqual(healed.code, 0, healed.output);
        strictEqual(healed.output.includes('VIEW true'), true, healed.output);
        strictEqual(healed.output.includes('SRC HAZARD_SOURCE_OK_'), true, healed.output);
        strictEqual(healed.output.includes('HAZARD_SOURCE_BAD'), false, healed.output);

        // ABI mismatch: force source fallback path (still sourceOnly-safe).
        const abi: PackManifest = structuredClone(decoded.manifest);
        abi.bytecodeVersion = 'incompatible-hazard-abi';
        const abiPath = join(runDir, 'h-abi.jspack');
        writeFileSync(abiPath, encodePack(abi, decoded.blob));
        const abiRun = await runCno([abiPath], runDir);
        strictEqual(abiRun.code, 0, abiRun.output);
        strictEqual(abiRun.output.includes('VIEW true'), true, abiRun.output);
        strictEqual(abiRun.output.includes('DONE'), true, abiRun.output);

        // cno pack must not leave a project cts.lock (cache-owned side effect).
        strictEqual(existsSync(join(projectDir, 'cts.lock')), false);
    } finally {
        Deno.removeSync(projectDir, { recursive: true });
        Deno.removeSync(runDir, { recursive: true });
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
