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

Deno.test('deno ffi: UnsafePointerView reads numeric scalar types little-endian', () => {
    const data = new ArrayBuffer(40);
    const dv = new DataView(data);
    dv.setInt16(0, -2, true);
    dv.setInt32(2, -12345678, true);
    dv.setBigUint64(8, 0x0102030405060708n, true);
    dv.setBigInt64(16, -0x0102030405060708n, true);
    dv.setFloat32(24, 1.5, true);
    dv.setFloat64(28, -2.25, true);

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

    const threadSafe = UnsafeCallback.threadSafe({ parameters: [], result: 'void' }, () => {});
    ok(UnsafePointer.value(threadSafe.pointer) > 0n);
    strictEqual(threadSafe.unref(), 0);
    threadSafe.close();
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

Deno.test('deno ffi: dlopen calls native functions and handles optional symbols', () => {
    const ffi = import.meta.use('ffi');
    const library = dlopen(ffi.LIBC_NAME, {
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
    throws(() => library.symbols.strlen(new TextEncoder().encode('closed\0')), /Library is closed/);
});

Deno.test('deno ffi: dlopen validates symbol definitions before loading', () => {
    const ffi = import.meta.use('ffi');
    throws(() => dlopen(ffi.LIBC_NAME, null as unknown as Record<string, unknown>), TypeError);
    throws(() => (dlopen as unknown as (filename: string) => unknown)(ffi.LIBC_NAME), TypeError);
    throws(() => dlopen(ffi.LIBC_NAME, { malloc: null }), TypeError);
    throws(() => dlopen(ffi.LIBC_NAME, {
        strlen: { parameters: ['not-a-native-type'], result: 'usize' },
    }), TypeError);
    throws(() => dlopen(ffi.LIBC_NAME, {
        errno: { parameters: [], result: 'not-a-result-type' },
    }), TypeError);
});

Deno.test('deno ffi: dlopen reports missing libraries without requiring a fixture binary', () => {
    throws(() => dlopen('/definitely/not-a-cno-test-library.so', {}));
});
