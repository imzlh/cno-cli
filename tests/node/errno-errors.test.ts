import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import * as vm from 'node:vm';
import { normalizeSpawnFailure } from '../../cno/src/node/child_process/command.ts';
import {
    createSystemError,
    isTransportDisconnectError,
    normalizeErrnoError,
    toErrnoException,
} from '../../cno/src/node/_internal/errno.ts';
import { createDnsError, normalizeLookupError, normalizeLookupServiceError, queryDns } from '../../cno/src/node/dns/_internal.ts';
import {
    errnoCode,
    errnoDescription,
    errnoEntries,
    matchesErrnoCode,
    systemErrorMap,
    systemErrorName,
    unknownErrno,
} from '../../cno/src/utils/errno.ts';

const nativeError = import.meta.use('error');

Deno.test('errno conversion preserves native errno and call context', () => {
    const source = nativeError.Error(nativeError.errno.ENOENT);
    const converted = toErrnoException(source, 'open', '/missing', '/target');

    strictEqual(converted.message, source.message);
    strictEqual(converted.code, 'ENOENT');
    strictEqual(converted.errno, nativeError.errno.ENOENT);
    strictEqual(converted.syscall, 'open');
    strictEqual(converted.path, '/missing');
    strictEqual((converted as NodeJS.ErrnoException & { dest?: string }).dest, '/target');
    strictEqual(converted.name, 'Error');
    strictEqual(Object.keys(converted).includes('name'), false);

    const prototype = Error.prototype;
    const keys = ['syscall', 'path', 'dest'] as const;
    const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(prototype, key));
    try {
        for (const key of keys) {
            Object.defineProperty(prototype, key, { configurable: true, writable: true, value: 'inherited' });
        }
        const contextual = toErrnoException(source, 'open', '/missing', '/target');
        for (const [key, value] of Object.entries({ syscall: 'open', path: '/missing', dest: '/target' })) {
            strictEqual(Object.hasOwn(contextual, key), true);
            strictEqual(Reflect.get(contextual, key), value);
        }
    } finally {
        keys.forEach((key, index) => {
            const descriptor = descriptors[index];
            if (descriptor) Object.defineProperty(prototype, key, descriptor);
            else Reflect.deleteProperty(prototype, key);
        });
    }
});

Deno.test('errno conversion preserves ordinary and already-normalized errors', () => {
    const ordinary = new Error('application failure');
    const nodeError = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const applicationError = Object.assign(new Error('application failure'), { code: 'ERR_CUSTOM' });

    strictEqual(normalizeErrnoError(ordinary), ordinary);
    strictEqual(toErrnoException(nodeError), nodeError);
    strictEqual(normalizeErrnoError(applicationError, 'read', '/opaque'), applicationError);
    strictEqual(toErrnoException(applicationError, 'read', '/opaque'), applicationError);
    strictEqual(Reflect.get(applicationError, 'syscall'), undefined);
    for (const error of [Object.freeze(ordinary), Object.freeze(applicationError)]) {
        strictEqual(normalizeSpawnFailure(error, '/missing-command', 'spawnSync', ['x']), error);
        strictEqual(Reflect.get(error, 'path'), undefined);
        strictEqual(Reflect.get(error, 'spawnargs'), undefined);
    }

    const contextual = toErrnoException(nodeError, 'open', '/missing');
    strictEqual(contextual, nodeError);
    strictEqual(contextual.errno, undefined);
    strictEqual(contextual.syscall, undefined);
    strictEqual(contextual.path, undefined);
    const frozen = Object.freeze(Object.assign(new Error('denied'), { code: 'EACCES' }));
    strictEqual(toErrnoException(frozen, 'cp', '/from', '/to'), frozen);
    strictEqual(normalizeErrnoError(frozen, 'cp', '/from', '/to'), frozen);
    const domException = new DOMException('canceled', 'AbortError');
    strictEqual(toErrnoException(domException, 'cp'), domException);
    strictEqual(normalizeErrnoError(domException, 'cp'), domException);
    const applicationNumber = Object.freeze(Object.assign(new Error('application failure'), { code: 42 }));
    strictEqual(toErrnoException(applicationNumber, 'cp'), applicationNumber);
    strictEqual(normalizeErrnoError(applicationNumber, 'cp'), applicationNumber);
});

