/**
 * Tamper-evidence gates for .jspack containers (format version 4).
 *
 * READ THIS BEFORE TRUSTING THESE TESTS FOR MORE THAN THEY PROVE.
 *
 * The digests these cases exercise are stored INSIDE the container they protect.
 * That establishes integrity — the bytes are the bytes the writer emitted — and
 * NOT authenticity. An attacker who rewrites the manifest recomputes the digests
 * too, and the result is perfectly self-consistent. The last test in this file
 * documents exactly that, deliberately, as a passing case: it asserts that a
 * fully-recomputed forgery still loads. That is the boundary of what this format
 * version claims, and closing it needs a trust anchor outside the artifact (a
 * signature, or a digest learned over another channel), which is not implemented.
 *
 * So what IS proven here: corruption, truncation, tail extension, a hex edit, a
 * substituted bytecode range, a stripped digest field, and a version downgrade
 * are all detected rather than executed. Before version 4, every one of those
 * ran attacker-controlled bytecode at exit 0 with no diagnostic.
 *
 * These drive decodePack/encodePack/readBlob against cts/src/pack/format.ts as
 * it sits on disk (no `cno.exe` spawn), so they exercise the source as edited.
 */
import { ok, strictEqual, throws } from 'node:assert';
import {
    blobSourceFromBytes,
    completePackManifest,
    decodePack,
    encodePack,
    readBlob,
    readSourceBlob,
    type PackContainer,
    type PackManifest,
} from '../../cts/src/api/index.ts';

const crypto = import.meta.use('crypto');
const encoder = new TextEncoder();

const HEADER_LEN = 42;
const MAGIC = [0x4a, 0x53, 0x50, 0x4b];

const sha256hex = (bytes: Uint8Array): string => crypto.hexEncode(crypto.sha256(bytes));

/** A realistic 3-module pack: two source modules (bytecode + fallback source)
 *  and one asset. Blob order mirrors the writer: sources and assets first, then
 *  all bytecode. The "bytecode" is opaque bytes — all the format sees. */
function fixture() {
    const srcA = encoder.encode('export const who = "SAFE";\n');
    const srcB = encoder.encode('export const helper = 1;\n');
    const asset = encoder.encode('{"marker":"ASSET_OK"}');
    const bcA = encoder.encode('<<BYTECODE-A-SAFE-BODY>>');
    const bcB = encoder.encode('<<BYTECODE-B>>');

    const parts = [srcA, srcB, asset, bcA, bcB];
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const blob = new Uint8Array(total);
    const at: Record<string, { offset: number; length: number }> = {};
    const names = ['srcA', 'srcB', 'asset', 'bcA', 'bcB'];
    let cursor = 0;
    parts.forEach((p, i) => {
        blob.set(p, cursor);
        at[names[i]!] = { offset: cursor, length: p.byteLength };
        cursor += p.byteLength;
    });

    const manifest: PackManifest = {
        entry: 'pack:/a.ts',
        modules: {
            'pack:/a.ts': {
                localPath: 'pack:/a.ts', format: 'esm', fileKind: 'source',
                offset: at.bcA!.offset, length: at.bcA!.length,
                sourceOffset: at.srcA!.offset, sourceLength: at.srcA!.length,
            },
            'pack:/b.ts': {
                localPath: 'pack:/b.ts', format: 'esm', fileKind: 'source',
                offset: at.bcB!.offset, length: at.bcB!.length,
                sourceOffset: at.srcB!.offset, sourceLength: at.srcB!.length,
            },
            'pack:/data.json': {
                localPath: 'pack:/data.json', format: 'esm', fileKind: 'json',
                offset: at.asset!.offset, length: at.asset!.length,
            },
        },
        edges: { 'pack:/a.ts': { './b.ts': 'pack:/b.ts' } },
        bytecodeVersion: 'tamper-test-abi',
    };
    return { bytes: encodePack(manifest, blob), manifest, blob, at };
}

/** Read every declared range, which is what forces the LAZY per-module digest
 *  checks to run. decodePack alone only proves the eager manifest digest. */
function loadAll(bytes: Uint8Array): PackContainer {
    const container = decodePack(bytes);
    for (const entry of Object.values(container.manifest.modules)) {
        readBlob(container, entry);
        if (entry.fileKind === 'source') readSourceBlob(container, entry);
    }
    return container;
}

