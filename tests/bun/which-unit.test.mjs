import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const source = (await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/utils/which.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    write: false,
    define: { 'import.meta.use': '__test_use__' },
})).outputFiles[0].text;
const native = {
    fs: {
        stat(path) {
            const value = statSync(path);
            return { isFile: value.isFile(), isDirectory: value.isDirectory() };
        },
        access: accessSync,
        X_OK: constants.X_OK,
    },
    os: {
        cwd: process.cwd(),
        getenv: name => process.env[name],
        platform: process.platform,
    },
};
const module = { exports: {} };
runInNewContext(source, {
    module,
    exports: module.exports,
    __test_use__: name => native[name],
});
const { which } = module.exports;

const posix = process.platform !== 'win32';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'which-unit-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    return { root, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeExecutable(path) {
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
}

test('which finds an executable on the PATH option', { skip: !posix }, () => {
    const { bin, cleanup } = fixture();
    try {
        const tool = join(bin, 'mytool');
        writeExecutable(tool);
        assert.equal(which('mytool', { PATH: bin }), tool);
    } finally {
        cleanup();
    }
});

test('which returns null for missing commands and empty names', { skip: !posix }, () => {
    const { bin, cleanup } = fixture();
    try {
        assert.equal(which('does-not-exist', { PATH: bin }), null);
        assert.equal(which('', { PATH: bin }), null);
    } finally {
        cleanup();
    }
});

test('which ignores non-executable files', { skip: !posix }, () => {
    const { bin, cleanup } = fixture();
    try {
        writeFileSync(join(bin, 'plain'), 'data');
        chmodSync(join(bin, 'plain'), 0o644);
        assert.equal(which('plain', { PATH: bin }), null);
    } finally {
        cleanup();
    }
});

test('which ignores directories that match the command name', { skip: !posix }, () => {
    const { bin, cleanup } = fixture();
    try {
        mkdirSync(join(bin, 'dirtool'));
        assert.equal(which('dirtool', { PATH: bin }), null);
    } finally {
        cleanup();
    }
});

test('which resolves a path-like command against cwd without searching PATH', { skip: !posix }, () => {
    const { root, bin, cleanup } = fixture();
    try {
        const local = join(root, 'run.sh');
        writeExecutable(local);
        writeExecutable(join(bin, 'other'));
        assert.equal(which('./run.sh', { cwd: root, PATH: bin }), resolve(root, 'run.sh'));
        assert.equal(which('bin/other', { cwd: root, PATH: bin }), join(bin, 'other'));
        assert.equal(which('./missing', { cwd: root, PATH: bin }), null);
    } finally {
        cleanup();
    }
});

test('which does not search the current directory for empty PATH entries', { skip: !posix }, () => {
    const { root, cleanup } = fixture();
    try {
        writeExecutable(join(root, 'implicit'));
        assert.equal(which('implicit', { cwd: root, PATH: `::${join(root, 'missing')}` }), null);
        assert.equal(which('implicit', { cwd: root, PATH: '' }), null);
    } finally {
        cleanup();
    }
});

test('which uses the first matching PATH entry', { skip: !posix }, () => {
    const { root, bin, cleanup } = fixture();
    try {
        const second = join(root, 'second');
        mkdirSync(second);
        writeExecutable(join(bin, 'dup'));
        writeExecutable(join(second, 'dup'));
        assert.equal(which('dup', { PATH: `${bin}:${second}` }), join(bin, 'dup'));
    } finally {
        cleanup();
    }
});

test('which validates its command argument', () => {
    assert.throws(() => which(42), { name: 'TypeError', message: 'Expected command to be a string' });
    assert.throws(() => which(null), { name: 'TypeError', message: 'Expected command to be a string' });
});

test('which returns null for a PATH-less lookup of a common command when PATH is empty', { skip: !posix }, () => {
    assert.equal(which('sh', { PATH: '' }), null);
});
