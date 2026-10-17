import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repository, 'scripts/ci/linux/stage-deps.sh');
const verify = join(repository, 'scripts/ci/linux/verify.sh');
const shellPath = path => path.replaceAll('\\', '/');
const shell = process.env.CNO_TEST_SH || 'sh';
const bash = process.env.CNO_TEST_BASH || 'bash';

function run(command, args, options = {}) {
    return spawnSync(command, args.map(shellPath), {
        encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options,
    });
}

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'cno-linux-deps-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const stage = join(directory, 'relocated package');
    const libs = join(directory, 'target libraries');
    const runtime = join(directory, 'compiler libraries');
    const destination = join(stage, 'lib');
    for (const path of [stage, libs, runtime, join(stage, 'ext')]) mkdirSync(path, { recursive: true });
    const readelf = join(directory, 'readelf');
    const cc = join(directory, 'cc');
    // ELF metadata fixtures travel with the copied file, just like real ELF
    // dynamic sections. No execution of foreign target binaries is needed.
    writeFileSync(readelf, '#!/bin/sh\ncase "$1" in\n-hW) grep -E "^(Class|Data|Machine):" "$2" ;;\n-dW) grep "^Dynamic:" "$2" || : ;;\n-lW) grep "^Header:" "$2" || : ;;\n*) exit 2 ;;\nesac\n', { mode: 0o755 });
    writeFileSync(cc, '#!/bin/sh\nprintf "%s/%s\\n" "${0%/*}/compiler libraries" "${1#-print-file-name=}"\n', { mode: 0o755 });
    function elf(path, needed, { machine = 'MIPS R3000', rpath, interpreter } = {}) {
        writeFileSync(path, [
            'Class: ELF32', 'Data: 2\'s complement, big endian', `Machine: ${machine}`,
            ...needed.map(name => `Dynamic: (NEEDED) Shared library: [${name}]`),
            ...(rpath ? [`Dynamic: (RPATH) Library rpath: [${rpath}]`] : []),
            ...(interpreter ? ['Header: INTERP', `Header: [Requesting program interpreter: ${interpreter}]`] : []),
        ].join('\n') + '\n');
        return path;
    }
    const binary = elf(join(stage, 'cno'), ['libcurl.so.4', 'libgcc_s.so.1', 'libc.so']);
    const module = elf(join(stage, 'ext/oxc.so'), ['libgcc_s.so.1', 'libc.so']);
    elf(join(libs, 'libcurl.so.4'), ['libssl.so.3', 'libc.so']);
    elf(join(libs, 'libssl.so.3'), ['libcrypto.so.3']);
    elf(join(libs, 'libcrypto.so.3'), ['libssl.so.3', 'libc.so']);
    elf(join(runtime, 'libgcc_s.so.1'), ['libc.so']);
    const stageDeps = (libc = 'musl', inputs = [binary, module]) => run(bash,
        [helper, libc, destination, readelf, cc, libs, ...inputs]);
    return { directory, stage, libs, runtime, destination, binary, module, readelf, cc, elf, stageDeps };
}

test('stages recursive shared dependencies, compiler runtimes and cycles without libc', t => {
    const f = fixture(t);
    const result = f.stageDeps();
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    for (const name of ['libcurl.so.4', 'libssl.so.3', 'libcrypto.so.3', 'libgcc_s.so.1']) {
        assert.equal(existsSync(join(f.destination, name)), true, name);
        assert.equal(lstatSync(join(f.destination, name)).isSymbolicLink(), false);
    }
    assert.equal(existsSync(join(f.destination, 'libc.so')), false);
    assert.match(readFileSync(join(f.destination, 'DEPENDENCIES.txt'), 'utf8'), /libcrypto\.so\.3/);
    f.elf(join(f.libs, 'libcurl.so.4'), ['libssl.so.3', 'libgcc_s.so.1', 'libc.so']);
    assert.equal(f.stageDeps().status, 0);
    assert.deepEqual(readFileSync(join(f.destination, 'libcurl.so.4')), readFileSync(join(f.libs, 'libcurl.so.4')));
});

test('copies SONAME symlinks as standalone files', t => {
    const f = fixture(t);
    const source = join(f.libs, 'libcurl.so.4');
    const real = join(f.libs, 'libcurl.so.4.8.0');
    renameSync(source, real);
    try {
        symlinkSync(real, source);
    } catch (error) {
        if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privilege unavailable');
        throw error;
    }
    const result = f.stageDeps();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lstatSync(join(f.destination, 'libcurl.so.4')).isSymbolicLink(), false);
    rmSync(real);
    assert.equal(existsSync(join(f.destination, 'libcurl.so.4')), true);
});

test('keeps glibc components paired with the system loader', t => {
    const f = fixture(t);
    const system = ['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1',
        'libutil.so.1', 'libresolv.so.2', 'libmvec.so.1', 'ld-linux-x86-64.so.2'];
    f.elf(f.binary, [...system, 'libgcc_s.so.1']);
    f.elf(join(f.runtime, 'libgcc_s.so.1'), ['libc.so.6']);
    const result = f.stageDeps('glibc', [f.binary]);
    assert.equal(result.status, 0, result.stderr);
    for (const name of system) assert.equal(existsSync(join(f.destination, name)), false, name);
    assert.equal(existsSync(join(f.destination, 'libgcc_s.so.1')), true);
});