/** Parse a container by hand, as someone holding only the artifact would. */
function parseRaw(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const manifestLength = view.getUint32(6, true);
    const manifestBytes = bytes.subarray(HEADER_LEN, HEADER_LEN + manifestLength);
    return {
        version: view.getUint16(4, true),
        manifestLength,
        headerDigest: bytes.subarray(10, 10 + 32),
        manifestBytes,
        manifest: JSON.parse(new TextDecoder().decode(manifestBytes)) as PackManifest,
        blob: bytes.subarray(HEADER_LEN + manifestLength),
    };
}

/** Reassemble a container from a manifest object and a blob, WITHOUT going
 *  through encodePack — no validation, no digest completion. opts.staleDigest
 *  keeps a supplied header digest instead of recomputing it. */
function rawWrite(
    manifest: unknown,
    blob: Uint8Array,
    opts: { version?: number; staleDigest?: Uint8Array } = {},
): Uint8Array {
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    const out = new Uint8Array(HEADER_LEN + manifestBytes.byteLength + blob.byteLength);
    const view = new DataView(out.buffer);
    out.set(MAGIC, 0);
    view.setUint16(4, opts.version ?? 4, true);
    view.setUint32(6, manifestBytes.byteLength, true);
    out.set(opts.staleDigest ?? new Uint8Array(crypto.sha256(manifestBytes)), 10);
    out.set(manifestBytes, HEADER_LEN);
    out.set(blob, HEADER_LEN + manifestBytes.byteLength);
    return out;
}

/** Write a version-3 container: the pre-digest layout, 10-byte header. */
function writeV3(manifest: unknown, blob: Uint8Array): Uint8Array {
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    const out = new Uint8Array(10 + manifestBytes.byteLength + blob.byteLength);
    const view = new DataView(out.buffer);
    out.set(MAGIC, 0);
    view.setUint16(4, 3, true);
    view.setUint32(6, manifestBytes.byteLength, true);
    out.set(manifestBytes, 10);
    out.set(blob, 10 + manifestBytes.byteLength);
    return out;
}

/** Rebuild the blob honoring per-entry overrides, recomputing every offset and
 *  length so all range checks still pass. This is the exact shape of the attack
 *  that executed at exit 0 against version 3. */
function rebuild(
    manifest: PackManifest,
    blob: Uint8Array,
    overrides: Record<string, { bytecode?: Uint8Array; source?: Uint8Array }>,
    opts: { refreshDigests?: boolean } = {},
): { manifest: PackManifest; blob: Uint8Array } {
    const chunks: Uint8Array[] = [];
    let cursor = 0;
    const push = (bytes: Uint8Array) => {
        const offset = cursor;
        chunks.push(bytes);
        cursor += bytes.byteLength;
        return { offset, length: bytes.byteLength };
    };
    const modules: Record<string, any> = {};
    const srcRange: Record<string, { offset: number; length: number }> = {};
    const srcBytes: Record<string, Uint8Array> = {};
    for (const [id, e] of Object.entries(manifest.modules)) {
        const ov = overrides[id] ?? {};
        const bytes = e.fileKind === 'source'
            ? (ov.source ?? blob.subarray(e.sourceOffset!, e.sourceOffset! + e.sourceLength!))
            : (ov.source ?? blob.subarray(e.offset, e.offset + e.length));
        srcBytes[id] = bytes;
        srcRange[id] = push(bytes);
    }
    for (const [id, e] of Object.entries(manifest.modules)) {
        const ov = overrides[id] ?? {};
        if (e.fileKind === 'source') {
            const bc = ov.bytecode ?? blob.subarray(e.offset, e.offset + e.length);
            const r = push(bc);
            modules[id] = {
                ...e, offset: r.offset, length: r.length,
                sourceOffset: srcRange[id]!.offset, sourceLength: srcRange[id]!.length,
                ...(opts.refreshDigests
                    ? { digest: sha256hex(bc), sourceDigest: sha256hex(srcBytes[id]!) }
                    : {}),
            };
        } else {
            modules[id] = {
                ...e, offset: srcRange[id]!.offset, length: srcRange[id]!.length,
                ...(opts.refreshDigests ? { digest: sha256hex(srcBytes[id]!) } : {}),
            };
        }
    }
    const blobOut = new Uint8Array(cursor);
    let at = 0;
    for (const c of chunks) { blobOut.set(c, at); at += c.byteLength; }
    return { manifest: { ...manifest, modules, blobLength: blobOut.byteLength }, blob: blobOut };
}