Deno.test('runtime errno table supplies Node UV map names and descriptions', () => {
    const expectedNames = new Map<number, string>();
    for (const [name, value] of errnoEntries()) expectedNames.set(value, name);

    const map = systemErrorMap();
    strictEqual(map.has(0), false);
    strictEqual(map.size, expectedNames.size);
    for (const [errno, name] of expectedNames) {
        deepStrictEqual(map.get(errno), [name, errnoDescription(errno)]);
        strictEqual(systemErrorName(errno), name);
    }
    strictEqual(errnoDescription(nativeError.errno.ENOENT), 'no such file or directory');
    strictEqual(errnoDescription(-424242), 'Unknown system error -424242');
    strictEqual(systemErrorName(-424242), 'Unknown system error -424242');
    const missing = map.get(nativeError.errno.ENOENT)!;
    missing[0] = 'changed';
    missing[1] = 'changed';
    deepStrictEqual(systemErrorMap().get(nativeError.errno.ENOENT), ['ENOENT', 'no such file or directory']);
});

Deno.test('native errno lookup requires an error code', () => {
    strictEqual(nativeError.getErrorMessage.length, 1);
    strictEqual(nativeError.getErrorName.length, 1);
    throws(() => nativeError.getErrorMessage(), TypeError);
    throws(() => nativeError.getErrorName(), TypeError);
});

Deno.test('errno conversion recognizes errors from another VM realm', () => {
    const foreignError = vm.runInNewContext(
        'Object.assign(new Error("foreign"), { code })',
        { code: nativeError.errno.ENOENT },
    ) as Error;
    const converted = toErrnoException(foreignError, 'read');

    strictEqual(converted.message, 'foreign');
    strictEqual(converted.code, 'ENOENT');
    strictEqual(converted.errno, nativeError.errno.ENOENT);
    strictEqual(converted.syscall, 'read');
    strictEqual(matchesErrnoCode(foreignError, 'ENOENT'), true);
    strictEqual(isTransportDisconnectError(foreignError), false);

    const foreignDisconnect = vm.runInNewContext(
        'Object.assign(new Error("peer closed"), { code })',
        { code: nativeError.errno.ECONNRESET },
    ) as Error;
    strictEqual(isTransportDisconnectError(foreignDisconnect), true);
});

Deno.test('DNS ENOTFOUND retains libuv EAI_NONAME errno', () => {
    const nativeDnsError = Object.assign(new Error('lookup failed'), { code: 'EAI_NONAME' });
    const normalized = normalizeLookupError(nativeDnsError, 'missing.invalid');

    strictEqual(normalized.code, 'ENOTFOUND');
    strictEqual(normalized.errno, errnoCode('EAI_NONAME'));
    strictEqual(normalized.syscall, 'getaddrinfo');
    strictEqual(normalized.hostname, 'missing.invalid');
});

Deno.test('DNS lookup retains distinct UV errors without guessing from ENOTFOUND', () => {
    for (const name of ['EAI_NONAME', 'EAI_NODATA'] as const) {
        const errno = errnoCode(name)!;
        const source = Object.freeze(Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND', errno }));
        const lookup = normalizeLookupError(source, 'missing.invalid');
        const service = normalizeLookupServiceError(source, '192.0.2.1');
        for (const result of [lookup, service]) {
            strictEqual(result.code, 'ENOTFOUND');
            strictEqual(result.errno, errno);
        }
    }
    const ambiguous = Object.freeze(Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }));
    strictEqual(normalizeLookupError(ambiguous, 'missing.invalid').errno, undefined);
    strictEqual(createDnsError('ECONNREFUSED', 'queryA', 'missing.invalid').errno, undefined);
    strictEqual(createDnsError(nativeError.errno.EINVAL, 'getHostByAddr', 'invalid').errno, nativeError.errno.EINVAL);
});

