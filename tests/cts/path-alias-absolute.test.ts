import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../cts/src/api/index.ts';
import { toPosixPath } from '../../cts/src/utils/path.ts';

// ModuleInfo.localPath is POSIX-INTERNAL BY DESIGN (cts/AGENT.md:230, AGENT.md:402).
// node:path.join() is NATIVE, so asserting localPath === join(...) was a TEST BUG
// that could only pass on POSIX. Measured on Windows 11 before this fix:
//   expected C:\Users\...\cts-alias-abs-1785604874988\src\entry.ts
//   got      C:/Users/.../cts-alias-abs-1785604874988/src/entry.ts
// The assertion this test exists for -- that an already-absolute path is NOT
// remapped through the '/*' alias into ./public -- is separator-independent.

function assertEq(a: unknown, b: unknown, msg?: string): void {
    if (a !== b) throw new Error(msg ?? `expected ${String(b)}, got ${String(a)}`);
}

Deno.test('path alias /* must not remap existing absolute paths', () => {
    const root = join(tmpdir(), `cts-alias-abs-${Date.now()}`);
    mkdirSync(join(root, 'public'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'entry.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            paths: { '/*': ['./public/*', './*'] },
        },
    }));

    const rt = createRuntime({
        cacheDir: join(root, '.cache'),
        disableLock: true,
        enableCache: false,
        silent: true,
        enableNode: false,
        pathAliases: { '/*': [join(root, 'public') + '/*', join(root, '') + '/*'] },
        baseUrl: root,
    });
    try {
        const abs = join(root, 'src', 'entry.ts');
        const info = rt.resolver.resolve(abs, join(root, '<entry>'));
        assertEq(info.localPath, toPosixPath(abs));
        if (info.localPath.includes('/public/')) {
            throw new Error(`absolute path remapped to public: ${info.localPath}`);
        }
    } finally {
        rt.cleanup();
        try { rmSync(root, { recursive: true, force: true }); } catch {}
    }
});
