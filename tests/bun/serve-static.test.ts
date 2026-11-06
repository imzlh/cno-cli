import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { serve } from 'bun';
import { withTempDir } from '../_helpers/temp.ts';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';

const positiveSizePseudoFile = (() => {
    if (Deno.build.os !== 'linux') return undefined;
    for (const path of [
        '/sys/devices/system/cpu/online',
        '/sys/devices/system/node/online',
        '/sys/kernel/mm/lru_gen/enabled',
        '/sys/kernel/uevent_seqnum',
    ]) {
        try {
            const stat = Deno.statSync(path);
            const bytes = Deno.readFileSync(path);
            if (stat.isFile && stat.size > 0 && bytes.byteLength > 1 && bytes.byteLength !== stat.size) {
                return { path, dir: dirname(path), name: basename(path), bytes };
            }
        } catch {
            // Sysfs layout varies by kernel; try the next small candidate.
        }
    }
    return undefined;
})();

async function makeAssetTree(root: string): Promise<string> {
    const dir = join(root, 'assets');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'style.css'), 'body { color: red; }\n');
    writeFileSync(join(dir, 'data.json'), '{"ok":true}');
    writeFileSync(join(dir, 'empty.txt'), '');
    writeFileSync(join(dir, 'sub', 'index.html'), '<h1>sub index</h1>');
    writeFileSync(join(dir, 'plain'), 'no extension');
    return dir;
}

Deno.test({ name: 'bun: directory routes serve files with index resolution and redirects', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-dir', async root => {
        const dir = await makeAssetTree(root);
        const server = serve({
            hostname: '127.0.0.1',
            port: 0,
            routes: { '/assets/*': { dir } },
            fetch: request => new Response(`fallback:${new URL(request.url).pathname}`, { status: 409 }),
        });

        try {
            const css = await fetch(new URL('/assets/style.css', server.url));
            strictEqual(css.status, 200);
            strictEqual(css.headers.get('content-type'), 'text/css;charset=utf-8');
            strictEqual(await css.text(), 'body { color: red; }\n');
            const lastModified = css.headers.get('last-modified');
            const etag = css.headers.get('etag');
            strictEqual(typeof lastModified, 'string');
            strictEqual(lastModified!.endsWith('GMT'), true);
            strictEqual(etag!.startsWith('W/"'), true, etag!);

            const json = await fetch(new URL('/assets/data.json', server.url));
            strictEqual(json.headers.get('content-type'), 'application/json;charset=utf-8');
            strictEqual(await json.text(), '{"ok":true}');
            strictEqual(await (await fetch(new URL('/assets/plain', server.url))).text(), 'no extension');

            // Percent-decoded once: encoded spaces reach the filesystem.
            writeFileSync(join(dir, 'with space.txt'), 'spaced');
            strictEqual(await (await fetch(new URL('/assets/with%20space.txt', server.url))).text(), 'spaced');

            // Directory with a trailing slash serves its index.html.
            const index = await fetch(new URL('/assets/sub/', server.url));
            strictEqual(index.status, 200);
            strictEqual(index.headers.get('content-type'), 'text/html;charset=utf-8');
            strictEqual(await index.text(), '<h1>sub index</h1>');

            // Directory without a trailing slash redirects to the slash URL.
            const redirect = await fetch(new URL('/assets/sub', server.url), { redirect: 'manual' });
            strictEqual(redirect.status, 301);
            strictEqual(redirect.headers.get('location'), '/assets/sub/');
            await redirect.text();

            // Missing files, and paths outside the served tree, fall through.
            const missing = await fetch(new URL('/assets/nope.css', server.url));
            strictEqual(missing.status, 404);
            await missing.text();
            const dirRoot = await fetch(new URL('/assets/', server.url));
            strictEqual(dirRoot.status, 404, 'no index.html in the root directory');
            await dirRoot.text();

            // Non-GET/HEAD methods fall through to fetch like unmatched methods.
            const posted = await fetch(new URL('/assets/style.css', server.url), { method: 'POST' });
            strictEqual(posted.status, 409);
            strictEqual(await posted.text(), 'fallback:/assets/style.css');
            const head = await fetch(new URL('/assets/style.css', server.url), { method: 'HEAD' });
            strictEqual(head.status, 200);
            strictEqual(await head.text(), '');
            strictEqual(head.headers.get('content-type'), 'text/css;charset=utf-8');
        } finally {
            await server.stop();
        }
    });
});

