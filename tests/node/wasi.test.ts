import { strictEqual, ok } from 'node:assert';
import wasiDefault, { WASI } from 'node:wasi';

const WASICtor = WASI as unknown as new (options?: Record<string, unknown>) => WASI;

Deno.test('wasi: WASI is a constructor', () => {
    ok(typeof WASI === 'function');
    strictEqual(wasiDefault.WASI, WASI);
});

Deno.test('wasi: constructor without options throws ERR_INVALID_ARG_TYPE', () => {
    let err: NodeJS.ErrnoException | null = null;
    try {
        new WASICtor();
    } catch (error) {
        err = error as NodeJS.ErrnoException;
    }
    ok(err instanceof Error);
    strictEqual(err?.code, 'ERR_INVALID_ARG_TYPE');
});

Deno.test('wasi: constructor requires string version option', () => {
    let err: NodeJS.ErrnoException | null = null;
    try {
        new WASICtor({});
    } catch (error) {
        err = error as NodeJS.ErrnoException;
    }
    ok(err instanceof Error);
    strictEqual(err?.code, 'ERR_INVALID_ARG_TYPE');
});

Deno.test('wasi: constructor accepts preview1 and exposes wasiImport', () => {
    const wasi = new WASICtor({ version: 'preview1' });
    ok(typeof wasi.start === 'function');
    ok(typeof wasi.initialize === 'function');
    const wasiImport = Reflect.get(wasi, 'wasiImport') as Record<string, unknown> | undefined;
    ok(wasiImport && typeof wasiImport === 'object');
    strictEqual(typeof Reflect.get(wasiImport ?? {}, 'args_get'), 'function');
    strictEqual(typeof Reflect.get(wasiImport ?? {}, 'environ_get'), 'function');
});

Deno.test('wasi: getImportObject exposes wasi_snapshot_preview1 bindings', () => {
    const wasi = new WASICtor({ version: 'preview1' }) as WASI & {
        getImportObject: () => Record<string, Record<string, unknown>>;
    };
    const imports = wasi.getImportObject();
    ok(imports.wasi_snapshot_preview1 && typeof imports.wasi_snapshot_preview1 === 'object');
    strictEqual(typeof imports.wasi_snapshot_preview1.fd_write, 'function');
    strictEqual(typeof imports.wasi_snapshot_preview1.args_get, 'function');
});

Deno.test('wasi: getImports mirrors getImportObject namespace', () => {
    const wasi = new WASICtor({ version: 'preview1' }) as WASI & {
        getImports: () => Record<string, Record<string, unknown>>;
    };
    const imports = wasi.getImports();
    ok(imports.wasi_snapshot_preview1 && typeof imports.wasi_snapshot_preview1 === 'object');
    strictEqual(typeof imports.wasi_snapshot_preview1.environ_get, 'function');
    strictEqual(typeof imports.wasi_snapshot_preview1.fd_read, 'function');
});

Deno.test('wasi: unsupported version throws ERR_INVALID_ARG_VALUE', () => {
    let err: NodeJS.ErrnoException | null = null;
    try {
        new WASICtor({ version: 'preview2' });
    } catch (error) {
        err = error as NodeJS.ErrnoException;
    }
    ok(err instanceof Error);
    strictEqual(err?.code, 'ERR_INVALID_ARG_VALUE');
});

Deno.test('wasi: static version is undefined on current Node surface', () => {
    strictEqual(Reflect.get(WASI, 'version'), undefined);
});

Deno.test('wasi: start with invalid instance throws ERR_INVALID_ARG_TYPE', () => {
    const wasi = new WASICtor({ version: 'preview1' });
    let err: NodeJS.ErrnoException | null = null;
    try {
        Reflect.apply(wasi.start, wasi, [{}]);
    } catch (error) {
        err = error as NodeJS.ErrnoException;
    }
    ok(err instanceof Error);
    strictEqual(err?.code, 'ERR_INVALID_ARG_TYPE');
});

Deno.test('wasi: initialize with invalid instance throws ERR_INVALID_ARG_TYPE', () => {
    const wasi = new WASICtor({ version: 'preview1' });
    let err: NodeJS.ErrnoException | null = null;
    try {
        Reflect.apply(wasi.initialize, wasi, [{}]);
    } catch (error) {
        err = error as NodeJS.ErrnoException;
    }
    ok(err instanceof Error);
    strictEqual(err?.code, 'ERR_INVALID_ARG_TYPE');
});

Deno.test('wasi: initialize after failed start reports already started', () => {
    const wasi = new WASICtor({ version: 'preview1' });
    try {
        Reflect.apply(wasi.start, wasi, [{}]);
    } catch {
        // Start still marks the instance as started in Node.
    }

    let err: NodeJS.ErrnoException | null = null;
    try {
        Reflect.apply(wasi.initialize, wasi, [{}]);
    } catch (error) {
        err = error as NodeJS.ErrnoException;
    }
    ok(err instanceof Error);
    strictEqual(err?.code, 'ERR_WASI_ALREADY_STARTED');
});
