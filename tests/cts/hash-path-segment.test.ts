import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../cts/src/api/index.ts';
import { toPosixPath } from '../../cts/src/utils/path.ts';

// es5-ext ships a real directory named "#". Absolute filesystem parents must
// keep that segment when resolving relatives (not treat "#" as a URL fragment).
//
// ModuleInfo.localPath is POSIX-INTERNAL BY DESIGN (cts/AGENT.md:230, AGENT.md:402:
// "host paths on the boundary but POSIX internally"). node:path.join() returns a
// NATIVE path, so comparing the two directly is a TEST BUG that can only pass on
// POSIX. Measured on Windows 11 before this fix:
//   expected C:\Users\...\string\#\contains\is-implemented.js
//   got      C:/Users/.../string/#/contains/is-implemented.js
// The runtime was right; the oracle was wrong. Denormalizing localPath instead
// would assert the opposite of the documented contract, so the expectation is
// converted to POSIX. What this test is actually about -- that "#" survives as a
// path segment and is not parsed as a URL fragment -- is unaffected either way.
const p = (...parts: string[]) => toPosixPath(join(...parts));

function assertEq(a: unknown, b: unknown, msg?: string): void {
    if (a !== b) throw new Error(msg ?? `expected ${String(b)}, got ${String(a)}`);
}

Deno.test('cts resolve: absolute path with "#" directory segment', () => {
    const root = join(tmpdir(), `cts-hash-path-${Date.now()}`);
    const dir = join(root, 'string', '#', 'contains');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'module.exports = require("./is-implemented");\n');
    writeFileSync(join(dir, 'is-implemented.js'), 'module.exports = function () { return false; };\n');

    const rt = createRuntime({
        cacheDir: join(root, '.cache'),
        disableLock: true,
        enableCache: false,
        silent: true,
        enableNode: false,
    });
    try {
        const parent = join(dir, 'index.js');
        const info = rt.resolver.resolve('./is-implemented.js', parent);
        assertEq(info.localPath, p(dir, 'is-implemented.js'));
        if (!info.localPath.includes(toPosixPath(join('string', '#', 'contains')))) {
            throw new Error(`missing # segment: ${info.localPath}`);
        }
    } finally {
        rt.cleanup();
        try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

Deno.test('cts resolve: file:// URL with encoded %23 path segment', () => {
    const root = join(tmpdir(), `cts-hash-url-${Date.now()}`);
    const dir = join(root, 'string', '#', 'contains');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'export default 1;\n');
    writeFileSync(join(dir, 'shim.js'), 'export default 2;\n');

    const rt = createRuntime({
        cacheDir: join(root, '.cache'),
        disableLock: true,
        enableCache: false,
        silent: true,
        enableNode: false,
    });
    try {
        // pathToFileURL-style: "#" must be %23 in the URL path
        const parentUrl = `file://${dir.replace(/#/g, '%23')}/index.js`;
        const info = rt.resolver.resolve('./shim.js', parentUrl);
        assertEq(info.localPath, p(dir, 'shim.js'));
    } finally {
        rt.cleanup();
        try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});