Deno.test({ name: 'bun: directory routes reject traversal and non-canonical remainders', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-dir-traversal', async root => {
        const dir = await makeAssetTree(root);
        // Content outside the served root that traversal must never reach.
        writeFileSync(join(root, 'secret.txt'), 'outside');
        symlinkSync(join(root, 'secret.txt'), join(dir, 'escape-link'));
        // A symlink that stays inside the root is served normally.
        symlinkSync(join(dir, 'style.css'), join(dir, 'internal-link'));
        // Backslash is a filename character on POSIX, not a separator. A
        // similarly prefixed path outside the root must not pass containment.
        if (Deno.build.os !== 'windows') {
            const backslashOutside = `${dir}\\secret`;
            writeFileSync(backslashOutside, 'backslash outside');
            symlinkSync(backslashOutside, join(dir, 'backslash-escape'));
        }

        const server = serve({
            hostname: '127.0.0.1',
            port: 0,
            routes: { '/assets/*': { dir } },
            fetch: () => new Response('fallback', { status: 409 }),
        });

        try {
            // WHATWG URL parsing normalizes literal and %2E dot segments away
            // before they can reach the server, so the encoded-separator,
            // empty-segment, and symlink guards are what a real client can hit.
            for (const path of [
                '/assets/..%2fsecret.txt',
                '/assets//secret.txt',
                '/assets//',
                '/assets/%2fetc%2fpasswd',
                '/assets/style.css%2f',
                '/assets/%zz',
                // Unreserved-ASCII escapes must not alias literal file names.
                '/assets/style%2Ecss',
                '/assets/%73tyle.css',
                '/assets/escape-link',
                '/assets/escape-link/x',
                ...(Deno.build.os === 'windows' ? [] : ['/assets/backslash-escape']),
            ]) {
                const response = await fetch(new URL(path, server.url));
                strictEqual(response.status, 404, path);
                await response.text();
            }
            // Dots inside a real file name are path characters, not traversal.
            writeFileSync(join(dir, 'v1.2.txt'), 'dotted');
            strictEqual(await (await fetch(new URL('/assets/v1.2.txt', server.url))).text(), 'dotted');
            // Internal symlinks stay inside the resolved root and are served.
            strictEqual(await (await fetch(new URL('/assets/internal-link', server.url))).text(), 'body { color: red; }\n');
        } finally {
            await server.stop();
        }
    });
});

Deno.test({ name: 'bun: directory routes are shadowed by exact-route exclusions without encoded aliases', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-dir-exclusion', async root => {
        const dir = await makeAssetTree(root);
        writeFileSync(join(dir, 'index.html'), 'root index');
        writeFileSync(join(dir, 'secret@.txt'), 'at secret');
        const server = serve({
            hostname: '127.0.0.1',
            port: 0,
            routes: {
                '/assets/': false,
                '/assets/index.html': false,
                '/assets/secret@.txt': false,
                '/assets/*': { dir },
            },
            fetch: () => new Response('excluded', { status: 403 }),
        });

        try {
            // The exact-route exclusion wins for the literal path.
            const excluded = await fetch(new URL('/assets/index.html', server.url));
            strictEqual(excluded.status, 403);
            await excluded.text();
            // Encoded aliases of the excluded name must not reach the file
            // through the directory route: the router matches the raw
            // remainder, so a percent-encoded identity is non-canonical.
            for (const path of [
                '/assets//',
                '/assets/%69ndex.html',
                '/assets/index%2Ehtml',
                '/assets/secret%40.txt',
            ]) {
                const aliased = await fetch(new URL(path, server.url));
                strictEqual(aliased.status, 404, path);
                await aliased.text();
            }
            // The directory route still serves its other files.
            strictEqual(await (await fetch(new URL('/assets/style.css', server.url))).text(), 'body { color: red; }\n');
        } finally {
            await server.stop();
        }
    });
});

