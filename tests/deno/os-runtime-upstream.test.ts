import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

const internal = Deno[Deno.internal] as unknown as {
    inspectArgs(args: unknown[]): string;
    pathFromURL(url: URL): string;
};

Deno.test('deno upstream: internal pathFromURL converts file URLs and rejects non-file URLs', () => {
    strictEqual(internal.pathFromURL(new URL('file:///test/directory')), '/test/directory');
    strictEqual(internal.pathFromURL(new URL('file:///space_%20.txt')), '/space_ .txt');
    throws(() => internal.pathFromURL(new URL('https://deno.land/welcome.ts')), TypeError);
});

Deno.test('deno upstream: internal inspectArgs is exposed for test helpers', () => {
    strictEqual(typeof internal.inspectArgs, 'function');
    strictEqual(internal.inspectArgs([{ a: 1 }, 'x']), '{ a: 1 } x');
});

Deno.test('deno upstream: version build system and symbol metadata expose expected public shapes', () => {
    const versionPattern = /^\d+\.\d+\.\d+/;
    ok(versionPattern.test(Deno.version.deno));
    ok(versionPattern.test(Deno.version.v8));
    strictEqual(Deno.version.typescript, '5.9.2');
    ok(['darwin', 'linux', 'windows'].includes(Deno.build.os));
    ok(Deno.build.arch.length > 0);
    strictEqual(typeof Symbol.metadata, 'symbol');
});

Deno.test('deno upstream: selected ESNext collection and typed-array helpers are present', () => {
    strictEqual(['a', 'b', 'c', 'd', 'e', 'f'].findLast((value) => typeof value === 'string'), 'f');
    strictEqual(['a', 'b', 'c', 'd', 'e', 'f'].findLastIndex((value) => typeof value === 'string'), 5);

    const union = new Set([1, 2, 3]).union(new Set([3, 4, 5]));
    deepStrictEqual([...union], [1, 2, 3, 4, 5]);

    const sorted = Float16Array.from([11.25, 2, -22.5, 1]).toSorted((a, b) => a - b);
    deepStrictEqual(Array.from(sorted), [-22.5, 1, 2, 11.25]);
});

Deno.test('deno upstream: noColor follows NO_COLOR only when non-empty', async () => {
    const empty = await new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log(Deno.noColor)'],
        env: { NO_COLOR: '' },
    }).output();
    strictEqual(empty.success, true);
    strictEqual(decodeUtf8(empty.stdout), 'false\n');

    const set = await new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log(Deno.noColor)'],
        env: { NO_COLOR: '1' },
    }).output();
    strictEqual(set.success, true);
    strictEqual(decodeUtf8(set.stdout), 'true\n');
});

Deno.test('deno upstream: system info helpers return stable shapes', () => {
    const load = Deno.loadavg();
    strictEqual(load.length, 3);
    ok(load.every((value) => typeof value === 'number' && value >= 0));

    strictEqual(typeof Deno.hostname(), 'string');
    ok(Deno.hostname().length > 0);
    strictEqual(typeof Deno.osRelease(), 'string');
    ok(Deno.osRelease().length > 0);
    strictEqual(typeof Deno.osUptime(), 'number');
    ok(Deno.osUptime() > 0);

    const info = Deno.systemMemoryInfo();
    for (const key of ['total', 'free', 'available', 'buffers', 'cached', 'swapTotal', 'swapFree'] as const) {
        ok(typeof info[key] === 'number' && info[key] >= 0, `systemMemoryInfo.${key} must be non-negative`);
    }

    const usage = Deno.memoryUsage();
    ok(usage.rss >= usage.heapTotal);
    ok(usage.heapTotal >= usage.heapUsed);
});

Deno.test('deno upstream: execPath uid and gid expose public OS values', () => {
    const execPath = Deno.execPath();
    ok(execPath.length > 0);
    strictEqual(Deno.statSync(execPath).isFile, true);

    if (Deno.build.os === 'windows') {
        strictEqual(Deno.uid(), null);
        strictEqual(Deno.gid(), null);
    } else {
        const uid = Deno.uid();
        const gid = Deno.gid();
        ok(Number.isInteger(uid) && uid >= 0);
        ok(Number.isInteger(gid) && gid >= 0);
    }
});

Deno.test('deno upstream: networkInterfaces returns Deno shaped entries', () => {
    let interfaces: Deno.NetworkInterfaceInfo[];
    try {
        interfaces = Deno.networkInterfaces();
    } catch (error) {
        ok(error instanceof Deno.errors.NotSupported);
        ok(String(error).includes('EPERM'));
        return;
    }

    ok(Array.isArray(interfaces));
    ok(interfaces.length > 0);

    for (const { name, family, address, netmask, scopeid, cidr, mac } of interfaces) {
        strictEqual(typeof name, 'string');
        ok(family === 'IPv4' || family === 'IPv6');
        strictEqual(typeof address, 'string');
        strictEqual(typeof netmask, 'string');
        if (family === 'IPv6') strictEqual(typeof scopeid, 'number');
        else strictEqual(scopeid, null);
        strictEqual(typeof cidr, 'string');
        strictEqual(typeof mac, 'string');
    }
});

Deno.test({
    name: 'deno upstream: umask returns the previous process mask',
    ignore: Deno.build.os === 'windows',
}, () => {
    const prevMask = Deno.umask(0o020);
    const newMask = Deno.umask(prevMask);
    const finalMask = Deno.umask();
    strictEqual(newMask, 0o020);
    strictEqual(finalMask, prevMask);
});

Deno.test('deno upstream: child process ppid matches parent pid', async () => {
    const child = await new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log(Deno.ppid)'],
        env: { NO_COLOR: '1' },
    }).output();
    strictEqual(child.success, true);
    strictEqual(Number(decodeUtf8(child.stdout).trim()), Deno.pid);
});

Deno.test('deno upstream: timer web compatibility edge cases', async () => {
    let capturedThis: unknown;
    await new Promise<void>((resolve) => {
        setTimeout(function () {
            capturedThis = this;
            resolve();
        }, 1);
    });
    strictEqual(capturedThis, globalThis);

    for (const thisArg of [null, undefined, globalThis]) {
        await new Promise<void>((resolve) => {
            setTimeout.call(thisArg, () => resolve(), 1);
        });
    }

    for (const thisArg of [0, '', true, false, {}, [], 'foo', () => {}, Object.prototype]) {
        throws(() => setTimeout.call(thisArg, () => {}, 1), TypeError);
    }

    let valueOfCalled = false;
    clearTimeout({
        valueOf() {
            valueOfCalled = true;
            return 1;
        },
    } as unknown as number);
    strictEqual(valueOfCalled, true);

    strictEqual(clearTimeout.name, 'clearTimeout');
    strictEqual(clearInterval.name, 'clearInterval');
    strictEqual(setTimeout.length, 1);
    strictEqual(setInterval.length, 1);
    strictEqual(clearTimeout.length, 0);
    strictEqual(clearInterval.length, 0);
    ok(clearTimeout !== clearInterval);
});