Deno.test('pack v4: an untampered container loads and carries digests', () => {
    const fx = fixture();
    const head = parseRaw(fx.bytes);
    strictEqual(head.version, 4, 'writer must emit version 4');
    strictEqual(head.blob.byteLength, fx.blob.byteLength);
    // The header digest must actually cover the manifest bytes.
    strictEqual(
        crypto.hexEncode(head.headerDigest),
        sha256hex(head.manifestBytes),
        'header digest must equal sha256 of the manifest bytes');
    // blobLength is declared, so truncation is checkable at all.
    strictEqual(head.manifest.blobLength, fx.blob.byteLength);
    // Every module carries a digest of its embedded bytes; source modules two.
    const a = head.manifest.modules['pack:/a.ts']!;
    strictEqual(a.digest, sha256hex(fx.blob.subarray(a.offset, a.offset + a.length)));
    strictEqual(a.sourceDigest, sha256hex(fx.blob.subarray(a.sourceOffset!, a.sourceOffset! + a.sourceLength!)));
    ok(head.manifest.modules['pack:/data.json']!.digest, 'assets carry a digest too');
    strictEqual(head.manifest.modules['pack:/data.json']!.sourceDigest, undefined);
    // And a full load, which is what runs the lazy checks.
    const container = loadAll(fx.bytes);
    strictEqual(Object.keys(container.manifest.modules).length, 3);
});

Deno.test('pack v4: substituted bytecode is detected even with offsets recomputed', () => {
    // THE demonstrated attack. Lift a hostile bytecode range in, rebuild the
    // blob, recompute every offset and length so all range and layout checks
    // still pass. The substituted bytes are a DIFFERENT length from the
    // original, so nothing here depends on a size coincidence, and the original
    // source bytes are left untouched in the blob — under version 3 this ran the
    // hostile body at exit 0 with no diagnostic.
    const fx = fixture();
    const head = parseRaw(fx.bytes);
    const evil = encoder.encode('<<BYTECODE-A-EVIL-BODY-LONGER-THAN-THE-ORIGINAL>>');
    const r = rebuild(head.manifest, head.blob, { 'pack:/a.ts': { bytecode: evil } });
    throws(() => loadAll(rawWrite(r.manifest, r.blob)), (e: Error) => {
        ok(/blob digest mismatch/.test(e.message), `unexpected message: ${e.message}`);
        ok(e.message.includes('pack:/a.ts'), e.message);
        return true;
    });
});

Deno.test('pack v4: a same-length in-place bytecode overwrite is detected', () => {
    // The case the manifest digest alone CANNOT see: the manifest is not touched
    // at all, so its digest still matches. Only a per-module digest over the
    // blob bytes catches this. This is why the scheme has two levels.
    const fx = fixture();
    const head = parseRaw(fx.bytes);
    const a = head.manifest.modules['pack:/a.ts']!;
    const replacement = encoder.encode('<<BYTECODE-A-EVIL!!!!!>>');
    strictEqual(replacement.byteLength, a.length, 'this case requires an exact-length swap');
    const out = Uint8Array.from(fx.bytes);
    out.set(replacement, HEADER_LEN + head.manifestLength + a.offset);
    // Prove the manifest really is untouched, so the failure can only come from
    // the per-module digest.
    const after = parseRaw(out);
    strictEqual(crypto.hexEncode(after.headerDigest), sha256hex(after.manifestBytes),
        'manifest digest must still be valid — that is the point of this case');
    throws(() => loadAll(out), /blob digest mismatch/);
});

Deno.test('pack v4: manifest-only tamper is detected', () => {
    // Repointing `entry` at another module already in the blob changes nothing
    // about the blob, so only the manifest digest can catch it.
    const fx = fixture();
    const head = parseRaw(fx.bytes);
    const repointed = { ...head.manifest, entry: 'pack:/b.ts' };
    throws(
        () => loadAll(rawWrite(repointed, head.blob, { staleDigest: head.headerDigest })),
        /manifest digest mismatch/);

    // A one-nibble edit anywhere in the manifest is equally fatal.
    const nudged = Uint8Array.from(fx.bytes);
    nudged[HEADER_LEN + 5] = nudged[HEADER_LEN + 5]! ^ 0x01;
    throws(() => loadAll(nudged), /manifest digest mismatch/);
});