test('rejects missing transitive libraries, host architecture, invalid names and foreign libc', t => {
    for (const scenario of ['missing', 'host', 'name', 'glibc', 'musl', 'invalid']) {
        const f = fixture(t);
        if (scenario === 'missing') rmSync(join(f.libs, 'libcrypto.so.3'));
        if (scenario === 'host') f.elf(join(f.libs, 'libcrypto.so.3'), [], { machine: 'Advanced Micro Devices X86-64' });
        if (scenario === 'name') f.elf(join(f.libs, 'libcrypto.so.3'), ['../outside.so']);
        if (scenario === 'glibc') f.elf(join(f.libs, 'libcrypto.so.3'), ['libc.so.6']);
        if (scenario === 'invalid') writeFileSync(join(f.libs, 'libcrypto.so.3'), 'not ELF');
        const result = f.stageDeps(scenario === 'musl' ? 'glibc' : 'musl');
        assert.notEqual(result.status, 0, scenario);
        assert.equal(existsSync(join(f.destination, 'DEPENDENCIES.txt')), false);
    }
});

test('release checks reject static external libraries and nonrelocatable search paths', t => {
    const f = fixture(t);
    const needed = ['curl', 'ssl', 'crypto', 'sqlite3', 'ffi', 'expat', 'z'].map(name => `lib${name}.so.1`);
    needed.push('libc.so');
    const options = { rpath: '$ORIGIN/lib', interpreter: '/lib/ld-musl-mips.so.1' };
    mkdirSync(f.destination);
    writeFileSync(join(f.destination, 'DEPENDENCIES.txt'), 'Fixture dependency inventory\n');
    f.elf(f.module, ['libc.so'], { rpath: '$ORIGIN/../lib' });
    f.elf(f.binary, needed, options);
    const check = () => run(shell, [verify, 'musl', f.stage, f.readelf]);
    assert.equal(check().status, 0);
    f.elf(f.binary, needed.filter(name => name !== 'libcurl.so.1'), options);
    assert.notEqual(check().status, 0);
    f.elf(f.binary, needed, { ...options, rpath: '/build/host/lib' });
    assert.notEqual(check().status, 0);
    f.elf(f.binary, [...needed, 'libuv.so.1'], options);
    assert.notEqual(check().status, 0);
});

test('unified linkage checks preserve static and libc requirements', t => {
    const f = fixture(t);
    const check = mode => run(shell, [verify, mode, f.stage, f.readelf]);
    // Static verification needs neither an extension nor a shared library bundle.
    rmSync(f.module);
    f.elf(f.binary, []);
    assert.equal(check('static').status, 0);
    f.elf(f.binary, ['libc.so']);
    assert.notEqual(check('static').status, 0);
    f.elf(f.binary, [], { interpreter: '/lib/ld-musl-mips.so.1' });
    assert.notEqual(check('static').status, 0);
    assert.match(check('musl').stderr, /Missing musl shared dependency/);
    f.elf(f.binary, ['libc.so', 'libc.so.6'], { interpreter: '/lib/ld-musl-mips.so.1' });
    assert.match(check('musl').stderr, /Unexpected glibc dependency/);
    f.elf(f.binary, ['libc.so.6'], { interpreter: '/lib/ld-linux.so.2' });
    assert.match(check('musl').stderr, /Expected a dynamic musl interpreter/);
    assert.notEqual(check('unknown').status, 0);
});

test('real ELF dependency bundle runs after relocation and falls back when lib/ is removed', {
    skip: process.platform !== 'linux' && 'Requires a Linux compiler and loader',
}, t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-real-elf-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = join(directory, 'src');
    const build = join(directory, 'build');
    const stage = join(directory, 'package');
    mkdirSync(source);
    mkdirSync(stage);
    writeFileSync(join(source, 'leaf.c'), 'int leaf(void) { return 42; }\n');
    writeFileSync(join(source, 'middle.c'), 'int leaf(void); int middle(void) { return leaf(); }\n');
    writeFileSync(join(source, 'main.c'), 'int middle(void); int main(void) { return middle() == 42 ? 0 : 1; }\n');
    // Apply the production CMake hook, including its literal $ORIGIN escaping.
    writeFileSync(join(source, 'CMakeLists.txt'), [
        'cmake_minimum_required(VERSION 3.20)', 'project(cjs C)',
        'add_library(leaf SHARED leaf.c)', 'add_library(middle SHARED middle.c)',
        'target_link_libraries(middle PRIVATE leaf)', 'add_executable(cno main.c)',
        'target_link_libraries(cno PRIVATE middle)',
    ].join('\n'));
    function ok(command, args, options) {
        const result = run(command, args, options);
        assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    }
    ok('cmake', ['-S', source, '-B', build, `-DCMAKE_PROJECT_cjs_INCLUDE=${join(repository, 'cmake/ci/shared-linux.cmake')}`]);
    ok('cmake', ['--build', build]);
    renameSync(join(build, 'cno'), join(stage, 'cno'));
    ok(bash, [helper, 'glibc', join(stage, 'lib'), 'readelf', 'cc', build, join(stage, 'cno')]);
    const moved = join(directory, 'relocated package');
    renameSync(stage, moved);
    // Hide the build tree: absolute build RPATHs cannot make this test pass.
    const system = join(directory, 'system libraries');
    renameSync(build, system);
    ok(join(moved, 'cno'), [], { env: { ...process.env, LD_LIBRARY_PATH: '' } });
    rmSync(join(moved, 'lib'), { recursive: true });
    // LD_LIBRARY_PATH supplies a controlled stand-in for system packages.
    ok(join(moved, 'cno'), [], { env: { ...process.env, LD_LIBRARY_PATH: system } });
});
