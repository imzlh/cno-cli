// Derived from Deno upstream unit/{event_target,event,dom_exception,progressevent,text_encoding,headers,request,response,body,webstorage,blob,file}_test.ts public API cases.
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';

const asBlobPart = (value: unknown): BlobPart => value as BlobPart;

Deno.test('webapi upstream: EventTarget removeEventListener matches listener and capture', () => {
    const target = new EventTarget();
    let count = 0;
    const listener = () => { count++; };

    target.addEventListener('incr', listener, true);
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 1);

    target.removeEventListener('incr', listener, false);
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 2);

    target.removeEventListener('incr', listener, true);
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 2);

    target.addEventListener('incr', listener, { passive: true });
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 3);

    target.removeEventListener('incr', listener, { capture: true });
    target.removeEventListener('incr', listener, true);
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 4);

    target.removeEventListener('incr', listener);
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 4);

    target.addEventListener('incr', listener, { passive: true });
    target.removeEventListener('incr', listener, false);
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 4);

    target.addEventListener('incr', listener, { passive: true });
    target.removeEventListener('incr', listener, { capture: false });
    target.dispatchEvent(new Event('incr'));
    strictEqual(count, 4);
});

Deno.test('webapi upstream: EventTarget object listeners target persistence and listener snapshot', () => {
    const target = new EventTarget();
    const event = new Event('foo');
    let count = 0;
    const seenTargets: Array<EventTarget | null> = [];
    const listener = {
        handleEvent(e: Event) {
            seenTargets.push(e.target);
            count++;
            target.addEventListener('foo', () => { count++; });
        },
    };

    strictEqual(Object.prototype.toString.call(target), '[object EventTarget]');
    target.addEventListener('foo', listener);
    target.dispatchEvent(event);
    strictEqual(count, 1);
    strictEqual(event.target, target);
    strictEqual(event.currentTarget, null);
    deepStrictEqual(seenTargets, [target]);

    target.removeEventListener('foo', listener);
    target.dispatchEvent(new Event('foo'));
    strictEqual(count, 2);
});

Deno.test('webapi upstream: EventTarget subclass object-prototype event names and duplicate listeners', () => {
    class NicerEventTarget extends EventTarget {
        on(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions) {
            this.addEventListener(type, callback, options);
        }
        off(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions) {
            this.removeEventListener(type, callback, options);
        }
    }

    const target = new NicerEventTarget();
    let count = 0;
    const listener = () => { count++; };

    target.on('toString', listener);
    target.on('toString', listener, { once: true });
    target.dispatchEvent(new Event('toString'));
    target.dispatchEvent(new Event('toString'));
    strictEqual(count, 2);

    target.off('toString', listener);
    target.dispatchEvent(new Event('toString'));
    strictEqual(count, 2);
});

Deno.test('webapi upstream: EventTarget dispatch tracks phase target and cancelation result', () => {
    const target = new EventTarget();
    const cancelable = new Event('phase', { cancelable: true });
    const seen: Array<[EventTarget | null, EventTarget | null, number]> = [];

    target.addEventListener('phase', (event) => {
        seen.push([event.target, event.currentTarget, event.eventPhase]);
        event.preventDefault();
    });

    strictEqual(target.dispatchEvent(cancelable), false);
    deepStrictEqual(seen, [[target, target, Event.AT_TARGET]]);
    strictEqual(cancelable.target, target);
    strictEqual(cancelable.currentTarget, null);
    strictEqual(cancelable.eventPhase, Event.NONE);

    strictEqual(target.dispatchEvent(new Event('phase')), true);
});

Deno.test('webapi upstream: EventTarget dispatch skips listeners removed before their turn', () => {
    const target = new EventTarget();
    const calls: string[] = [];
    const second = () => calls.push('second');

    target.addEventListener('remove-during-dispatch', () => {
        calls.push('first');
        target.removeEventListener('remove-during-dispatch', second);
    });
    target.addEventListener('remove-during-dispatch', second);

    target.dispatchEvent(new Event('remove-during-dispatch'));
    deepStrictEqual(calls, ['first']);
});

