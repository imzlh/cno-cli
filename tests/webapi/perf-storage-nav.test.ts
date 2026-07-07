import { deepStrictEqual, notStrictEqual, strictEqual, ok, rejects, throws } from 'node:assert';

// ============================================================================
// performance / storage / navigator
// ============================================================================

// --- performance -----------------------------------------------------------

Deno.test('performance: now() returns a number', () => {
    const t = performance.now();
    ok(typeof t === 'number' && t >= 0);
});

Deno.test('performance: now() is monotonic', () => {
    const a = performance.now();
    const b = performance.now();
    ok(b >= a, 'performance.now must be monotonic');
});

Deno.test('performance: timeOrigin is a number', () => {
    ok(typeof performance.timeOrigin === 'number');
});

Deno.test('performance: mark + measure', () => {
    performance.mark('start');
    for (let i = 0; i < 1000; i++) {} // some work
    performance.mark('end');
    performance.measure('loop', 'start', 'end');
    const entries = performance.getEntriesByType('measure');
    ok(entries.length >= 1);
    ok(entries.some((e) => e.name === 'loop'));
});

Deno.test('performance: getEntries returns PerformanceEntry list', () => {
    performance.mark('x-mark');
    const marks = performance.getEntriesByType('mark');
    ok(Array.isArray(marks));
    ok(marks.some((m) => m.name === 'x-mark'));
});

Deno.test('performance: clearMarks / clearMeasures', () => {
    performance.mark('to-clear');
    performance.clearMarks('to-clear');
    const marks = performance.getEntriesByName('to-clear', 'mark');
    strictEqual(marks.length, 0);
});

Deno.test('performance: toJSON returns object', () => {
    const obj = performance.toJSON();
    ok(obj && typeof obj === 'object');
});

Deno.test('performance upstream: toJSON contains only timeOrigin', () => {
    const json = performance.toJSON() as { timeOrigin: number };
    deepStrictEqual(Object.keys(json), ['timeOrigin']);
    strictEqual(json.timeOrigin, performance.timeOrigin);
});

Deno.test('performance upstream: mark returns entries and clones detail', () => {
    performance.clearMarks();

    const mark = performance.mark('upstream-mark');
    ok(mark instanceof PerformanceMark);
    strictEqual(mark.detail, null);
    strictEqual(mark.name, 'upstream-mark');
    strictEqual(mark.entryType, 'mark');
    strictEqual(mark.duration, 0);
    strictEqual(performance.getEntries().at(-1), mark);
    strictEqual(performance.getEntriesByName('upstream-mark', 'mark').at(-1), mark);

    const detail = { foo: 'foo' };
    const objectMark = performance.mark('upstream-detail-object', { detail });
    deepStrictEqual(objectMark.detail, { foo: 'foo' });
    notStrictEqual(objectMark.detail, detail);

    const buffer = new ArrayBuffer(10);
    const bufferMark = performance.mark('upstream-detail-buffer', { detail: buffer });
    deepStrictEqual(bufferMark.detail, new ArrayBuffer(10));
    notStrictEqual(bufferMark.detail, buffer);

    class SubUint8Array extends Uint8Array {}
    const typed = new SubUint8Array([1, 2]);
    const typedMark = performance.mark('upstream-detail-typed', { detail: typed });
    ok(typedMark.detail instanceof Uint8Array);
    deepStrictEqual([...typedMark.detail], [1, 2]);
    strictEqual(typedMark.detail instanceof SubUint8Array, false);
});

Deno.test('performance upstream: measure and clear functions follow public semantics', () => {
    performance.clearMarks();
    performance.clearMeasures();

    const fromStart = performance.measure('upstream-from-start');
    ok(fromStart instanceof PerformanceMeasure);
    strictEqual(fromStart.detail, null);
    strictEqual(fromStart.entryType, 'measure');
    strictEqual(fromStart.startTime, 0);

    const mark = performance.mark('upstream-mark-a');
    const fromMark = performance.measure('upstream-from-mark', 'upstream-mark-a');
    strictEqual(fromMark.startTime, mark.startTime);

    performance.measure('upstream-from-start');
    const measuresNum = performance.getEntriesByType('measure').length;
    performance.clearMeasures('upstream-from-start');
    strictEqual(performance.getEntriesByType('measure').length, measuresNum - 2);

    performance.clearMeasures();
    strictEqual(performance.getEntriesByType('measure').length, 0);
    performance.clearMarks();

    performance.clearResourceTimings();
    deepStrictEqual(performance.getEntriesByType('resource'), []);
    performance.setResourceTimingBufferSize(100);
    performance.setResourceTimingBufferSize(0);
    throws(() => (performance.setResourceTimingBufferSize as () => void)(), TypeError);
});

