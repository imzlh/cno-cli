import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

const {
    UnsafePointer,
    UnsafePointerView,
    UnsafeCallback,
    UnsafeFnPointer,
    dlopen,
} = Deno as typeof Deno & {
    UnsafePointer: any;
    UnsafePointerView: any;
    UnsafeCallback: any;
    UnsafeFnPointer: any;
    dlopen: (filename: string | URL, symbols: Record<string, unknown>) => unknown;
};

Deno.test('deno ffi: UnsafePointer create value equals and offset semantics', () => {
    strictEqual(UnsafePointer.create(0n), null);
    strictEqual(UnsafePointer.value(null), 0n);
    strictEqual(UnsafePointer.equals(null, null), true);

    const base = UnsafePointer.create(0x1000n);
    const same = UnsafePointer.create(0x1000n);
    const next = UnsafePointer.offset(base, 0x20);
    ok(base);
    strictEqual(Object.getPrototypeOf(base), null);
    strictEqual(UnsafePointer.value(base), 0x1000n);
    strictEqual(UnsafePointer.value(next), 0x1020n);
    strictEqual(UnsafePointer.offset(base, -0x1000), null);
    throws(() => new UnsafePointerView(base).getUint8(-0x1000), /offset resolves to null/);
    strictEqual(UnsafePointer.equals(base, same), true);
    strictEqual(UnsafePointer.equals(base, next), false);
});

Deno.test('deno ffi: UnsafePointer.of and UnsafePointerView read process memory views', () => {
    const data = new Uint8Array([
        0x01,
        0xff,
        0x34, 0x12,
        0x78, 0x56, 0x34, 0x12,
        0x6f, 0x6b, 0x00,
    ]);
    const ptr = UnsafePointer.of(data);
    const offsetPtr = UnsafePointer.of(data.subarray(2));
    ok(ptr);
    ok(offsetPtr);
    strictEqual(UnsafePointer.value(offsetPtr), UnsafePointer.value(ptr) + 2n);
    strictEqual(UnsafePointer.of({ pointer: ptr }), ptr);

    const shared = new SharedArrayBuffer(4);
    const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    new DataView(shared).setUint32(0, 0x12345678, littleEndian);
    const sharedPtr = UnsafePointer.of(shared);
    ok(sharedPtr);
    strictEqual(new UnsafePointerView(sharedPtr).getUint32(), 0x12345678);

    const view = new UnsafePointerView(ptr);
    strictEqual(view.pointer, ptr);
    strictEqual(view.getBool(0), true);
    strictEqual(view.getUint8(0), 1);
    strictEqual(view.getInt8(1), -1);
    strictEqual(view.getUint16(2), 0x1234);
    strictEqual(view.getUint32(4), 0x12345678);
    strictEqual(view.getCString(8), 'ok');
    strictEqual(UnsafePointerView.getCString(ptr, 8), 'ok');

    const copy = new Uint8Array(4);
    view.copyInto(copy, 2);
    deepStrictEqual([...copy], [0x34, 0x12, 0x78, 0x56]);
    deepStrictEqual([...new Uint8Array(UnsafePointerView.getArrayBuffer(ptr, 3, 8))], [0x6f, 0x6b, 0x00]);

    const staticCopy = new Uint8Array(3);
    UnsafePointerView.copyInto(ptr, staticCopy, 8);
    deepStrictEqual([...staticCopy], [0x6f, 0x6b, 0x00]);
});

Deno.test('deno ffi: UnsafePointerView reads numeric scalar types in native byte order', () => {
    const data = new ArrayBuffer(40);
    const dv = new DataView(data);
    const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    dv.setInt16(0, -2, littleEndian);
    dv.setInt32(2, -12345678, littleEndian);
    dv.setBigUint64(8, 0x0102030405060708n, littleEndian);
    dv.setBigInt64(16, -0x0102030405060708n, littleEndian);
    dv.setFloat32(24, 1.5, littleEndian);
    dv.setFloat64(28, -2.25, littleEndian);

    const ptr = UnsafePointer.of(data);
    ok(ptr);
    const view = new UnsafePointerView(ptr);

    strictEqual(view.getInt16(0), -2);
    strictEqual(view.getInt32(2), -12345678);
    strictEqual(view.getBigUint64(8), 0x0102030405060708n);
    strictEqual(view.getBigInt64(16), -0x0102030405060708n);
    strictEqual(view.getFloat32(24), 1.5);
    strictEqual(view.getFloat64(28), -2.25);
});

