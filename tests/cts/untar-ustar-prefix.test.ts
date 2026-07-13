/**
 * unTarGz must honor ustar prefix (and GNU/pax long names). Name field alone
 * is ≤100 bytes — packages like monaco-editor use prefix for deep paths.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert';

const zlib = import.meta.use('zlib');

// Minimal ustar header builder (512 bytes).
function ustarHeader(opts: {
    name: string;
    prefix?: string;
    size: number;
    type?: string;
    mode?: number;
}): Uint8Array {
    const h = new Uint8Array(512);
    const put = (off: number, s: string, len: number) => {
        for (let i = 0; i < Math.min(s.length, len); i++) h[off + i] = s.charCodeAt(i);
    };
    const putOct = (off: number, n: number, len: number) => {
        const s = n.toString(8).padStart(len - 1, '0');
        put(off, s, len - 1);
    };
    put(0, opts.name, 100);
    putOct(100, opts.mode ?? 0o644, 8);
    putOct(108, 0, 8); // uid
    putOct(116, 0, 8); // gid
    putOct(124, opts.size, 12);
    putOct(136, 0, 12); // mtime
    put(156, opts.type ?? '0', 1);
    put(257, 'ustar\0', 6);
    put(263, '00', 2);
    if (opts.prefix) put(345, opts.prefix, 155);
    // checksum: sum of header with checksum field as spaces
    put(148, '        ', 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i]!;
    const cs = sum.toString(8).padStart(6, '0') + '\0 ';
    put(148, cs, 8);
    return h;
}

function buildUstarGz(entries: Array<{
    name: string;
    prefix?: string;
    body: string;
}>): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const e of entries) {
        const body = new TextEncoder().encode(e.body);
        parts.push(ustarHeader({ name: e.name, prefix: e.prefix, size: body.byteLength }));
        const pad = (512 - (body.byteLength % 512)) % 512;
        parts.push(body);
        if (pad) parts.push(new Uint8Array(pad));
    }
    parts.push(new Uint8Array(1024)); // two zero blocks
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const raw = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
        raw.set(p, o);
        o += p.byteLength;
    }
    return new Uint8Array(zlib.gzip(raw));
}

Deno.test('unTarGz: ustar prefix joins with name for paths >100 bytes', async () => {
    // Dynamic import keeps test independent of cts path layout in stage binary.
    const { unTarGz } = await import('../../cts/src/utils/misc.ts');
    const prefix = 'package/esm/vs/editor/contrib/colorPicker/browser/standaloneColorPicker';
    const name = 'standaloneColorPickerWidget.js';
    ok(prefix.length + 1 + name.length > 100, 'fixture must need ustar prefix');

    const gz = buildUstarGz([
        { name: 'package.json', body: '{"name":"pkg"}' },
        { name, prefix, body: 'export const x = 1;\n' },
    ]);
    const files = unTarGz(gz);
    const paths = files.map((f) => f.path).sort();
    deepStrictEqual(paths, [
        `${prefix}/${name}`,
        'package.json',
    ].sort());
    const deep = files.find((f) => f.path.endsWith(name));
    ok(deep, 'deep file present');
    strictEqual(new TextDecoder().decode(deep!.content), 'export const x = 1;\n');
});