Deno.test('performance upstream: measure uses the most recent mark with a duplicate name', async () => {
    performance.clearMarks();
    performance.clearMeasures();

    const first = performance.mark('upstream-duplicate-mark');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = performance.mark('upstream-duplicate-mark');
    const measure = performance.measure('upstream-from-latest-mark', 'upstream-duplicate-mark');

    strictEqual(measure.startTime, second.startTime);
    ok(measure.startTime >= first.startTime);
});

Deno.test('performance: markResourceTiming records resource entries without throwing', () => {
    performance.clearResourceTimings();
    performance.setResourceTimingBufferSize(100);

    const entry = performance.markResourceTiming(
        { startTime: 5, endTime: 17 },
        'http://example.test/resource',
        'fetch',
        globalThis,
        '',
        { encodedBodySize: 42 },
        200,
    );

    ok(entry instanceof PerformanceResourceTiming);
    strictEqual(entry.name, 'http://example.test/resource');
    strictEqual(entry.entryType, 'resource');
    strictEqual(entry.startTime, 5);
    strictEqual(entry.duration, 12);
    strictEqual(entry.initiatorType, 'fetch');
    strictEqual(entry.transferSize, 42);
    strictEqual(performance.getEntriesByName('http://example.test/resource', 'resource').at(-1), entry);

    const markResourceTiming = performance.markResourceTiming;
    const unbound = markResourceTiming({ startTime: 1, endTime: 2 }, 'http://example.test/unbound', 'fetch');
    strictEqual(unbound.name, 'http://example.test/unbound');
    strictEqual(performance.getEntriesByName('http://example.test/unbound', 'resource').at(-1), unbound);
});

Deno.test('performance upstream: constructor guards and EventTarget inheritance', async () => {
    throws(() => new (Performance as unknown as { new(): Performance })(), TypeError);
    strictEqual(Performance.length, 0);
    throws(() => new (PerformanceEntry as unknown as { new(): PerformanceEntry })(), TypeError);
    strictEqual(PerformanceEntry.length, 0);
    throws(() => new (PerformanceMeasure as unknown as { new(): PerformanceMeasure })(), TypeError);

    ok(performance instanceof EventTarget);
    await new Promise<void>((resolve) => {
        performance.addEventListener('upstream-performance-event', () => resolve(), { once: true });
        performance.dispatchEvent(new Event('upstream-performance-event'));
    });
});

Deno.test('performance upstream: Deno.inspect includes performance class names', () => {
    const mark = performance.mark('upstream-inspect-mark');
    const measure = performance.measure('upstream-inspect-measure');

    ok(Deno.inspect(performance, { colors: false }).includes('Performance'));
    ok(Deno.inspect(Performance.prototype, { colors: false }).includes('Performance'));
    ok(Deno.inspect(mark, { colors: false }).includes('PerformanceMark'));
    ok(Deno.inspect(PerformanceMark.prototype, { colors: false }).includes('PerformanceMark'));
    ok(Deno.inspect(measure, { colors: false }).includes('PerformanceMeasure'));
    ok(Deno.inspect(PerformanceMeasure.prototype, { colors: false }).includes('PerformanceMeasure'));
});

// --- storage (localStorage) ------------------------------------------------

const storagePrefix = `cno-perf-storage-nav-${Deno.pid}-${Date.now()}-`;
const storageKey = (name: string) => `${storagePrefix}${name}`;

const matchingStorageKeys = (storage: Storage, prefix: string): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
};

const removeStorageKeys = (storage: Storage, ...keys: string[]) => {
    for (const key of keys) storage.removeItem(key);
};

Deno.test('localStorage: setItem/getItem/removeItem', () => {
    const key = storageKey('round-trip');
    localStorage.setItem(key, 'v1');
    strictEqual(localStorage.getItem(key), 'v1');
    localStorage.removeItem(key);
    strictEqual(localStorage.getItem(key), null);
});

Deno.test('localStorage: length and key()', () => {
    const a = storageKey('a');
    const b = storageKey('b');
    removeStorageKeys(localStorage, a, b);
    localStorage.setItem(a, '1');
    localStorage.setItem(b, '2');
    deepStrictEqual(matchingStorageKeys(localStorage, storagePrefix).sort(), [a, b].sort());
    removeStorageKeys(localStorage, a, b);
});