Deno.test('DNS query string codes stay separate from numeric UV errors', async () => {
    const dns = import.meta.use('dns');
    const descriptor = Object.getOwnPropertyDescriptor(dns, 'query')!;
    try {
        for (const code of ['ECONNREFUSED', nativeError.errno.ECONNREFUSED]) {
            const source = Object.freeze(Object.assign(new Error('query refused'), { code }));
            Object.defineProperty(dns, 'query', {
                configurable: true,
                value: () => Promise.reject(source),
            });
            const error = await queryDns('missing.invalid', 'A', ['127.0.0.1'], { timeout: 50, tries: 1 }).then(
                () => { throw new Error('query unexpectedly succeeded'); },
                error => error,
            );
            strictEqual(error.code, 'ECONNREFUSED');
            strictEqual(error.errno, typeof code === 'number' ? code : undefined);
        }
    } finally {
        Object.defineProperty(dns, 'query', descriptor);
    }
});

Deno.test('native DNS errors preserve numeric UV status in sync and async lookups', async () => {
    const dns = import.meta.use('dns');
    const os = import.meta.use('os');
    const hostname = 'cno-dns-error.invalid';
    const options = { family: os.AF_UNSPEC };
    for (const resolve of [() => dns.resolve(hostname, options), () => dns.resolveSync(hostname, options)]) {
        const error = await Promise.resolve().then(resolve).then(
            () => { throw new Error('invalid DNS name unexpectedly resolved'); },
            error => error as NodeJS.ErrnoException,
        );
        strictEqual(error.code, 'ENOTFOUND');
        strictEqual(typeof error.errno, 'number');
        strictEqual(error.errno === errnoCode('EAI_NONAME') || error.errno === errnoCode('EAI_NODATA'), true);
        const normalized = normalizeLookupError(error, hostname);
        strictEqual(normalized.errno, error.errno);
    }
});

Deno.test('errno matching ignores non-errors and inaccessible code properties', () => {
    const codedObject = { code: 'ECONNRESET' };
    const spoofedError = { code: 'ECONNRESET', [Symbol.toStringTag]: 'Error' };
    const inaccessibleError = new Proxy(new Error('blocked'), {
        get(target, property, receiver) {
            if (property === 'code') throw new Error('code getter failed');
            return Reflect.get(target, property, receiver);
        },
    });

    strictEqual(matchesErrnoCode(codedObject, 'ECONNRESET'), false);
    strictEqual(matchesErrnoCode(spoofedError, 'ECONNRESET'), false);
    strictEqual(matchesErrnoCode(inaccessibleError, 'ECONNRESET'), false);
    strictEqual(isTransportDisconnectError(codedObject), false);
});

Deno.test('SystemError has one shared Node-facing shape', () => {
    const error = createSystemError({
        nativeCode: 'ENOTSOCK',
        syscall: 'uv_recv_buffer_size',
        code: 'ERR_SOCKET_BUFFER_SIZE',
        prefix: 'Could not get or set buffer size',
    });

    strictEqual(error.code, 'ERR_SOCKET_BUFFER_SIZE');
    strictEqual(error.errno, errnoCode('ENOTSOCK'));
    strictEqual(error.name, 'SystemError');
    strictEqual(Object.keys(error).includes('name'), false);
    deepStrictEqual(Object.keys(error), ['code', 'errno', 'syscall', 'info']);
    strictEqual(
        error.message,
        `Could not get or set buffer size: uv_recv_buffer_size returned ENOTSOCK (${error.info.message})`,
    );
    deepStrictEqual(error.info, {
        errno: errnoCode('ENOTSOCK'),
        code: 'ENOTSOCK',
        message: nativeError.getErrorMessage(errnoCode('ENOTSOCK')!),
        syscall: 'uv_recv_buffer_size',
    });
    strictEqual(unknownErrno, nativeError.errno.UNKNOWN);
});
