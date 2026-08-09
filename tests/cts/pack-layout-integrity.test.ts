/**
 * Blob-layout integrity gates for .jspack containers.
 *
 * These drive decodePack/encodePack directly from the TypeScript on disk (no
 * `cno.exe` spawn), so they exercise cts/src/pack/format.ts as edited.
 *
 * The property under test: a container may not describe a blob layout that the
 * writer cannot produce. BlobBuilder only appends whole buffers and dedupes by
 * local path, so declared ranges are byte-identical or disjoint — never partly
 * overlapping, and a source module's bytecode is never shared. Aliasing bytecode
 * is what makes this load-bearing rather than cosmetic: pointing one module's
 * bytecode range at another module's bytecode makes the runtime execute the
 * second module's body, and export its bindings, under the first module's id,
 * while the first module's untouched source still sits in the blob for anyone
 * auditing the artifact.
 */
import { ok, strictEqual, throws } from 'node:assert';
import {
    blobSourceFromBytes,
    completePackManifest,
    decodePack,
    encodePack,
    type PackManifest,
    type PackModuleEntry,
} from '../../cts/src/api/index.ts';

const crypto = import.meta.use('crypto');
const encoder = new TextEncoder();

/** Assemble a container without going through encodePack's validation, the way
 *  a tamperer would:
 *  [magic][u16 version=4][u32 manifestLen][32B manifestDigest][manifest][blob].
 *
 *  The digests ARE computed correctly (via the real completePackManifest), so
 *  these cases reach the layout checks they are about instead of stopping at a
 *  digest error. A tamperer recomputes digests too — that is exactly why the
 *  layout invariants below still have to be enforced independently. */
function rawPack(manifest: unknown, blob: Uint8Array): Uint8Array {
    const completed = completePackManifest(manifest as PackManifest, blobSourceFromBytes(blob));
    const manifestBytes = encoder.encode(JSON.stringify(completed));
    const out = new Uint8Array(42 + manifestBytes.byteLength + blob.byteLength);
    const view = new DataView(out.buffer);
    out.set([0x4a, 0x53, 0x50, 0x4b], 0); // "JSPK"
    view.setUint16(4, 4, true);
    view.setUint32(6, manifestBytes.byteLength, true);
    out.set(new Uint8Array(crypto.sha256(manifestBytes)), 10);
    out.set(manifestBytes, 42);
    out.set(blob, 42 + manifestBytes.byteLength);
    return out;
}

function sourceEntry(id: string, offset: number, length: number, sourceOffset: number, sourceLength: number): PackModuleEntry {
    return { localPath: id, format: 'esm', fileKind: 'source', offset, length, sourceOffset, sourceLength };
}

/** Two source modules, each with its own bytecode and its own source bytes.
 *  Blob layout: [src a][src b][bc a][bc b] over 40 bytes. */
function twoModuleManifest(): PackManifest {
    return {
        entry: 'pack:/a.ts',
        bytecodeVersion: 'layout-test-abi',
        modules: {
            'pack:/a.ts': sourceEntry('pack:/a.ts', 20, 10, 0, 10),
            'pack:/b.ts': sourceEntry('pack:/b.ts', 30, 10, 10, 10),
        },
        edges: { 'pack:/a.ts': { './b.ts': 'pack:/b.ts' } },
    };
}

const BLOB40 = new Uint8Array(40);

Deno.test('pack layout: a writer-shaped container still decodes', () => {
    const manifest = twoModuleManifest();
    const decoded = decodePack(rawPack(manifest, BLOB40));
    strictEqual(decoded.manifest.entry, 'pack:/a.ts');
    strictEqual(Object.keys(decoded.manifest.modules).length, 2);
    strictEqual(decoded.blob.byteLength, 40);
    // encodePack validates too, so a legal manifest must survive a round trip.
    const round = decodePack(encodePack(manifest, BLOB40));
    strictEqual(round.manifest.modules['pack:/b.ts']!.offset, 30);
});

