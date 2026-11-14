import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
    DynamicLibrary,
    dlclose,
    dlopen,
    dlsym,
    exportArrayBuffer,
    exportArrayBufferView,
    exportBuffer,
    exportString,
    getCurrentEventLoop,
    getFloat64,
    getInt32,
    getRawPointer,
    getUint8,
    setFloat64,
    setInt32,
    setUint8,
    suffix,
    toArrayBuffer,
    toBuffer,
    toString,
    types,
} from 'node:ffi';

// The native binding knows the platform's actual C runtime loader name. The
// calls themselves only use node:ffi; this avoids assuming glibc, musl, or a
// particular Windows CRT filename in the test fixture.
const libcPath = import.meta.use('ffi').libraries.c;
const fixtureFilename = Deno.build.os === 'windows'
    ? 'ffi_fixture.dll'
    : Deno.build.os === 'darwin'
        ? 'libffi_fixture.dylib'
        : 'libffi_fixture.so';
const nativeExecutable = import.meta.use('os').exePath;
const ffiFixtureDirectory = resolve(dirname(nativeExecutable), '..', 'circu.js');
const ffiFixturePath = [
    resolve(ffiFixtureDirectory, fixtureFilename),
    ...['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel']
        .map(configuration => resolve(ffiFixtureDirectory, configuration, fixtureFilename)),
].find(existsSync) ?? resolve(ffiFixtureDirectory, fixtureFilename);

Deno.test('node26 ffi: suffix and type constants expose the portable surface', () => {
    ok(['so', 'dylib', 'dll'].includes(suffix));
    strictEqual(types.VOID, 'void');
    strictEqual(types.POINTER, 'pointer');
    strictEqual(types.INT_32, 'int32');
    strictEqual(types.UINT_64, 'uint64');
    strictEqual(types.FLOAT_64, 'float64');
});

Deno.test('node26 ffi: dlopen resolves and invokes common libc functions', () => {
    const handle = dlopen(libcPath, {
        abs: { arguments: ['i32'], return: 'i32' },
        free: { arguments: ['pointer'], return: 'void' },
        strlen: { arguments: ['pointer'], return: 'u64' },
        strchr: { arguments: ['pointer', 'i32'], return: 'pointer' },
        strtod: { arguments: ['pointer', 'pointer'], return: 'f64' },
    });

    try {
        const input = Buffer.from('hello ffi\0');
        const offsetInput = Buffer.from('xoffset\0').subarray(1);
        strictEqual(handle.functions.abs(-42), 42);
        strictEqual(handle.functions.free(null), undefined);
        strictEqual(handle.functions.strlen(input), 9n);
        strictEqual(handle.functions.strlen(offsetInput), 6n);
        strictEqual(handle.functions.strtod('3.25', null), 3.25);

        const tail = handle.functions.strchr(input, 'f'.charCodeAt(0));
        ok(tail > 0n);
        strictEqual(toString(tail), 'ffi');

        ok(handle.functions.strlen.pointer > 0n);
        strictEqual(handle.functions.strlen.pointer, handle.lib.symbols.strlen);
        strictEqual(handle.lib.getFunctions().strlen, handle.functions.strlen);
    } finally {
        handle[Symbol.dispose]();
    }

    throws(() => handle.functions.strlen(Buffer.from('closed\0')), /closed/i);
});

Deno.test('node26 ffi: DynamicLibrary and dlsym share cached symbols and close safely', () => {
    const lib = new DynamicLibrary(libcPath);
    strictEqual(lib.path, libcPath);
    deepStrictEqual(Object.keys(lib.getSymbols()), []);

    const strlenAddress = dlsym(lib, 'strlen');
    ok(strlenAddress > 0n);
    strictEqual(lib.getSymbol('strlen'), strlenAddress);
    strictEqual(lib.symbols.strlen, strlenAddress);

    const strlen = lib.getFunction('strlen', {
        arguments: ['pointer'],
        return: 'u64',
    });
    strictEqual(strlen.pointer, strlenAddress);
    strictEqual(strlen(Buffer.from('dynamic\0')), 7n);

    const functions = lib.getFunctions({
        strchr: { arguments: ['pointer', 'i32'], return: 'pointer' },
    });
    // node:ffi exposes pointers as bare bigint addresses, which cannot own
    // memory they alias. Keep the source alive until the returned tail is read.
    const input = Buffer.from('abc\0');
    strictEqual(toString(functions.strchr(input, 0x62)), 'bc');

    dlclose(lib);
    dlclose(lib);
    lib[Symbol.dispose]();
    throws(() => lib.getSymbol('strlen'), /closed/i);
    throws(() => strlen(Buffer.from('closed\0')), /closed/i);
});

Deno.test('node26 ffi: scalar pointer access and copied/zero-copy views work', () => {
    const storage = new Uint8Array(32);
    const pointer = getRawPointer(storage);
    ok(pointer > 0n);

    setUint8(pointer, 0, 0xab);
    setInt32(pointer, 4, -1234567);
    setFloat64(pointer, 8, Math.PI);
    strictEqual(getUint8(pointer), 0xab);
    strictEqual(getInt32(pointer, 4), -1234567);
    strictEqual(getFloat64(pointer, 8), Math.PI);

    const copy = toBuffer(pointer, storage.byteLength);
    const view = toBuffer(pointer, storage.byteLength, false);
    setUint8(pointer, 1, 0xcd);
    strictEqual(copy[1], 0);
    strictEqual(view[1], 0xcd);
    view[2] = 0xef;
    strictEqual(storage[2], 0xef);

    const arrayCopy = new Uint8Array(toArrayBuffer(pointer, 4));
    const arrayView = new Uint8Array(toArrayBuffer(pointer, 4, false));
    setUint8(pointer, 3, 0x77);
    strictEqual(arrayCopy[3], 0);
    strictEqual(arrayView[3], 0x77);

    strictEqual(toBuffer(0n, 0).byteLength, 0);
    throws(() => toBuffer(0n, 1), RangeError);
});