Deno.test({ name: 'bun: directory route values are validated and must end in /*', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-dir-validate', async root => {
        const dir = await makeAssetTree(root);
        strictEqual(
            (() => {
                try {
                    serve({ routes: { '/assets': { dir } } });
                    return false;
                } catch (error) {
                    return error instanceof TypeError && /must end in/.test(error.message);
                }
            })(),
            true,
        );
        strictEqual(
            (() => {
                try {
                    serve({ routes: { '/assets/*': { dir: '' } } });
                    return false;
                } catch (error) {
                    return error instanceof TypeError && /non-empty/.test(error.message);
                }
            })(),
            true,
        );
        strictEqual(
            (() => {
                try {
                    serve({ routes: { '/assets/*': { dir, root: '/x' } } });
                    return false;
                } catch (error) {
                    return error instanceof TypeError && /only "dir" and "statCache"/.test(error.message);
                }
            })(),
            true,
        );
        strictEqual(
            (() => {
                try {
                    serve({ routes: { '/assets/*': { dir, statCache: 'yes' } } });
                    return false;
                } catch (error) {
                    return error instanceof TypeError && /statCache/.test(error.message);
                }
            })(),
            true,
        );
        // A non-directory record stays rejected with the route-value error.
        strictEqual(
            (() => {
                try {
                    serve({ routes: { '/assets/*': { other: 1 } } });
                    return false;
                } catch (error) {
                    return error instanceof TypeError;
                }
            })(),
            true,
        );
        // Valid option sets accept both forms of the statCache flag.
        for (const options of [{ dir }, { dir, statCache: false }]) {
            const server = serve({ routes: { '/assets/*': options } });
            const response = await fetch(new URL('/assets/data.json', server.url));
            deepStrictEqual(await response.json(), { ok: true });
            await server.stop();
        }
    });
});

Deno.test({ name: 'bun: directory routes honor conditional GET with 304 responses', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-dir-conditional', async root => {
        const dir = await makeAssetTree(root);
        const server = serve({
            hostname: '127.0.0.1',
            port: 0,
            routes: { '/assets/*': { dir } },
        });

        try {
            const fresh = await fetch(new URL('/assets/style.css', server.url));
            strictEqual(fresh.status, 200);
            const etag = fresh.headers.get('etag');
            ok(etag !== null, 'file responses carry an etag');
            strictEqual(fresh.headers.get('content-length'), String((await fresh.arrayBuffer()).byteLength));
            const lastModified = fresh.headers.get('last-modified')!;

            // ETag echo (weak and strong forms) yields 304 with no body.
            for (const value of [etag, `"${etag!.slice(3, -1)}"`]) {
                const notChanged = await fetch(new URL('/assets/style.css', server.url), {
                    headers: { 'if-none-match': value },
                });
                strictEqual(notChanged.status, 304, value);
                strictEqual(await notChanged.text(), '', value);
            }
            // Commas inside a quoted opaque tag must not read as separators:
            // a tag containing a literal '*' is not the wildcard.
            const opaque = await fetch(new URL('/assets/style.css', server.url), {
                headers: { 'if-none-match': '"foo,*,bar"' },
            });
            strictEqual(opaque.status, 200, 'quoted comma is not a wildcard');
            const opaqueWeak = await fetch(new URL('/assets/style.css', server.url), {
                headers: { 'if-none-match': `${etag}, "foo,*,bar"` },
            });
            strictEqual(opaqueWeak.status, 304, 'quoted comma still splits around the weak echo');
            for (const value of ['*, "other"', '"other", *']) {
                const listedWildcard = await fetch(new URL('/assets/style.css', server.url), {
                    headers: { 'if-none-match': value },
                });
                strictEqual(listedWildcard.status, 200, value);
            }
            // A stale validator still serves the file.
            const changed = await fetch(new URL('/assets/style.css', server.url), {
                headers: { 'if-none-match': 'W/"deadbeef"' },
            });
            strictEqual(changed.status, 200);

            // If-Modified-Since at or after the file mtime yields 304.
            const sinceFresh = await fetch(new URL('/assets/style.css', server.url), {
                headers: { 'if-modified-since': lastModified },
            });
            strictEqual(sinceFresh.status, 304);
            const sinceOld = await fetch(new URL('/assets/style.css', server.url), {
                headers: { 'if-modified-since': 'Mon, 01 Jan 1990 00:00:00 GMT' },
            });
            strictEqual(sinceOld.status, 200);
        } finally {
            await server.stop();
        }
    });
});

