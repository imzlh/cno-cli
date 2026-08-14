import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process, { loadEnvFile } from 'node:process';
import { makePosixTempDir } from '../_helpers/temp.ts';

const names = [
    'CNO_LOAD_ENV_EXISTING',
    'CNO_LOAD_ENV_GOOD',
    'CNO_LOAD_ENV_AFTER',
    'CNO_LOAD_ENV_EXPAND',
    'CNO_LOAD_ENV_EXPORT',
    'CNO_LOAD_ENV_DOUBLE',
    'CNO_LOAD_ENV_SINGLE',
    'CNO_LOAD_ENV_DUP',
];

function restoreEnv(previous: Map<string, string | undefined>): void {
    for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

Deno.test('process upstream: loadEnvFile follows Node dotenv precedence and parsing', () => {
    const root = makePosixTempDir('process-load-env');
    const file = `${root}/values.env`;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    writeFileSync(file, [
        'CNO_LOAD_ENV_EXISTING=from-file',
        'CNO_LOAD_ENV_GOOD=one',
        'this is not an assignment',
        'CNO_LOAD_ENV_AFTER=two',
        'CNO_LOAD_ENV_EXPAND=${CNO_LOAD_ENV_GOOD}-suffix',
        'export CNO_LOAD_ENV_EXPORT=exported',
        'CNO_LOAD_ENV_DOUBLE="line1\\nline2"',
        "CNO_LOAD_ENV_SINGLE='single # literal'",
        'CNO_LOAD_ENV_DUP=first',
        'CNO_LOAD_ENV_DUP=second',
    ].join('\n'));

    try {
        process.env.CNO_LOAD_ENV_EXISTING = 'from-parent';
        for (const name of names.slice(1)) delete process.env[name];
        loadEnvFile(file);
        deepStrictEqual(names.map((name) => process.env[name]), [
            'from-parent',
            'one',
            'two',
            '${CNO_LOAD_ENV_GOOD}-suffix',
            'exported',
            'line1\nline2',
            'single # literal',
            'second',
        ]);
        strictEqual(loadEnvFile, process.loadEnvFile);
        strictEqual(process.loadEnvFile, globalThis.process.loadEnvFile);
    } finally {
        restoreEnv(previous);
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('process upstream: loadEnvFile validates paths and preserves ENOENT details', () => {
    const root = makePosixTempDir('process-load-env-errors');
    const missing = `${root}/missing.env`;
    try {
        throws(() => loadEnvFile(missing), (error: unknown) => {
            if (error === null || typeof error !== 'object') return false;
            strictEqual(Reflect.get(error, 'code'), 'ENOENT');
            strictEqual(Reflect.get(error, 'syscall'), 'open');
            strictEqual(Reflect.get(error, 'path'), resolve(missing));
            return true;
        });

        for (const value of [123, {}, Symbol('path')]) {
            throws(() => Reflect.apply(loadEnvFile, process, [value]), (error: unknown) => {
                return error !== null && typeof error === 'object' &&
                    Reflect.get(error, 'code') === 'ERR_INVALID_ARG_TYPE';
            });
        }
        throws(
            () => loadEnvFile(new URL('https://example.com/.env')),
            (error: unknown) => error !== null && typeof error === 'object' &&
                Reflect.get(error, 'code') === 'ERR_INVALID_URL_SCHEME',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('process upstream: loadEnvFile accepts Uint8Array paths', () => {
    const root = makePosixTempDir('process-load-env-bytes');
    const file = `${root}/bytes.env`;
    const name = 'CNO_LOAD_ENV_BYTES_PATH';
    const previous = process.env[name];
    writeFileSync(file, `${name}=yes\n`);
    try {
        delete process.env[name];
        Reflect.apply(loadEnvFile, process, [Buffer.from(file)]);
        strictEqual(process.env[name], 'yes');
    } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