Deno.test('webapi upstream: EventTarget stopPropagation keeps same-target listeners but stopImmediatePropagation stops them', () => {
    const target = new EventTarget();
    const propagationCalls: string[] = [];
    target.addEventListener('propagation', (event) => {
        propagationCalls.push('first');
        event.stopPropagation();
    });
    target.addEventListener('propagation', () => propagationCalls.push('second'));
    target.dispatchEvent(new Event('propagation'));
    deepStrictEqual(propagationCalls, ['first', 'second']);

    const immediateCalls: string[] = [];
    target.addEventListener('immediate', (event) => {
        immediateCalls.push('first');
        event.stopImmediatePropagation();
    });
    target.addEventListener('immediate', () => immediateCalls.push('second'));
    target.dispatchEvent(new Event('immediate'));
    deepStrictEqual(immediateCalls, ['first']);
});

Deno.test('webapi upstream: EventTarget null listener is no-op but brand checks still apply', () => {
    const target = new EventTarget();
    strictEqual(target.addEventListener('x', null, false), undefined);
    strictEqual(target.removeEventListener('x', null, true), undefined);

    throws(() => {
        Reflect.apply(EventTarget.prototype.addEventListener, {}, ['x', null]);
    }, TypeError);
    throws(() => {
        Reflect.apply(EventTarget.prototype.removeEventListener, {}, ['x', null]);
    }, TypeError);
    throws(() => {
        Reflect.apply(EventTarget.prototype.dispatchEvent, {}, [new Event('x')]);
    }, TypeError);
});

Deno.test('webapi upstream: EventTarget prototype methods default this to globalThis', () => {
    const { addEventListener, dispatchEvent, removeEventListener } = EventTarget.prototype;
    const listener = () => { calls++; };
    let calls = 0;

    addEventListener('upstream-global-event', listener);
    globalThis.dispatchEvent(new Event('upstream-global-event'));
    strictEqual(calls, 1);

    removeEventListener('upstream-global-event', listener);
    globalThis.dispatchEvent(new Event('upstream-global-event'));
    strictEqual(calls, 1);

    globalThis.addEventListener('upstream-global-event-2', listener);
    dispatchEvent(new Event('upstream-global-event-2'));
    strictEqual(calls, 2);

    globalThis.removeEventListener('upstream-global-event-2', listener);
    dispatchEvent(new Event('upstream-global-event-2'));
    strictEqual(calls, 2);
});

Deno.test('webapi upstream: global addEventListener signal option unregisters on abort', async () => {
    await new Promise<void>((resolve) => {
        const controller = new AbortController();
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
        addEventListener('upstream-global-abort', () => {}, { signal: controller.signal });
        controller.abort();
    });
});

Deno.test('webapi upstream: Event CustomEvent CloseEvent and ProgressEvent match DOM defaults', () => {
    const event = new Event(undefined as unknown as string);
    strictEqual(event.type, 'undefined');
    strictEqual(event.isTrusted, false);
    strictEqual(event.target, null);
    strictEqual(event.currentTarget, null);
    strictEqual(event.bubbles, false);
    strictEqual(event.cancelable, false);
    strictEqual(event.defaultPrevented, false);
    event.preventDefault();
    strictEqual(event.defaultPrevented, false);
    event.stopPropagation();
    strictEqual(event.cancelBubble, true);

    Object.prototype.bubbles = true;
    try {
        strictEqual(new Event('pollution').bubbles, false);
    } finally {
        Reflect.deleteProperty(Object.prototype, 'bubbles');
    }

    const detail = { message: 'hello' };
    const custom = new CustomEvent('touchstart', { bubbles: true, cancelable: true, detail });
    strictEqual(custom.bubbles, true);
    strictEqual(custom.cancelable, true);
    strictEqual(custom.detail, detail);
    strictEqual(custom.toString(), '[object CustomEvent]');

    const close = new CloseEvent('close');
    strictEqual(close.wasClean, false);
    strictEqual(close.code, 0);
    strictEqual(close.reason, '');
    strictEqual(close.toString(), '[object CloseEvent]');

    const progress = new ProgressEvent('progressEventType', { lengthComputable: true, loaded: 123, total: 456 });
    strictEqual(progress.lengthComputable, true);
    strictEqual(progress.loaded, 123);
    strictEqual(progress.total, 456);
    strictEqual(progress.toString(), '[object ProgressEvent]');

    const progressDefaults = new ProgressEvent('progressEventType');
    strictEqual(progressDefaults.lengthComputable, false);
    strictEqual(progressDefaults.loaded, 0);
    strictEqual(progressDefaults.total, 0);

    deepStrictEqual(new Event('path').composedPath(), []);
    const inspectedEvent = new Event('test');
    strictEqual(
        Deno.inspect(inspectedEvent, { colors: false }),
        `Event {
  bubbles: false,
  cancelable: false,
  composed: false,
  currentTarget: null,
  defaultPrevented: false,
  eventPhase: 0,
  srcElement: null,
  target: null,
  returnValue: true,
  timeStamp: ${inspectedEvent.timeStamp},
  type: "test"
}`,
    );
    strictEqual(Deno.inspect(Event.prototype, { colors: false }).includes('bubbles: [Getter]'), true);
});