Deno.test('pack layout: one module may not claim another module bytecode', () => {
    const manifest = twoModuleManifest();
    // The substitution: a.ts keeps its own source bytes, but its bytecode range
    // now addresses b.ts's bytecode. Both ranges stay inside the blob, so every
    // per-entry bounds check still passes.
    manifest.modules['pack:/a.ts']!.offset = 30;
    manifest.modules['pack:/a.ts']!.length = 10;
    throws(() => decodePack(rawPack(manifest, BLOB40)), (e: Error) => {
        ok(/same bytecode range/.test(e.message), `unexpected message: ${e.message}`);
        ok(e.message.includes('pack:/a.ts') && e.message.includes('pack:/b.ts'), e.message);
        return true;
    });
    // encodePack must refuse to write one, not just refuse to read it.
    throws(() => encodePack(manifest, BLOB40), /same bytecode range/);
});

Deno.test('pack layout: bytecode may not address embedded source bytes', () => {
    const manifest = twoModuleManifest();
    manifest.modules['pack:/a.ts']!.offset = 10; // b.ts's source range
    manifest.modules['pack:/a.ts']!.length = 10;
    throws(() => decodePack(rawPack(manifest, BLOB40)), /points its bytecode at embedded source bytes/);

    // Its own source range is equally impossible: separate appends.
    const own = twoModuleManifest();
    own.modules['pack:/a.ts']!.offset = 0;
    own.modules['pack:/a.ts']!.length = 10;
    throws(() => decodePack(rawPack(own, BLOB40)), /points its bytecode at embedded source bytes/);
});

Deno.test('pack layout: partial overlap and nesting are rejected', () => {
    const shifted = twoModuleManifest();
    shifted.modules['pack:/b.ts']!.offset = 25; // straddles a.ts's bytecode
    throws(() => decodePack(rawPack(shifted, BLOB40)), /overlaps/);

    const nested = twoModuleManifest();
    nested.modules['pack:/b.ts']!.offset = 22; // fully inside a.ts's bytecode
    nested.modules['pack:/b.ts']!.length = 4;
    throws(() => decodePack(rawPack(nested, BLOB40)), /overlaps/);

    const sourceStraddle = twoModuleManifest();
    sourceStraddle.modules['pack:/b.ts']!.sourceOffset = 5;
    throws(() => decodePack(rawPack(sourceStraddle, BLOB40)), /overlaps/);
});

Deno.test('pack layout: legitimate dedup and empty files still decode', () => {
    // Two ids for one file — `a.ts` and `a.ts?v=1` — share one source range but
    // are compiled separately, so bytecode ranges differ. This is exactly what
    // the writer emits, and it must not trip the aliasing checks.
    const shared: PackManifest = {
        entry: 'pack:/a.ts',
        bytecodeVersion: 'layout-test-abi',
        modules: {
            'pack:/a.ts': sourceEntry('pack:/a.ts', 20, 10, 0, 10),
            'pack:/a.ts?v=1': sourceEntry('pack:/a.ts?v=1', 30, 10, 0, 10),
        },
        edges: {},
    };
    strictEqual(Object.keys(decodePack(rawPack(shared, BLOB40)).manifest.modules).length, 2);

    // A non-source asset may alias a source module's bytes: the writer records
    // one raw range per local path and reuses it across ids.
    const asset: PackManifest = {
        entry: 'pack:/a.ts',
        bytecodeVersion: 'layout-test-abi',
        modules: {
            'pack:/a.ts': sourceEntry('pack:/a.ts', 20, 10, 0, 10),
            'pack:/a.txt': { localPath: 'pack:/a.txt', format: 'esm', fileKind: 'text', offset: 0, length: 10 },
        },
        edges: {},
    };
    ok(decodePack(rawPack(asset, BLOB40)).manifest.modules['pack:/a.txt']);

    // Empty source file: a 0-length range addresses no bytes, so it may sit at
    // the same offset as a real payload without aliasing it.
    const empty: PackManifest = {
        entry: 'pack:/a.ts',
        bytecodeVersion: 'layout-test-abi',
        modules: {
            'pack:/a.ts': sourceEntry('pack:/a.ts', 20, 10, 0, 10),
            'pack:/empty.ts': sourceEntry('pack:/empty.ts', 30, 10, 20, 0),
        },
        edges: {},
    };
    strictEqual(decodePack(rawPack(empty, BLOB40)).manifest.modules['pack:/empty.ts']!.sourceLength, 0);
});
