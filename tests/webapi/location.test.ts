import { strictEqual, ok, throws } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { decodeUtf8 } from '../_helpers/bytes.ts';

// ============================================================================
// Web API — Location (specs/run/_070_location, _071_location_unset)
// ============================================================================

Deno.test('webapi: location is undefined without --location (Deno default)', () => {
    // Main-thread default matches Deno: no --location ⇒ undefined
    strictEqual(globalThis.location, undefined);
});

Deno.test('webapi: Location constructor is still available', () => {
    ok(typeof Location === 'function');
});

Deno.test({ name: 'webapi: --location installs Location URL shape and rejects assignment', timeout: 15000 }, async () => {
    await withTempDir('webapi-location-flag', async (root) => {
        const file = join(root, 'loc.ts');
        await Deno.writeTextFile(file, `
console.log('href=' + location.href);
console.log('hostname=' + location.hostname);
console.log('pathname=' + location.pathname);
console.log('search=' + location.search);
console.log('hash=' + location.hash);
try { location = {}; console.log('assign-ok'); } catch (e) {
  console.log('assign-err=' + (e instanceof Error ? e.name : e));
}
try { location.hostname = 'bar'; console.log('set-ok'); } catch (e) {
  console.log('set-err=' + (e instanceof Error ? e.name : e));
}
`);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['run', '--location=https://foo/bar?baz#bat', file],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = decodeUtf8(output.stdout) + decodeUtf8(output.stderr);
        strictEqual(output.code, 0, text);
        ok(text.includes('href=https://foo/bar?baz#bat'), text);
        ok(text.includes('hostname=foo'), text);
        ok(text.includes('pathname=/bar'), text);
        ok(text.includes('search=?baz'), text);
        ok(text.includes('hash=#bat'), text);
        ok(text.includes('assign-err=NotSupportedError') || text.includes('assign-err=Error'), text);
        ok(text.includes('set-err=NotSupportedError') || text.includes('set-err=Error'), text);
    });
});

Deno.test({ name: 'webapi: without --location location stays undefined', timeout: 15000 }, async () => {
    await withTempDir('webapi-location-unset', async (root) => {
        const file = join(root, 'loc.ts');
        await Deno.writeTextFile(file, `
console.log('typeof=' + typeof location);
console.log('value=' + String(location));
`);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['run', file],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = decodeUtf8(output.stdout) + decodeUtf8(output.stderr);
        strictEqual(output.code, 0, text);
        ok(text.includes('typeof=undefined'), text);
    });
});

Deno.test({ name: 'webapi: cno eval --location installs Location (same as run)', timeout: 15000 }, async () => {
    // Polyfill loads before CLI flags; eval must call __cno_applyLocation, not only setenv.
    const output = await new Deno.Command(Deno.execPath(), {
        args: [
            'eval',
            '--location=https://foo/bar?baz#bat',
            'console.log("href=" + location.href); console.log("hostname=" + location.hostname); console.log("typeof=" + typeof location);',
        ],
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    const text = decodeUtf8(output.stdout) + decodeUtf8(output.stderr);
    strictEqual(output.code, 0, text);
    ok(text.includes('href=https://foo/bar?baz#bat'), text);
    ok(text.includes('hostname=foo'), text);
    ok(text.includes('typeof=object'), text);
    ok(!/\bundefined undefined\b/.test(text), text);
});