Deno.test('pack v4: truncation and tail extension are detected', () => {
    const fx = fixture();
    // Cutting blob bytes that lie past every declared range would be invisible
    // to per-range bounds checks; the declared blobLength is what catches it.
    throws(() => loadAll(fx.bytes.subarray(0, fx.bytes.byteLength - 8)), /blob length mismatch/);
    // Truncated inside the manifest: caught before any digest work.
    throws(() => loadAll(fx.bytes.subarray(0, HEADER_LEN + 5)), /truncated manifest/);
    // A container shorter than the header itself.
    throws(() => loadAll(fx.bytes.subarray(0, 8)), /too short/);
    // Appending junk is also refused, rather than silently ignored.
    const extended = new Uint8Array(fx.bytes.byteLength + 16);
    extended.set(fx.bytes, 0);
    extended.set(encoder.encode('APPENDEDJUNK1234'), fx.bytes.byteLength);
    throws(() => loadAll(extended), /blob length mismatch/);
});

Deno.test('pack v4: version 3 containers are refused, not silently accepted', () => {
    // This is the decision that makes the rest of the file mean anything. A
    // version-3 container has no digest, so it is UNVERIFIABLE. Accepting one —
    // even with a warning — would hand over the whole bypass: strip the digests,
    // write 3 in the version word, and every check above is skipped. The version
    // is attacker-controlled, so it must not select the verification mode. Same
    // shape as JWT "alg":"none".
    //
    // The cost is real and deliberate: every .jspack built before this change
    // stops loading and must be rebuilt with `cno pack`.
    const fx = fixture();
    const head = parseRaw(fx.bytes);
    const stripped: any = structuredClone(head.manifest);
    delete stripped.blobLength;
    for (const e of Object.values<any>(stripped.modules)) {
        delete e.digest;
        delete e.sourceDigest;
    }
    throws(() => loadAll(writeV3(stripped, head.blob)), (e: Error) => {
        ok(/Unsupported \.jspack version: 3/.test(e.message), e.message);
        // The message must tell the user what to do about it.
        ok(/cno pack/.test(e.message), `error must be actionable: ${e.message}`);
        return true;
    });

    // Downgrading only the version word of a valid v4 container is refused too.
    const downgraded = Uint8Array.from(fx.bytes);
    new DataView(downgraded.buffer, downgraded.byteOffset, downgraded.byteLength).setUint16(4, 3, true);
    throws(() => loadAll(downgraded), /Unsupported \.jspack version: 3/);
});

Deno.test('pack v4: a missing digest is a failure, never a skip', () => {
    // "No digest means do not check" would be the same bypass one level down.
    const fx = fixture();
    const head = parseRaw(fx.bytes);

    const noBlobDigest: any = structuredClone(head.manifest);
    delete noBlobDigest.modules['pack:/a.ts'].digest;
    throws(() => loadAll(rawWrite(noBlobDigest, head.blob)), /missing its blob digest/);

    const noSourceDigest: any = structuredClone(head.manifest);
    delete noSourceDigest.modules['pack:/a.ts'].sourceDigest;
    throws(() => loadAll(rawWrite(noSourceDigest, head.blob)), /missing its source digest/);

    const noBlobLength: any = structuredClone(head.manifest);
    delete noBlobLength.blobLength;
    throws(() => loadAll(rawWrite(noBlobLength, head.blob)), /missing or invalid blob length/);

    // A malformed digest is rejected as a bad manifest, not as a mismatch.
    const badHex: any = structuredClone(head.manifest);
    badHex.modules['pack:/a.ts'].digest = 'nothex';
    throws(() => loadAll(rawWrite(badHex, head.blob)), /invalid blob digest/);

    // A non-source module has no source range, so a sourceDigest on one names
    // bytes that do not exist.
    const strayDigest: any = structuredClone(head.manifest);
    strayDigest.modules['pack:/data.json'].sourceDigest = sha256hex(new Uint8Array(0));
    throws(() => loadAll(rawWrite(strayDigest, head.blob)), /non-source module has a source digest/);
});