Deno.test('localStorage: removeItem empties selected entries', () => {
    const x = storageKey('x');
    const y = storageKey('y');
    localStorage.setItem(x, '1');
    localStorage.setItem(y, '2');
    removeStorageKeys(localStorage, x, y);
    strictEqual(localStorage.getItem(x), null);
    strictEqual(localStorage.getItem(y), null);
});

Deno.test('localStorage: bracket access works', () => {
    const key = storageKey('bk');
    localStorage.setItem(key, 'bv');
    ok(localStorage.getItem(key) !== null);
    localStorage.removeItem(key);
});

Deno.test('localStorage: overwriting replaces value', () => {
    const key = storageKey('ov');
    localStorage.setItem(key, 'first');
    localStorage.setItem(key, 'second');
    strictEqual(localStorage.getItem(key), 'second');
    localStorage.removeItem(key);
});

Deno.test('localStorage: Web Storage methods stringify keys and values', () => {
    const key = storageKey('123');
    localStorage.setItem(key as unknown as string, 456 as unknown as string);
    strictEqual(localStorage.getItem(key), '456');
    strictEqual(localStorage.getItem(key as unknown as string), '456');
    ok(matchingStorageKeys(localStorage, storagePrefix).includes(key));
    localStorage.removeItem(key as unknown as string);
    strictEqual(localStorage.getItem(key), null);
});

Deno.test('localStorage upstream: quota errors leave failed entries unset', () => {
    const key = storageKey('quota');
    localStorage.removeItem(key);

    throws(() => {
        localStorage.setItem(key, 'v'.repeat(11 * 1024 * 1024));
    }, { name: 'QuotaExceededError' });
    strictEqual(localStorage.getItem(key), null);

    throws(() => {
        localStorage.setItem(`${key}-large-key`.repeat(512 * 1024), 'v');
    }, { name: 'QuotaExceededError' });
});

Deno.test('sessionStorage: basic round-trip', () => {
    const key = storageKey('sk');
    sessionStorage.setItem(key, 'sv');
    strictEqual(sessionStorage.getItem(key), 'sv');
    sessionStorage.removeItem(key);
    strictEqual(sessionStorage.getItem(key), null);
});

// --- navigator -------------------------------------------------------------

Deno.test('navigator: userAgent is a string', () => {
    ok(typeof navigator.userAgent === 'string' && navigator.userAgent.length > 0);
});

Deno.test('navigator: platform is a string', () => {
    ok(typeof navigator.platform === 'string');
});

Deno.test('navigator: language is a string', () => {
    ok(typeof navigator.language === 'string');
});

Deno.test('navigator: languages is an array of strings', () => {
    ok(Array.isArray(navigator.languages));
    ok(navigator.languages.every((l) => typeof l === 'string'));
});

Deno.test({ name: 'navigator: language falls back across locale env vars', timeout: 10000 }, async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', 'console.log(JSON.stringify({ language: navigator.language, languages: navigator.languages }))'],
        clearEnv: true,
        env: { LC_ALL: 'zh_CN.UTF-8' },
    }).output();

    strictEqual(output.success, true);
    strictEqual(new TextDecoder().decode(output.stderr), '');
    deepStrictEqual(JSON.parse(new TextDecoder().decode(output.stdout)), {
        language: 'zh-CN',
        languages: ['zh-CN', 'zh'],
    });
});

Deno.test('navigator: hardwareConcurrency is a positive number', () => {
    ok(typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0);
});

Deno.test('navigator upstream: userAgentData exposes low entropy data and selected high entropy hints', async () => {
    ok(navigator.userAgent.includes('cno/'));
    ok(navigator.userAgent.includes('deno/'));

    const data = navigator.userAgentData;
    ok(data instanceof NavigatorUAData);
    strictEqual(data.mobile, false);
    strictEqual(data.platform, navigator.platform);
    ok(Array.isArray(data.brands));
    ok(data.brands.length >= 1);
    ok(data.brands.every((brand) => typeof brand.brand === 'string' && typeof brand.version === 'string'));

    deepStrictEqual(data.toJSON(), {
        brands: data.brands,
        mobile: false,
        platform: navigator.platform,
    });

    const highEntropy = await data.getHighEntropyValues(['fullVersionList', 'mobile', 'platform', 'not-a-hint']);
    strictEqual(highEntropy.mobile, false);
    strictEqual(highEntropy.platform, navigator.platform);
    deepStrictEqual(highEntropy.fullVersionList, data.brands);
    strictEqual('not-a-hint' in highEntropy, false);

    throws(() => new Navigator(), TypeError);
    throws(() => new NavigatorUAData(), TypeError);
});

