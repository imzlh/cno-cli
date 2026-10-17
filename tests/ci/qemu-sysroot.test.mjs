import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repository, 'scripts/ci/linux/prepare-qemu.sh');
const shellPath = path => path.replaceAll('\\', '/');

function fixture(t, interpreter = '/lib/ld-musl-mips.so.1') {
    const directory = mkdtempSync(join(tmpdir(), 'cno-qemu-sysroot-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const compilerRoot = join(directory, 'compiler sysroot');
    const destination = join(directory, 'qemu runtime');
    mkdirSync(join(compilerRoot, 'lib'), { recursive: true });
    const libc = join(compilerRoot, 'lib/libc.so');
    const binary = join(directory, 'qjsc');
    const readelf = join(directory, 'readelf');
    writeFileSync(libc, 'ELF-FIXTURE: target musl libc\n');
    writeFileSync(binary, 'ELF-FIXTURE: target qjsc\n');
    writeFileSync(`${binary}.headers`, `[Requesting program interpreter: ${interpreter}]\n`);
    // Model readelf's interface; this regression exercises runtime filesystem
    // preparation, independent of host architecture and installed binutils.
    writeFileSync(readelf, '#!/bin/sh\ncase "$1" in\n-lW) cat "$2.headers" ;;\n-h) grep -q "^ELF-FIXTURE:" "$2" ;;\n*) exit 2 ;;\nesac\n', { mode: 0o755 });
    const run = () => spawnSync(process.env.CNO_TEST_SH || 'sh',
        [helper, binary, libc, destination, readelf].map(shellPath),
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return { binary, libc, compilerRoot, destination, interpreter, run };
}

test('prepares the actual loader and libc names for every musl cross target', t => {
    for (const arch of ['mips', 'mipsel', 'mips64', 'riscv64', 'arm']) {
        const f = fixture(t, `/lib/ld-musl-${arch}.so.1`);
        assert.equal(existsSync(f.compilerRoot + f.interpreter), false);
        const result = f.run();
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        for (const path of [f.destination + f.interpreter, join(f.destination, 'lib/libc.so')]) {
            assert.deepEqual(readFileSync(path), readFileSync(f.libc));
            assert.equal(lstatSync(path).isSymbolicLink(), false);
        }
        assert.equal(existsSync(f.compilerRoot + f.interpreter), false);
    }
});

test('ignores a loader symlink pointing at a missing original build machine path', t => {
    const f = fixture(t);
    try {
        symlinkSync('/missing-musl-build-host/lib/libc.so', f.compilerRoot + f.interpreter);
    } catch (error) {
        if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privilege unavailable');
        throw error;
    }
    const result = f.run();
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(readFileSync(f.destination + f.interpreter), readFileSync(f.libc));
});

test('rejects missing, foreign, malformed or multiple interpreters before writing files', t => {
    for (const interpreter of ['', '/lib/ld-linux.so.2', '/lib/ld-musl-../../escape.so.1',
        '/lib/ld-musl-mips.so.1]\n[Requesting program interpreter: /lib/ld-musl-arm.so.1']) {
        const f = fixture(t, interpreter);
        assert.notEqual(f.run().status, 0);
        assert.equal(existsSync(f.destination), false);
    }
});

test('rejects a missing or invalid libc and refreshes a previous runtime root', t => {
    const f = fixture(t);
    assert.equal(f.run().status, 0);
    writeFileSync(f.libc, 'ELF-FIXTURE: updated target libc\n');
    assert.equal(f.run().status, 0);
    assert.deepEqual(readFileSync(f.destination + f.interpreter), readFileSync(f.libc));
    writeFileSync(f.libc, 'not an ELF library');
    assert.notEqual(f.run().status, 0);
    rmSync(f.libc);
    assert.notEqual(f.run().status, 0);
});