Deno.test({ name: 'bun: directory routes serve single ranges with 206 and 416', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-dir-range', async root => {
        const dir = await makeAssetTree(root);
        const mtime = new Date('2023-11-14T00:00:00Z');
        utimesSync(join(dir, 'data.json'), mtime, mtime);
        const server = serve({
            hostname: '127.0.0.1',
            port: 0,
            routes: { '/assets/*': { dir } },
        });

        try {
            const url = new URL('/assets/data.json', server.url);
            const full = await fetch(url);
            const bytes = new Uint8Array(await full.arrayBuffer());
            const etag = full.headers.get('etag')!;
            const lastModified = full.headers.get('last-modified')!;
            strictEqual(bytes.length > 8, true, 'fixture must span several chunks of range math');

            // Mid-file window.
            const mid = await fetch(url, { headers: { range: 'bytes=4-9' } });
            strictEqual(mid.status, 206);
            strictEqual(mid.headers.get('content-range'), `bytes 4-9/${bytes.length}`);
            strictEqual(mid.headers.get('content-length'), '6');
            deepStrictEqual(new Uint8Array(await mid.arrayBuffer()), bytes.slice(4, 10));

            // Open-ended and suffix forms.
            const tail = await fetch(url, { headers: { range: 'bytes=-6' } });
            strictEqual(tail.status, 206);
            deepStrictEqual(new Uint8Array(await tail.arrayBuffer()), bytes.slice(-6));
            const from5 = await fetch(url, { headers: { range: 'bytes=5-' } });
            strictEqual(from5.status, 206);
            deepStrictEqual(new Uint8Array(await from5.arrayBuffer()), bytes.slice(5));

            // End clamps to the file size; suffix longer than the file serves it all.
            const clamped = await fetch(url, { headers: { range: `bytes=${bytes.length - 2}-99999` } });
            strictEqual(clamped.status, 206);
            deepStrictEqual(new Uint8Array(await clamped.arrayBuffer()), bytes.slice(-2));

            // Unsatisfiable → 416 with the wildcard content-range.
            const tooFar = await fetch(url, { headers: { range: `bytes=${bytes.length + 10}-` } });
            strictEqual(tooFar.status, 416);
            strictEqual(tooFar.headers.get('content-range'), `bytes */${bytes.length}`);
            for (const range of ['bytes=-0', 'bytes=-00']) {
                const zeroSuffix = await fetch(url, { headers: { range } });
                strictEqual(zeroSuffix.status, 416, range);
                strictEqual(zeroSuffix.headers.get('content-range'), `bytes */${bytes.length}`, range);
            }

            const emptyUrl = new URL('/assets/empty.txt', server.url);
            const emptySuffix = await fetch(emptyUrl, { headers: { range: 'bytes=-1' } });
            strictEqual(emptySuffix.status, 200);
            strictEqual(emptySuffix.headers.get('content-range'), null);
            strictEqual(await emptySuffix.text(), '');
            const emptyZeroSuffix = await fetch(emptyUrl, { headers: { range: 'bytes=-0' } });
            strictEqual(emptyZeroSuffix.status, 416);
            strictEqual(emptyZeroSuffix.headers.get('content-range'), 'bytes */0');

            // Multi-range, non-byte units and malformed bounds fall back to the full body.
            for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=999-invalid', 'bytes=999-1-2']) {
                const ignored = await fetch(url, { headers: { range } });
                strictEqual(ignored.status, 200, range);
                deepStrictEqual(new Uint8Array(await ignored.arrayBuffer()), bytes, range);
            }

            // A stale or weak If-Range validator must not splice this version
            // into an older cached response. A matching date enables the range.
            for (const validator of [
                '"stale"', etag, 'Thu, 01 Jan 1970 00:00:00 GMT',
                '2023-11-14', '2023-11-14T00:00:00Z',
            ]) {
                const ignored = await fetch(url, { headers: { range: 'bytes=2-4', 'if-range': validator } });
                strictEqual(ignored.status, 200, validator);
                deepStrictEqual(new Uint8Array(await ignored.arrayBuffer()), bytes, validator);
            }
            const matchedDate = await fetch(url, { headers: { range: 'bytes=2-4', 'if-range': lastModified } });
            strictEqual(matchedDate.status, 206);
            deepStrictEqual(new Uint8Array(await matchedDate.arrayBuffer()), bytes.slice(2, 5));
            const rfc850Date = await fetch(url, {
                headers: { range: 'bytes=2-4', 'if-range': 'Tuesday, 14-Nov-23 00:00:00 GMT' },
            });
            strictEqual(rfc850Date.status, 206);
            deepStrictEqual(new Uint8Array(await rfc850Date.arrayBuffer()), bytes.slice(2, 5));

            // Conditional GET still wins over Range.
            const conditional = await fetch(url, { headers: { range: 'bytes=0-1', 'if-none-match': etag } });
            strictEqual(conditional.status, 304);
        } finally {
            await server.stop();
        }
    });
});