Deno.test('webapi upstream: DOMException code lookup ignores Object prototype pollution', () => {
    Object.prototype.pollution = 100;
    try {
        const exception = new DOMException('test', 'pollution');
        strictEqual(exception.name, 'pollution');
        strictEqual(exception.code, 0);
        strictEqual(Object.prototype.toString.call(exception), '[object DOMException]');
    } finally {
        Reflect.deleteProperty(Object.prototype, 'pollution');
    }
});

Deno.test('webapi upstream: DOMException exposes stack as an own accessor', () => {
    const exception = new DOMException('asdf');
    const descriptor = Object.getOwnPropertyDescriptor(exception, 'stack');
    ok(descriptor);
    strictEqual(typeof descriptor.get, 'function');
    strictEqual(typeof descriptor.set, 'function');

    const inspected = new DOMException('test');
    strictEqual(Deno.inspect(inspected, { colors: false }), inspected.stack);
    strictEqual(Deno.inspect(DOMException.prototype, { colors: false }).includes('DOMException'), true);
});

Deno.test('webapi upstream: atob btoa and TextEncoder/TextDecoder edge behavior', () => {
    strictEqual(btoa('hello world'), 'aGVsbG8gd29ybGQ=');
    strictEqual(atob(' aGVsbG\t8g\n d29ybGQ='), 'hello world');
    throws(() => atob('aGVsbG8gd29ybGQ=='));
    throws(() => atob('foobar!!'), DOMException);
    throws(() => btoa('\u4f60\u597d'), DOMException);

    const decoder = new TextDecoder();
    strictEqual(decoder.decode(new Uint8Array([0xf0, 0x9d, 0x93, 0xbd])), '\ud835\udcfd');
    throws(() => new TextDecoder('Foo'), Error);
    strictEqual(new TextEncoder().toString(), '[object TextEncoder]');
    strictEqual(new TextDecoder().toString(), '[object TextDecoder]');

    const encoder = new TextEncoder();
    const bytes = new Uint8Array(5);
    const result = encoder.encodeInto('\ud835\udcfd\ud835\udcae\ud835\udd01\ud835\udcfd', bytes);
    strictEqual(result.read, 2);
    strictEqual(result.written, 4);
    deepStrictEqual([...bytes], [0xf0, 0x9d, 0x93, 0xbd, 0x00]);

    const lone = new Uint8Array(3);
    deepStrictEqual(encoder.encodeInto('\ud800', lone), { read: 1, written: 3 });
    deepStrictEqual([...lone], [0xef, 0xbf, 0xbd]);
});

Deno.test('webapi upstream: Storage global is not replaced and named properties mirror entries', () => {
    const originalLocal = globalThis.localStorage;
    const originalSession = globalThis.sessionStorage;

    Reflect.set(globalThis, 'localStorage', 1);
    Reflect.set(globalThis, 'sessionStorage', 1);
    strictEqual(globalThis.localStorage, originalLocal);
    strictEqual(globalThis.sessionStorage, originalSession);
    ok(globalThis.localStorage instanceof globalThis.Storage);
    ok(globalThis.sessionStorage instanceof globalThis.Storage);

    const key = `cno-upstream-storage-${Deno.pid}-${Date.now()}`;
    Reflect.set(localStorage, key, 'foo');
    strictEqual(Reflect.get(localStorage, key), 'foo');
    strictEqual(localStorage.getItem(key), 'foo');
    strictEqual(key in localStorage, true);

    const symbol = Symbol('bar');
    Reflect.set(localStorage, symbol, 'bar');
    strictEqual(Reflect.get(localStorage, symbol), 'bar');
    strictEqual(symbol in localStorage, true);
    Object.getOwnPropertyDescriptor(localStorage, Symbol('foo'));

    localStorage.removeItem(key);
    Reflect.deleteProperty(localStorage, symbol);
});

