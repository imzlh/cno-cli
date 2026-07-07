import { deepStrictEqual, strictEqual, throws } from 'node:assert';

Deno.test('webapi upstream: URLSearchParams form-url-encodes records and pairs', () => {
    strictEqual(
        new URLSearchParams({ str: 'this string has spaces in it' }).toString(),
        'str=this+string+has+spaces+in+it',
    );
    strictEqual(new URLSearchParams([['str', 'hello, world!']]).toString(), 'str=hello%2C+world%21');
    strictEqual(new URLSearchParams([['str', "'hello world'"]]).toString(), 'str=%27hello+world%27');
    strictEqual(new URLSearchParams([['str', '(hello world)']]).toString(), 'str=%28hello+world%29');
    strictEqual(new URLSearchParams([['str', 'hello~world']]).toString(), 'str=hello%7Eworld');
    strictEqual(new URLSearchParams({ linefeed: '\n', tab: '\t' }).toString(), 'linefeed=%0A&tab=%09');
});

Deno.test('webapi upstream: URLSearchParams decodes plus and malformed percent sequences', () => {
    let params = new URLSearchParams('q=a+b+c');
    strictEqual(params.toString(), 'q=a+b+c');
    strictEqual(params.get('q'), 'a b c');

    params = new URLSearchParams('id=0&value=%');
    strictEqual(params.get('id'), '0');
    strictEqual(params.get('value'), '%');

    params = new URLSearchParams('b=%2sf%2a');
    strictEqual(params.get('b'), '%2sf*');

    params = new URLSearchParams('b=%2%2af%2a');
    strictEqual(params.get('b'), '%2*f*');

    params = new URLSearchParams('b=%%2a');
    strictEqual(params.get('b'), '%*');
});

Deno.test('webapi upstream: URLSearchParams handles missing names values and empty pairs', () => {
    let params = new URLSearchParams('=4');
    strictEqual(params.get(''), '4');
    strictEqual(params.toString(), '=4');

    params = new URLSearchParams('4=');
    strictEqual(params.get('4'), '');
    strictEqual(params.toString(), '4=');

    params = new URLSearchParams('4');
    strictEqual(params.get('4'), '');
    strictEqual(params.toString(), '4=');

    params = new URLSearchParams('c=4&&a=54&');
    strictEqual(params.toString(), 'c=4&a=54');
});

Deno.test('webapi upstream: URLSearchParams constructor validates iterable pair lengths', () => {
    throws(() => new URLSearchParams([['1'] as unknown as [string, string]]), TypeError);
    throws(() => new URLSearchParams([['1', '2', '3'] as unknown as [string, string]]), TypeError);

    const custom = {
        *[Symbol.iterator]() {
            yield [1, 2];
        },
    };
    const params = new URLSearchParams(custom as unknown as Iterable<[string, string]>);
    strictEqual(params.get('1'), '2');
});

Deno.test('webapi upstream: URLSearchParams methods validate required arguments', () => {
    const oneArgMethods = ['delete', 'getAll', 'get', 'has', 'forEach'] as const;
    const twoArgMethods = ['append', 'set'] as const;

    for (const method of oneArgMethods) {
        const params = new URLSearchParams();
        throws(() => Reflect.apply(params[method], params, []), TypeError);
    }

    for (const method of twoArgMethods) {
        const params = new URLSearchParams();
        throws(() => Reflect.apply(params[method], params, ['foo']), TypeError);
    }
});

Deno.test('webapi upstream: URLSearchParams operations use internal slots not overridden methods', () => {
    let appendCalls = 0;
    class CustomSearchParams extends URLSearchParams {
        override append(name: string, value: string) {
            appendCalls++;
            super.append(name, value);
        }
    }

    new CustomSearchParams('foo=bar');
    new CustomSearchParams([['foo', 'bar']]);
    new CustomSearchParams(new CustomSearchParams({ foo: 'bar' }));
    new CustomSearchParams().set('foo', 'bar');
    strictEqual(appendCalls, 0);

    class EmptyEntriesSearchParams extends URLSearchParams {
        override *entries(): URLSearchParamsIterator<[string, string]> {
            yield* [];
        }
    }

    const seen: string[] = [];
    new EmptyEntriesSearchParams({ foo: 'bar' }).forEach((value, key) => seen.push(`${key}=${value}`));
    deepStrictEqual(seen, ['foo=bar']);
});

Deno.test('webapi upstream: URLSearchParams iterators are live and sort is stable', () => {
    const params = new URLSearchParams('z=1&a=first&z=2');
    const entries = params.entries();
    deepStrictEqual(entries.next().value, ['z', '1']);
    params.append('a', 'second');
    params.append('m', 'middle');
    params.sort();

    deepStrictEqual([...params], [
        ['a', 'first'],
        ['a', 'second'],
        ['m', 'middle'],
        ['z', '1'],
        ['z', '2'],
    ]);
    deepStrictEqual(entries.next().value, ['a', 'second']);
});

Deno.test('webapi upstream: URLSearchParams keys values and entry pairs follow live iterator semantics', () => {
    const keysParams = new URLSearchParams('a=1');
    const keys = keysParams.keys();
    keysParams.append('b', '2');
    strictEqual(keys.next().value, 'a');
    strictEqual(keys.next().value, 'b');
    strictEqual(keys.next().done, true);

    const valuesParams = new URLSearchParams('a=1');
    const values = valuesParams.values();
    valuesParams.append('b', '2');
    strictEqual(values.next().value, '1');
    strictEqual(values.next().value, '2');
    strictEqual(values.next().done, true);

    const entriesParams = new URLSearchParams('a=1&b=2');
    const entries = entriesParams.entries();
    const first = entries.next().value!;
    first[0] = 'x';
    first[1] = '9';
    strictEqual(entriesParams.toString(), 'a=1&b=2');
    entriesParams.delete('b');
    strictEqual(entries.next().done, true);
});

Deno.test('webapi upstream: URL searchParams object stays bound after search and href setters', () => {
    const url = new URL('http://example.test/path?a=1');
    const params = url.searchParams;
    strictEqual(params.get('a'), '1');

    url.search = '?b=2&b=3';
    strictEqual(url.searchParams, params);
    deepStrictEqual(params.getAll('b'), ['2', '3']);
    params.append('c', '4');
    strictEqual(url.search, '?b=2&b=3&c=4');

    url.href = 'http://example.test/next?d=5';
    strictEqual(url.searchParams, params);
    deepStrictEqual([...params], [['d', '5']]);
    params.set('e', '6');
    strictEqual(url.href, 'http://example.test/next?d=5&e=6');

    url.search = '';
    strictEqual(url.searchParams, params);
    strictEqual(params.size, 0);
    params.append('after', 'clear');
    strictEqual(url.search, '?after=clear');
});