Deno.test({ name: 'bun: directory ranges seek across file chunks and finish promptly', timeout: 15000 }, async () => {
    await withTempDir('bun-serve-dir-range-large', async root => {
        const dir = join(root, 'assets');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'large.bin');
        const bytes = new Uint8Array(3 * 64 * 1024 + 31);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
        writeFileSync(file, bytes);
        // Keep a deterministic, second-aligned validator for If-Range tests.
        utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

        const server = serve({ hostname: '127.0.0.1', port: 0, routes: { '/assets/*': { dir } } });
        try {
            const start = 64 * 1024 + 17;
            const end = start + 70000;
            const response = await fetch(new URL('/assets/large.bin', server.url), {
                headers: { range: `bytes=${start}-${end}` },
            });
            strictEqual(response.status, 206);
            strictEqual(response.headers.get('content-length'), String(end - start + 1));
            deepStrictEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(start, end + 1));
        } finally {
            await server.stop();
        }
    });
});

Deno.test({
    name: 'bun: directory routes stream positive-size pseudo-files to EOF',
    ignore: positiveSizePseudoFile === undefined,
    timeout: 15000,
}, async () => {
    const candidate = positiveSizePseudoFile!;
    const server = serve({
        hostname: '127.0.0.1',
        port: 0,
        routes: { '/sys/*': { dir: candidate.dir } },
    });
    const url = new URL(`/sys/${candidate.name}`, server.url);
    try {
        const full = await fetch(url);
        strictEqual(full.status, 200);
        strictEqual(full.headers.get('content-length'), null);
        strictEqual(full.headers.get('etag'), null);
        deepStrictEqual(new Uint8Array(await full.arrayBuffer()), candidate.bytes);

        const head = await fetch(url, { method: 'HEAD' });
        strictEqual(head.status, 200);
        strictEqual(head.headers.get('content-length'), null);
        strictEqual(await head.text(), '');

        const range = await fetch(url, { headers: { range: 'bytes=1-2' } });
        strictEqual(range.status, 200);
        strictEqual(range.headers.get('content-range'), null);
        deepStrictEqual(new Uint8Array(await range.arrayBuffer()), candidate.bytes);
    } finally {
        await server.stop();
    }
});