Deno.test('webapi upstream: Blob coerces parts and normalizes type', async () => {
    const buffer = new ArrayBuffer(12);
    const u8 = new Uint8Array(buffer);
    const f32 = new Float32Array(buffer);
    const blob = new Blob([buffer, u8, f32]);
    strictEqual(blob.size, 36);

    const sliced = new Blob(['Deno', 'Foo']).slice(0, 3, 'Text/HTML');
    strictEqual(sliced.size, 3);
    strictEqual(sliced.type, 'text/html');
    strictEqual(await sliced.text(), 'Den');

    strictEqual(new Blob(['foo'], { type: '\u0521' }).type, '');
    strictEqual(await new Blob([asBlobPart(12), asBlobPart([1, 2, 3]), asBlobPart({})]).text(), '121,2,3[object Object]');
    strictEqual(new Blob([], Object.create(null)).size, 0);
    strictEqual(Deno.inspect(new Blob(), { colors: false }), 'Blob { size: 0, type: "" }');
    strictEqual(Deno.inspect(Blob.prototype, { colors: false }).includes('Blob'), true);
});

Deno.test('webapi upstream: File coerces file bits and filename inputs', () => {
    const cases: Array<[BlobPart[], number]> = [
        [[], 0],
        [['bits'], 4],
        [['𝓽𝓮𝔁𝓽'], 16],
        [[asBlobPart(new String('string object'))], 13],
        [[new Blob(['bits'])], 4],
        [[new File(['bits'], 'world.txt')], 4],
        [[new ArrayBuffer(8)], 8],
        [[new Uint8Array([0x50, 0x41, 0x53, 0x53])], 4],
        [[asBlobPart(12)], 2],
        [[asBlobPart([1, 2, 3])], 5],
        [[asBlobPart({})], 15],
    ];

    for (const [parts, size] of cases) {
        const file = new File(parts, 'name');
        ok(file instanceof File);
        ok(file instanceof Blob);
        strictEqual(file.name, 'name');
        strictEqual(file.size, size);
        strictEqual(file.type, '');
    }

    strictEqual(new File(['bits'], null as unknown as string).name, 'null');
    strictEqual(new File(['bits'], 1 as unknown as string).name, '1');
    strictEqual(new File(['bits'], '').name, '');
    strictEqual(
        Deno.inspect(new File([], 'file-name.txt'), { colors: false }),
        'File { name: "file-name.txt", size: 0, type: "" }',
    );
    strictEqual(
        Deno.inspect(new File([], 'file-name.txt', { type: 'text/plain' }), { colors: false }),
        'File { name: "file-name.txt", size: 0, type: "text/plain" }',
    );
});

Deno.test('webapi upstream: Headers constructor mutation and invalid input semantics', () => {
    strictEqual(Headers.name, 'Headers');
    const dict = {
        name1: 'value1',
        Name2: 'value2',
        'Content-Type': 'value3',
        name4: undefined as unknown as string,
    };

    const fromRecord = new Headers(dict);
    strictEqual(fromRecord.get('name1'), 'value1');
    strictEqual(fromRecord.get('name2'), 'value2');
    strictEqual(fromRecord.get('content-type'), 'value3');
    strictEqual(fromRecord.get('name4'), 'undefined');

    const fromSeq = new Headers(Object.entries(dict));
    strictEqual(fromSeq.get('length'), null);
    fromSeq.append('X-Deno', 'foo');
    fromSeq.append('x-deno', 'bar');
    strictEqual(fromSeq.get('x-deno'), 'foo, bar');
    fromSeq.set('x-deno', 'baz');
    strictEqual(fromSeq.get('X-Deno'), 'baz');

    const cookies = new Headers([
        ['Set-Cookie', 'foo=bar'],
        ['set-Cookie', 'bar=baz'],
    ]);
    cookies.append('Set-cookie', 'baz=qat');
    deepStrictEqual([...cookies], [
        ['set-cookie', 'foo=bar'],
        ['set-cookie', 'bar=baz'],
        ['set-cookie', 'baz=qat'],
    ]);
    strictEqual(cookies.get('SET-COOKIE'), 'foo=bar, bar=baz, baz=qat');

    strictEqual(new Headers().toString(), '[object Headers]');
    throws(() => new Headers({ 'He y': 'ok' }), TypeError);
    throws(() => new Headers({ 'H\u00e9-y': 'ok' }), TypeError);
    throws(() => new Headers({ 'He-y': '\u0103k' }), TypeError);
    throws(() => new Headers([['1']] as unknown as Array<[string, string]>), TypeError);

    const headers = new Headers();
    for (const method of ['delete', 'get', 'has', 'forEach'] as const) {
        throws(() => Reflect.apply(headers[method], headers, []), TypeError);
    }
    for (const method of ['append', 'set'] as const) {
        throws(() => Reflect.apply(headers[method], headers, []), TypeError);
        throws(() => Reflect.apply(headers[method], headers, ['foo']), TypeError);
    }
});