Deno.test('deno ffi: UnsafeCallback lifecycle methods are idempotent around pointer creation', () => {
    const callback = new UnsafeCallback({ parameters: ['u32'], result: 'u32' }, (value: number) => value + 1);
    ok(UnsafePointer.value(callback.pointer) > 0n);
    strictEqual(callback.ref(), 1);
    strictEqual(callback.ref(), 2);
    strictEqual(callback.unref(), 1);
    callback.close();
    callback.close();
    strictEqual(callback.unref(), 0);
    throws(() => callback.ref(), /Callback is closed/);

    throws(
        () => UnsafeCallback.threadSafe({ parameters: [], result: 'void' }, () => {}),
        (error: Error) => error.name === 'NotSupported' && /Thread-safe FFI callbacks/.test(error.message),
    );
});

Deno.test('deno ffi: UnsafeFnPointer calls UnsafeCallback pointers and propagates errors', () => {
    const callback = new UnsafeCallback({ parameters: ['u32'], result: 'u32' }, (value: number) => value + 1);
    try {
        const fnPointer = new UnsafeFnPointer(callback.pointer, { parameters: ['u32'], result: 'u32' });
        strictEqual(fnPointer.call(41), 42);
    } finally {
        callback.close();
    }

    const throwing = new UnsafeCallback({ parameters: [], result: 'void' }, () => {
        throw new Error('ffi callback failed');
    });
    try {
        const fnPointer = new UnsafeFnPointer(throwing.pointer, { parameters: [], result: 'void' });
        throws(() => fnPointer.call(), /ffi callback failed/);
    } finally {
        throwing.close();
    }
});

Deno.test('deno ffi: bool callbacks exchange JavaScript booleans', () => {
    const callback = new UnsafeCallback(
        { parameters: ['bool'], result: 'bool' },
        (value: boolean) => !value,
    );
    try {
        const fnPointer = new UnsafeFnPointer(
            callback.pointer,
            { parameters: ['bool'], result: 'bool' },
        );
        strictEqual(fnPointer.call(false), true);
        strictEqual(fnPointer.call(true), false);
    } finally {
        callback.close();
    }
});

Deno.test('deno ffi: nested struct callbacks use native ABI padding', () => {
    const ffi = import.meta.use('ffi');
    const innerDefinition = { struct: ['u16', 'u32'] } as const;
    const outerDefinition = { struct: ['u8', innerDefinition, 'u8'] } as const;
    const innerType = ffi.types.struct([ffi.types.u16, ffi.types.u32]);
    const outerType = ffi.types.struct([ffi.types.u8, innerType, ffi.types.u8]);
    const callback = new UnsafeCallback(
        { parameters: [outerDefinition], result: outerDefinition },
        (bytes: Uint8Array) => {
            const [tag, nested, tail] = outerType.unpack(bytes);
            return outerType.pack([tag + 1, [nested[0] + 2, nested[1] + 3], tail + 4]);
        },
    );
    try {
        const fnPointer = new UnsafeFnPointer(
            callback.pointer,
            { parameters: [outerDefinition], result: outerDefinition },
        );
        const input = outerType.pack([1, [10, 20], 30]);
        const output = fnPointer.call(input) as Uint8Array;
        deepStrictEqual(outerType.unpack(output), [2, [12, 23], 34]);
        ok(outerType.offsets[2] > innerType.size,
            'outer trailing field must include the nested struct padding and alignment');
    } finally {
        callback.close();
    }
});

Deno.test('deno ffi: UnsafeFnPointer calls arbitrary native function pointers', () => {
    const ffi = import.meta.use('ffi');
    const nativeLibrary = ffi.open(ffi.libraries.c);
    try {
        const absPointer = UnsafePointer.create(ffi.unsafe.address(nativeLibrary.symbol('abs')));
        ok(absPointer);
        const abs = new UnsafeFnPointer(absPointer, { parameters: ['i32'], result: 'i32' });
        strictEqual(abs.call(-42), 42);
    } finally {
        nativeLibrary.close();
    }
});

Deno.test('deno ffi: nonblocking UnsafeFnPointer rejects without executing native code', async () => {
    let called = false;
    const callback = new UnsafeCallback({ parameters: [], result: 'void' }, () => {
        called = true;
    });
    try {
        const fnPointer = new UnsafeFnPointer(callback.pointer, {
            parameters: [],
            result: 'void',
            nonblocking: true,
        });
        await fnPointer.call().then(
            () => { throw new Error('Expected nonblocking FFI call to reject'); },
            (error: Error) => {
                strictEqual(error.name, 'NotSupported');
                ok(/Nonblocking FFI calls/.test(error.message));
            },
        );
        strictEqual(called, false);
    } finally {
        callback.close();
    }
});

