import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { inspectOptions } from '../../src/inspector/options.ts';

Deno.test('inspector: bare --inspect defaults to 127.0.0.1:9229, no break', () => {
    deepStrictEqual(inspectOptions({ inspect: true }), {
        host: '127.0.0.1', port: 9229, breakOnStart: false, waitForClient: false,
    });
});

Deno.test('inspector: --inspect=9333 parses custom port, default host', () => {
    const options = inspectOptions({ inspect: '9333' })!;
    strictEqual(options.host, '127.0.0.1');
    strictEqual(options.port, 9333);
});

Deno.test('inspector: --inspect=0.0.0.0:9444 splits host and port', () => {
    const options = inspectOptions({ inspect: '0.0.0.0:9444' })!;
    strictEqual(options.host, '0.0.0.0');
    strictEqual(options.port, 9444);
});

Deno.test('inspector: --inspect-brk requests an initial breakpoint', () => {
    deepStrictEqual(inspectOptions({ 'inspect-brk': true }), {
        host: '127.0.0.1', port: 9229, breakOnStart: true, waitForClient: false,
    });
});

Deno.test('inspector: --inspect-wait requests a client before execution', () => {
    deepStrictEqual(inspectOptions({ 'inspect-wait': true }), {
        host: '127.0.0.1', port: 9229, breakOnStart: false, waitForClient: true,
    });
});

Deno.test('inspector: absent or disabled flags return null', () => {
    strictEqual(inspectOptions({}), null);
    strictEqual(inspectOptions({ silent: true }), null);
    strictEqual(inspectOptions({ inspect: false, 'inspect-brk': false, 'inspect-wait': false }), null);
});

Deno.test('inspector: a bare hostname uses the default port', () => {
    const options = inspectOptions({ inspect: 'localhost' })!;
    strictEqual(options.host, 'localhost');
    strictEqual(options.port, 9229);
});

Deno.test('inspector: inspect-brk address takes precedence and preserves both modes', () => {
    deepStrictEqual(inspectOptions({ inspect: true, 'inspect-brk': '9333', 'inspect-wait': '9444' }), {
        host: '127.0.0.1', port: 9333, breakOnStart: true, waitForClient: true,
    });
});

Deno.test('inspector: --inspect=true string is treated as bare flag', () => {
    deepStrictEqual(inspectOptions({ inspect: 'true' }), inspectOptions({ inspect: true }));
});

Deno.test('inspector: empty host before colon defaults to 127.0.0.1', () => {
    const options = inspectOptions({ inspect: ':9555' })!;
    strictEqual(options.host, '127.0.0.1');
    strictEqual(options.port, 9555);
});

Deno.test('inspector: surrounding address whitespace is trimmed', () => {
    const options = inspectOptions({ inspect: ' 0.0.0.0:9444 ' })!;
    strictEqual(options.host, '0.0.0.0');
    strictEqual(options.port, 9444);
});

Deno.test('inspector: port 0 requests an available port', () => {
    for (const address of ['0', '127.0.0.1:0', '[::1]:0']) {
        strictEqual(inspectOptions({ inspect: address })!.port, 0, address);
    }
});

Deno.test('inspector: malformed addresses and ports are rejected', () => {
    for (const address of [
        '', ' ', '65536', '127.0.0.1:65536', 'localhost:', 'localhost:abc',
        'localhost:-1', 'localhost:1.5', 'host name:9229', '0.0.0.0 :9444',
        '[::1', '::1]', '[::1]:abc', '[::1]:65536',
    ]) {
        throws(() => inspectOptions({ inspect: address }), /Inspector (?:address|port)/, address);
    }
});

Deno.test('inspector: inspect-wait takes precedence over inspect', () => {
    deepStrictEqual(inspectOptions({ inspect: '9333', 'inspect-wait': '9444' }), {
        host: '127.0.0.1', port: 9444, breakOnStart: false, waitForClient: true,
    });
});

Deno.test('inspector: bare IPv6 addresses remain hosts', () => {
    for (const host of ['::1', '2001:db8::1']) {
        const options = inspectOptions({ inspect: host })!;
        strictEqual(options.host, host);
        strictEqual(options.port, 9229);
    }
});

Deno.test('inspector: bracketed IPv6 supports default and explicit ports', () => {
    for (const [address, port] of [['[::1]', 9229], ['[::1]:9444', 9444]] as const) {
        const options = inspectOptions({ inspect: address })!;
        strictEqual(options.host, '::1');
        strictEqual(options.port, port);
    }
});
