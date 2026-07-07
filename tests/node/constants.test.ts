import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import constants, {
    O_RDONLY,
    RSA_PKCS1_PADDING,
    SIGTERM,
    Z_BEST_COMPRESSION,
    crypto,
    dlopen,
    errno,
    fs,
    os,
    priority,
    signals,
    zlib,
} from 'node:constants';
import * as fsMod from 'node:fs';
import * as cryptoMod from 'node:crypto';
import * as osMod from 'node:os';
import * as zlibMod from 'node:zlib';

Deno.test('constants: default export exposes flattened fs, crypto, zlib and os constants', () => {
    strictEqual(constants.O_RDONLY, fsMod.constants.O_RDONLY);
    strictEqual(constants.RSA_PKCS1_PADDING, cryptoMod.constants.RSA_PKCS1_PADDING);
    strictEqual(constants.Z_BEST_COMPRESSION, zlibMod.constants.Z_BEST_COMPRESSION);
    strictEqual(constants.SIGTERM, osMod.constants.signals.SIGTERM);
    strictEqual(constants.EACCES, osMod.constants.errno.EACCES);
});

Deno.test('constants: named primitive exports mirror default export', () => {
    strictEqual(O_RDONLY, constants.O_RDONLY);
    strictEqual(RSA_PKCS1_PADDING, constants.RSA_PKCS1_PADDING);
    strictEqual(Z_BEST_COMPRESSION, constants.Z_BEST_COMPRESSION);
    strictEqual(SIGTERM, constants.SIGTERM);
});

Deno.test('constants: nested namespaces preserve source module identities', () => {
    strictEqual(fs, constants.fs);
    strictEqual(crypto, constants.crypto);
    strictEqual(zlib, constants.zlib);
    strictEqual(os, constants.os);
    strictEqual(fs.O_CREAT, fsMod.constants.O_CREAT);
    strictEqual(crypto.RSA_PKCS1_OAEP_PADDING, cryptoMod.constants.RSA_PKCS1_OAEP_PADDING);
    strictEqual(zlib.Z_DEFAULT_COMPRESSION, zlibMod.constants.Z_DEFAULT_COMPRESSION);
    deepStrictEqual(signals, constants.signals);
    deepStrictEqual(errno, constants.errno);
    deepStrictEqual(dlopen, constants.dlopen);
    deepStrictEqual(priority, constants.priority);
});

Deno.test('constants: aggregate object is frozen but nested namespaces remain usable', () => {
    ok(Object.isFrozen(constants));
    strictEqual(constants.fs.F_OK, fsMod.constants.F_OK);
    strictEqual(typeof constants.os.UV_UDP_REUSEADDR, 'number');
});