Deno.test('deno ffi: dlopen calls native functions and handles optional symbols', () => {
    const ffi = import.meta.use('ffi');
    const library = dlopen(ffi.libraries.c, {
        strlen: { parameters: ['buffer'], result: 'usize' },
        missing: { name: 'cno_missing_symbol_for_ffi_test', parameters: [], result: 'void', optional: true },
    }) as {
        symbols: {
            strlen(input: Uint8Array): bigint;
            missing: null | (() => void);
        };
        close(): void;
    };

    try {
        strictEqual(library.symbols.missing, null);
        strictEqual(Number(library.symbols.strlen(new TextEncoder().encode('hello\0'))), 5);
    } finally {
        library.close();
    }
    library.close();
    throws(() => library.symbols.strlen(new TextEncoder().encode('closed\0')), /Library is closed/);
});

Deno.test('deno ffi: nonblocking dlopen symbols reject without executing and retain close semantics', async () => {
    const ffi = import.meta.use('ffi');
    const library = dlopen(ffi.libraries.c, {
        abs: { parameters: ['i32'], result: 'i32', nonblocking: true },
    }) as {
        symbols: { abs(value: number): Promise<number> };
        close(): void;
    };

    await library.symbols.abs(-42).then(
        () => { throw new Error('Expected nonblocking FFI call to reject'); },
        (error: Error) => {
            strictEqual(error.name, 'NotSupported');
            ok(/Nonblocking FFI calls/.test(error.message));
        },
    );
    library.close();
    await library.symbols.abs(-42).then(
        () => { throw new Error('Expected closed nonblocking FFI call to reject'); },
        (error: Error) => ok(/Library is closed/.test(error.message)),
    );
});

Deno.test('deno ffi: dlopen validates symbol definitions before loading', () => {
    const ffi = import.meta.use('ffi');
    throws(() => dlopen(ffi.libraries.c, null as unknown as Record<string, unknown>), TypeError);
    throws(() => (dlopen as unknown as (filename: string) => unknown)(ffi.libraries.c), TypeError);
    throws(() => dlopen(ffi.libraries.c, { malloc: null }), TypeError);
    throws(() => dlopen(ffi.libraries.c, {
        strlen: { parameters: ['not-a-native-type'], result: 'usize' },
    }), TypeError);
    throws(() => dlopen(ffi.libraries.c, {
        errno: { parameters: [], result: 'not-a-result-type' },
    }), TypeError);
    throws(() => dlopen(ffi.libraries.c, {
        strlen: { name: 1, parameters: ['buffer'], result: 'usize' },
    }), TypeError);
    throws(() => dlopen(ffi.libraries.c, {
        strlen: { parameters: ['buffer'], result: 'usize', nonblocking: 'yes' },
    }), TypeError);
    throws(() => dlopen(ffi.libraries.c, {
        invalid: { parameters: [{ struct: [] }], result: 'void', optional: true },
    }), /at least one member/);
});

Deno.test('deno ffi: dlopen closes a library when required symbol lookup fails', () => {
    const ffi = import.meta.use('ffi');
    throws(() => dlopen(ffi.libraries.c, {
        missing: { name: 'cno_missing_required_ffi_symbol', parameters: [], result: 'void' },
    }));
    const library = dlopen(ffi.libraries.c, {
        strlen: { parameters: ['buffer'], result: 'usize' },
    });
    library.close();
});

Deno.test('deno ffi: dlopen ignores inherited symbol definitions', () => {
    const ffi = import.meta.use('ffi');
    const symbols = Object.create({
        inherited: { name: 'cno_missing_inherited_ffi_symbol', parameters: [], result: 'void' },
    }) as Record<string, unknown>;
    const library = dlopen(ffi.libraries.c, symbols) as {
        symbols: Record<string, unknown>;
        close(): void;
    };
    try {
        deepStrictEqual(Object.keys(library.symbols), []);
    } finally {
        library.close();
    }
});

Deno.test('deno ffi: dlopen reports missing libraries without requiring a fixture binary', () => {
    throws(() => dlopen('/definitely/not-a-cno-test-library.so', {}));
});