Deno.test('node26 ffi: export helpers copy strings, buffers, and views to native memory', () => {
    const storage = new Uint8Array(64);
    const pointer = getRawPointer(storage);

    exportString('node ffi', pointer, 16);
    strictEqual(toString(pointer), 'node ffi');

    exportBuffer(Buffer.from([1, 2, 3]), pointer + 16n, 8);
    deepStrictEqual([...storage.subarray(16, 19)], [1, 2, 3]);

    exportArrayBuffer(new Uint8Array([4, 5, 6]).buffer, pointer + 24n, 8);
    deepStrictEqual([...storage.subarray(24, 27)], [4, 5, 6]);

    const source = new Uint8Array([9, 7, 8, 6]);
    exportArrayBufferView(source.subarray(1, 3), pointer + 32n, 8);
    deepStrictEqual([...storage.subarray(32, 34)], [7, 8]);

    throws(() => exportString('too long', pointer, 2), RangeError);
    throws(() => exportBuffer(Buffer.from([1, 2, 3]), pointer, 2), RangeError);
});

Deno.test('node26 ffi: same-thread callbacks can be passed to native functions', () => {
    const lib = new DynamicLibrary(libcPath);
    try {
        const qsort = lib.getFunction('qsort', {
            arguments: ['pointer', 'u64', 'u64', 'pointer'],
            return: 'void',
        });
        const values = new Int32Array([9, -2, 7, 1, 0]);
        const comparator = lib.registerCallback(
            { arguments: ['pointer', 'pointer'], return: 'i32' },
            (left, right) => {
                const difference = getInt32(left as bigint) - getInt32(right as bigint);
                // The compatibility API historically encoded callback results
                // through DataView, so out-of-range integers wrap to their C width.
                return 0x1_0000_0000 + difference;
            },
        );

        lib.unrefCallback(comparator);
        lib.refCallback(comparator);
        qsort(values, BigInt(values.length), 4n, comparator);
        deepStrictEqual([...values], [-2, 0, 1, 7, 9]);

        lib.unregisterCallback(comparator);
        throws(() => lib.refCallback(comparator), /unknown callback/i);
    } finally {
        lib.close();
    }
});

Deno.test('node26 ffi: registered callbacks preserve native thread provenance across libraries', () => {
    const owner = new DynamicLibrary(ffiFixturePath);
    const caller = new DynamicLibrary(ffiFixturePath);
    try {
        const callOnThread = caller.getFunction('ffi_fixture_call_callback_on_thread', {
            arguments: ['pointer', 'i32', 'i32'],
            return: 'i32',
        });
        const isNull = caller.getFunction('ffi_fixture_pointer_is_null', {
            arguments: ['pointer'],
            return: 'i32',
        });
        const callback = owner.registerCallback(
            { arguments: ['i32', 'i32'], return: 'i32' },
            (left, right) => Number(left) + Number(right),
        );

        throws(() => callOnThread(callback, 20, 22), /unsupported native thread/i);

        owner.unregisterCallback(callback);
        // An unregistered address is once again an ordinary opaque pointer. It
        // must not try to read `.pointer` from the now-closed native callback.
        strictEqual(isNull(callback), 0);
        throws(() => owner.refCallback(callback), /unknown callback/i);

        const closedWithOwner = owner.registerCallback(
            { arguments: ['i32', 'i32'], return: 'i32' },
            (left, right) => Number(left) + Number(right),
        );
        owner.close();
        // Closing the owning library also removes its callbacks from the
        // process-wide provenance registry.
        strictEqual(isNull(closedWithOwner), 0);
    } finally {
        owner.close();
        caller.close();
    }
});

Deno.test('node26 ffi: integer arguments keep legacy fixed-width wrapping', () => {
    const cases = [
        ['ffi_fixture_roundtrip_i8', 'i8', 0x101, 1],
        ['ffi_fixture_roundtrip_u8', 'u8', -0xff, 1],
        ['ffi_fixture_roundtrip_i16', 'i16', 0x1_0002, 2],
        ['ffi_fixture_roundtrip_u16', 'u16', -0xfffe, 2],
        ['ffi_fixture_roundtrip_i32', 'i32', 0x1_0000_0003, 3],
        ['ffi_fixture_roundtrip_u32', 'u32', -0xffff_fffd, 3],
        ['ffi_fixture_roundtrip_i64', 'i64', 0x1_0000_0000_0000_0004n, 4n],
        ['ffi_fixture_roundtrip_u64', 'u64', -0xffff_ffff_ffff_fffbn, 5n],
    ] as const;

    for (const [name, type, input, expected] of cases) {
        using handle = dlopen(ffiFixturePath, {
            [name]: { arguments: [type], return: type },
        });
        strictEqual(handle.functions[name](input), expected, type);
    }
});

Deno.test('node26 ffi: current-process lookup fails explicitly', () => {
    throws(
        () => new DynamicLibrary(null),
        (error: unknown) => (error as Error & { code?: string }).code === 'ERR_NOT_SUPPORTED',
    );
});

Deno.test('node26 ffi: current libuv loop pointer is available', () => {
    ok(getCurrentEventLoop() > 0n);
});