Deno.test('navigator: onLine is boolean', () => {
    ok(typeof navigator.onLine === 'boolean');
});

Deno.test('navigator: permissions is an object', () => {
    ok(navigator.permissions && typeof navigator.permissions === 'object');
});

Deno.test('navigator: clipboard is an object', () => {
    ok(navigator.clipboard && typeof navigator.clipboard === 'object');
});

Deno.test('navigator.permissions: query returns cached PermissionStatus by name', async () => {
    const first = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    const second = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    strictEqual(first, second);
    strictEqual(first.name, 'clipboard-read');
    strictEqual(first.state, 'granted');

    const geo = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    strictEqual(geo.state, 'prompt');
    strictEqual(typeof geo.addEventListener, 'function');
});

Deno.test('navigator.permissions: query rejects invalid descriptors', async () => {
    await rejects(
        () => navigator.permissions.query(undefined as unknown as PermissionDescriptor),
        TypeError,
    );
    await rejects(
        () => navigator.permissions.query({} as PermissionDescriptor),
        TypeError,
    );
    await rejects(
        () => navigator.permissions.query({ name: 'not-real' as PermissionName }),
        TypeError,
    );
});

Deno.test('navigator.storage: estimate and persistence methods resolve', async () => {
    const estimate = await navigator.storage.estimate();
    ok(typeof estimate.usage === 'number' && estimate.usage >= 0);
    ok(typeof estimate.quota === 'number' && estimate.quota > 0);
    ok(estimate.usageDetails && typeof estimate.usageDetails === 'object');
    strictEqual(await navigator.storage.persist(), true);
    strictEqual(await navigator.storage.persisted(), true);
});

Deno.test('navigator.clipboard: text round-trip and unsupported rich clipboard APIs', async () => {
    await navigator.clipboard.writeText('clip-text');
    strictEqual(await navigator.clipboard.readText(), 'clip-text');

    let readError: DOMException | null = null;
    try { await navigator.clipboard.read(); } catch (e) { readError = e as DOMException; }
    ok(readError instanceof DOMException);
    strictEqual(readError.name, 'NotSupportedError');

    let writeError: DOMException | null = null;
    try { await navigator.clipboard.write([]); } catch (e) { writeError = e as DOMException; }
    ok(writeError instanceof DOMException);
    strictEqual(writeError.name, 'NotSupportedError');
});

Deno.test('navigator upstream: share APIs report unsupported without side effects', async () => {
    strictEqual(navigator.canShare(), false);
    strictEqual(navigator.canShare({ title: 'hello', text: 'world', url: 'https://example.invalid/' }), false);

    await rejects(
        () => navigator.share({ title: 'hello' }),
        { name: 'NotSupportedError' },
    );
});

Deno.test('navigator: getBattery returns cached full battery status', async () => {
    const nav = navigator as Navigator & { getBattery(): Promise<any> };
    const first = await nav.getBattery();
    const second = await nav.getBattery();
    strictEqual(first, second);
    strictEqual(first.charging, true);
    strictEqual(first.chargingTime, 0);
    strictEqual(first.dischargingTime, Infinity);
    strictEqual(first.level, 1);
});

Deno.test('navigator.connection: exposes stable network information shape', () => {
    const connection = (navigator as Navigator & { connection: any }).connection;
    ok(connection);
    ok(['4g', '3g', '2g', 'slow-2g'].includes(connection.effectiveType));
    ok(typeof connection.downlink === 'number' && connection.downlink >= 0);
    ok(typeof connection.downlinkMax === 'number' && connection.downlinkMax >= connection.downlink);
    ok(typeof connection.rtt === 'number' && connection.rtt >= 0);
    strictEqual(typeof connection.saveData, 'boolean');
    ok(['bluetooth', 'cellular', 'ethernet', 'none', 'wifi', 'wimax', 'other', 'unknown'].includes(connection.type));
});

Deno.test('navigator.opensocket: exposes direct socket entry points without opening sockets', () => {
    const direct = (navigator as Navigator & { opensocket: any }).opensocket;
    ok(direct && typeof direct === 'object');
    strictEqual(typeof direct.openTCPSocket, 'function');
    strictEqual(typeof direct.openUDPSocket, 'function');
});