Deno.test('webapi upstream: Request accepts stringifiers URL objects and cloned stream bodies', async () => {
    const stringifier = { toString: () => 'http://foo/' };
    strictEqual(new Request(stringifier as unknown as string).url, 'http://foo/');
    strictEqual(new Request(new URL('http://foo/')).url, 'http://foo/');
    strictEqual(new Request('http://foo/', { method: undefined }).method, 'GET');
    throws(() => new Request('http://foo/', { method: 'GET', body: 'body' }), TypeError);
    throws(() => new Request('http://foo/', { method: 'HEAD', body: 'body' }), TypeError);

    const fromInit = new Request('http://foo/', {
        body: 'ahoyhoy',
        method: 'POST',
        headers: { 'test-header': 'value' },
    });
    strictEqual(await fromInit.text(), 'ahoyhoy');
    strictEqual(fromInit.headers.get('test-header'), 'value');

    const stream = new Request('http://foo/', { body: 'a test body', method: 'POST' }).body;
    const r1 = new Request('http://foo/', { body: stream, method: 'POST' });
    const r2 = r1.clone();
    strictEqual(await r1.text(), 'a test body');
    strictEqual(await r2.text(), 'a test body');
});

Deno.test('webapi upstream: Response body readers init validation clone and formData', async () => {
    strictEqual(await new Response('hello world').text(), 'hello world');
    deepStrictEqual(new Uint8Array(await new Response(new Uint8Array([1, 2, 3])).arrayBuffer()), new Uint8Array([1, 2, 3]));
    deepStrictEqual(await new Response('{"hello":"world"}').json(), { hello: 'world' });

    const blob = await new Response(new Uint8Array([1, 2, 3])).blob();
    ok(blob instanceof Blob);
    strictEqual(blob.size, 3);

    const params = new URLSearchParams('hello=world&multi=one&multi=two');
    const urlEncoded = new Response(params, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const parsed = await urlEncoded.formData();
    strictEqual(parsed.get('hello'), 'world');
    deepStrictEqual(parsed.getAll('multi'), ['one', 'two']);

    const input = new FormData();
    input.append('hello', 'world');
    const multipart = new Response(input);
    ok(multipart.headers.get('content-type')!.startsWith('multipart/form-data'));
    strictEqual((await multipart.formData()).get('hello'), 'world');

    throws(() => new Response('', 0 as unknown as ResponseInit), TypeError);
    throws(() => new Response('', { status: 0 }), RangeError);
    throws(() => new Response('', { status: null as unknown as number }), RangeError);
    strictEqual(new Response('', null as unknown as ResponseInit).status, 200);
    throws(() => new Response('body', { status: 204 }), TypeError);

    const used = new Response('once');
    strictEqual(await used.text(), 'once');
    await rejects(async () => await used.text(), TypeError);

    const original = new Response('clone-body', { headers: { 'x-test': 'yes' } });
    const clone = original.clone();
    strictEqual(await original.text(), 'clone-body');
    strictEqual(await clone.text(), 'clone-body');
    strictEqual(clone.headers.get('x-test'), 'yes');
});