Deno.test('pack v4: encodePack refuses to write a manifest whose digest is wrong', () => {
    // The writer must not be usable to mint a container that its own reader
    // would reject; a supplied digest is verified rather than trusted.
    const fx = fixture();
    const lying: any = structuredClone(fx.manifest);
    lying.modules['pack:/a.ts'].digest = sha256hex(encoder.encode('not the real bytes'));
    throws(() => encodePack(lying, fx.blob), /does not match its blob bytes/);

    const lyingSource: any = structuredClone(fx.manifest);
    lyingSource.modules['pack:/a.ts'].sourceDigest = sha256hex(encoder.encode('nope'));
    throws(() => encodePack(lyingSource, fx.blob), /does not match its blob bytes/);

    // completePackManifest is the single place digests are produced, and it
    // must be idempotent — running it on an already-complete manifest agrees.
    const once = completePackManifest(fx.manifest, blobSourceFromBytes(fx.blob));
    const twice = completePackManifest(once, blobSourceFromBytes(fx.blob));
    strictEqual(JSON.stringify(once), JSON.stringify(twice));
});

Deno.test('pack v4: a duplicate module id is rejected instead of quietly winning', () => {
    // JSON.parse keeps the LAST of two identical keys (ECMA-262), so before this
    // check a manifest could read one way to a reviewer and run another. The
    // digest does not help: it covers these exact bytes, so a duplicate hashes
    // faithfully and passes. Hence an explicit pre-parse scan.
    const fx = fixture();
    const head = parseRaw(fx.bytes);
    const json = JSON.stringify(head.manifest);
    const injected = json.replace(
        '"pack:/b.ts":{',
        `"pack:/b.ts":{"localPath":"pack:/b.ts","format":"esm","fileKind":"json","offset":0,"length":0,"digest":"${sha256hex(new Uint8Array(0))}"},"pack:/b.ts":{`);
    ok(injected !== json, 'injection must have applied');
    const manifestBytes = encoder.encode(injected);
    const out = new Uint8Array(HEADER_LEN + manifestBytes.byteLength + head.blob.byteLength);
    const view = new DataView(out.buffer);
    out.set(MAGIC, 0);
    view.setUint16(4, 4, true);
    view.setUint32(6, manifestBytes.byteLength, true);
    // Digest computed over the duplicate-bearing bytes: correct, and still refused.
    out.set(new Uint8Array(crypto.sha256(manifestBytes)), 10);
    out.set(manifestBytes, HEADER_LEN);
    out.set(head.blob, HEADER_LEN + manifestBytes.byteLength);
    throws(() => loadAll(out), (e: Error) => {
        ok(/repeats the key "pack:\/b.ts"/.test(e.message), e.message);
        return true;
    });
});

Deno.test('pack v4: DOCUMENTED LIMIT — a fully recomputed forgery still loads', () => {
    // This case PASSES BY LOADING, on purpose. It is the honest boundary of
    // format version 4 and it must not be read as a defect in these tests.
    //
    // The digests live inside the container they protect, so an attacker who
    // rewrites the manifest also recomputes every per-module digest and the
    // header digest. The forgery is then perfectly self-consistent and there is
    // nothing left to compare it against. Version 4 raises the cost of the
    // attack from "recompute the offsets" to "recompute the offsets and two
    // hashes"; it does not prevent it.
    //
    // Preventing it requires a trust anchor OUTSIDE the artifact — a signature
    // over the manifest digest, or a digest the verifier learned elsewhere.
    // Until that exists, .jspack integrity is tamper EVIDENCE, not tamper
    // prevention, and nothing should describe it as signed or verified-authentic.
    //
    // If this test ever starts FAILING because the container is refused, a trust
    // anchor has been added and this comment plus this assertion should be
    // rewritten to match the stronger guarantee.
    const fx = fixture();
    const head = parseRaw(fx.bytes);
    const evil = encoder.encode('<<BYTECODE-A-EVIL-BODY-LONGER-THAN-THE-ORIGINAL>>');
    const r = rebuild(head.manifest, head.blob, { 'pack:/a.ts': { bytecode: evil } }, { refreshDigests: true });
    const forged = rawWrite(r.manifest, r.blob);

    const container = loadAll(forged);
    const entry = container.manifest.modules['pack:/a.ts']!;
    const served = readBlob(container, entry);
    strictEqual(new TextDecoder().decode(served), new TextDecoder().decode(evil),
        'the forged bytecode is served — this is the Phase 2 gap, not a test failure');
    // And the original source still sits in the blob, disowning the bytecode,
    // which is what makes this invisible to anyone auditing the artifact text.
    strictEqual(new TextDecoder().decode(readSourceBlob(container, entry)),
        'export const who = "SAFE";\n');
});
