import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { join } from 'node:path';
import { Glob } from '../../cno/src/bun/glob/index.ts';
import { withTempDir } from '../_helpers/temp.ts';

const sorted = (values: Iterable<string>): string[] => [...values].sort();

async function scanBoth(pattern: string, options: Parameters<Glob['scan']>[0], expected: string[]): Promise<void> {
    const glob = new Glob(pattern);
    deepStrictEqual(sorted(glob.scanSync(options)), sorted(expected), `sync ${pattern}`);
    const actual: string[] = [];
    for await (const path of glob.scan(options)) actual.push(path);
    deepStrictEqual(sorted(actual), sorted(expected), `async ${pattern}`);
}

Deno.test('bun Glob: lexical matching and validation', () => {
    const cases: Array<[string, string, boolean]> = [
        ['*.ts', 'a.ts', true], ['*.ts', 'dir/a.ts', false],
        ['**/*.ts', 'a.ts', true], ['**/*.ts', 'dir/a.ts', true],
        ['a/?[0-9].ts', 'a/x2.ts', true], ['a/?[!0-9].ts', 'a/x2.ts', false],
        ['{src,test}/**/*.{ts,js}', 'src/a.ts', true],
        ['**/*', 'a/', false], ['**/*', 'a', true], ['**/*', 'a/b', true],
        ['file{01..03}.ts', 'file02.ts', true], ['{a..e..2}', 'c', true],
        ['{a}', 'a', true], ['{}', '', true],
        ['@(foo|bar).ts', 'bar.ts', true], ['+(a|b).ts', 'abba.ts', true],
        ['?(a).ts', '.ts', true], ['*(a|b).ts', 'abab.ts', true],
        ['!(foo).ts', 'bar.ts', true], ['!(foo).ts', 'foo.ts', false],
        ['file\\*.ts', 'file*.ts', true], ['file\\?.ts', 'file1.ts', false],
        ['!*.ts', 'a.js', true], ['!*.ts', 'a.ts', false],
        ['*.ts', '.hidden.ts', true], ['./*.ts', './a.ts', true],
        ['[\\d].ts', 'd.ts', true], ['[\\d].ts', '1.ts', false],
        ['[\\s]', 's', true], ['[\\s]', ' ', false],
        ['[\\]]', ']', true], ['[a\\-z]', '-', true],
        ['[z-a]', '[z-a]', false], ['**/', '', true],
    ];
    for (const [pattern, value, expected] of cases) {
        strictEqual(new Glob(pattern).match(value), expected, `${pattern} / ${value}`);
    }
    throws(() => new Glob(1 as unknown as string), TypeError);
    throws(() => new Glob('*').match(null as unknown as string), TypeError);
    strictEqual(new Glob(new String('*.ts') as unknown as string).match(new String('a.ts') as unknown as string), true);
    throws(() => new Glob(new Proxy(new String('*.ts'), {}) as unknown as string), TypeError);
});

Deno.test('bun Glob: lexical matching treats escaped slashes as separators', () => {
    const cases: Array<[string, string, boolean]> = [
        ['a\\/b', 'a/b', true],
        ['\\/a', '/a', true],
        ['a\\/', 'a/', true],
        ['a\\//b', 'a//b', true],
        ['a\\/\\/b', 'a//b', true],
        ['a\\\\/b', 'a/b', false],
        ['a\\\\/b', 'a\\/b', true],
        ['a\\\\\\/b', 'a\\/b', true],
        ['a\\/*', 'a/.hidden', true],
        ['a\\/.*', 'a/.hidden', true],
        ['a\\/**', 'a', false],
        ['a\\/**', 'a/', true],
        ['**\\/a', 'a', false],
        ['**\\/a', 'x/a', true],
        ['**\\/a', 'x/y/a', false],
        ['a/**\\/b', 'a/b', false],
        ['a/**\\/b', 'a/x/b', true],
        ['a/**\\/b', 'a/x/y/b', false],
        ['a\\/{b,c}', 'a/b', true],
        ['a\\/{b,c}', 'a/c', true],
        ['{a,b}\\/c', 'b/c', true],
    ];
    // This pins Glob.match only; scan root planning has a separate path grammar.
    for (const [pattern, value, expected] of cases) {
        strictEqual(new Glob(pattern).match(value), expected, `${pattern} / ${value}`);
    }
});

Deno.test('bun Glob: constructor and method shape, brands and string extraction', () => {
    strictEqual(Glob.name, 'Glob');
    strictEqual(Glob.length, 1);
    strictEqual(Glob.prototype.match.name, 'match');
    strictEqual(Glob.prototype.match.length, 1);
    deepStrictEqual(Object.getOwnPropertyDescriptor(Glob.prototype, 'match'), {
        value: Glob.prototype.match,
        writable: true,
        enumerable: true,
        configurable: false,
    });
    for (const method of ['scan', 'scanSync'] as const) {
        strictEqual(Glob.prototype[method].name, '');
        strictEqual(Glob.prototype[method].length, 1);
        deepStrictEqual(Object.getOwnPropertyDescriptor(Glob.prototype, method), {
            value: Glob.prototype[method],
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    const glob = new Glob('*');
    strictEqual(Object.prototype.toString.call(glob), '[object Glob]');
    const invalidThis = (error: unknown): boolean => error instanceof TypeError
        && (error as TypeError & { code?: string }).code === 'ERR_INVALID_THIS';
    throws(() => Reflect.apply(Glob.prototype.match, {}, [null]), invalidThis);
    throws(() => Reflect.apply(Glob.prototype.match, Glob.prototype, ['a']), invalidThis);
    throws(() => Reflect.apply(Glob.prototype.match, new Proxy(glob, {}), ['a']), invalidThis);
    for (const method of [Glob.prototype.scan, Glob.prototype.scanSync]) {
        const reads: string[] = [];
        const options = new Proxy({}, {
            get(_target, property) {
                reads.push(String(property));
                throw new Error('option getter');
            },
        });
        throws(() => Reflect.apply(method, {}, [options]), TypeError);
        deepStrictEqual(reads, []);
    }

    class GlobSubclass extends Glob {}
    strictEqual(new GlobSubclass('*').match('a'), true);
    const alternate = Reflect.construct(Glob, ['*'], function Alternate() {});
    strictEqual(Reflect.apply(Glob.prototype.match, alternate, ['a']), true);

    const valueOfDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'valueOf')!;
    const pattern = new String('*.ts');
    const input = new String('a.ts');
    let reads = 0;
    let matched = false;
    try {
        Object.defineProperty(String.prototype, 'valueOf', {
            configurable: true,
            get() {
                reads++;
                return valueOfDescriptor.value;
            },
        });
        matched = new Glob(pattern as unknown as string).match(input as unknown as string);
    } finally {
        Object.defineProperty(String.prototype, 'valueOf', valueOfDescriptor);
    }
    strictEqual(matched, true);
    strictEqual(reads, 0);
});

Deno.test('bun Glob: scan option coercion and eager validation', async () => {
    await withTempDir('bun-glob-options', async root => {
        Deno.mkdirSync(join(root, 'dir'));
        Deno.writeTextFileSync(join(root, 'file'), 'x');
        Deno.writeTextFileSync(join(root, '.dot'), 'x');

        const glob = new Glob('*');
        deepStrictEqual(sorted(glob.scanSync(new String(root) as unknown as string)), ['file']);
        deepStrictEqual(sorted(glob.scanSync({ cwd: new String(root) as unknown as string })), ['file']);
        deepStrictEqual(sorted(glob.scanSync({ cwd: root, onlyFiles: null as unknown as boolean })), ['file']);
        deepStrictEqual(sorted(glob.scanSync({ cwd: root, onlyFiles: false })), ['dir', 'file']);
        deepStrictEqual(sorted(glob.scanSync({ cwd: root, dot: Symbol('truthy') as unknown as boolean })), ['.dot', 'file']);

        const reads: string[] = [];
        const options = new Proxy({}, {
            get(_target, property) {
                reads.push(String(property));
                return property === 'cwd' ? root : undefined;
            },
        });
        glob.scanSync(options as GlobScanOptions).next();
        deepStrictEqual(reads, ['onlyFiles', 'throwErrorOnBrokenSymlink', 'followSymlinks', 'absolute', 'cwd', 'dot']);

        throws(() => glob.scanSync(1 as unknown as GlobScanOptions), /GlobScanOptions must be an object/);
        throws(() => glob.scanSync({ get cwd(): string { throw new Error('cwd getter'); } }), /cwd getter/);
        throws(() => glob.scan({ get onlyFiles(): boolean { throw new Error('onlyFiles getter'); } }), /onlyFiles getter/);
        await rejects(async () => { for await (const _ of glob.scan({ cwd: join(root, 'missing') })) { /* consume */ } });
    });
});

Deno.test('bun Glob: scan options, paths, depth and iterator parity', async () => {
    await withTempDir('bun-glob', async root => {
        Deno.mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
        Deno.mkdirSync(join(root, '.hidden'));
        for (const name of ['a.ts', 'b.js', '.dot.ts', 'sub/c.ts', 'sub/d.js', 'sub/deep/e.js', '.hidden/h.ts']) {
            Deno.writeTextFileSync(join(root, name), 'x');
        }
        await scanBoth('*.ts', root, ['a.ts']);
        await scanBoth('*.ts', { cwd: root, dot: true }, ['a.ts', '.dot.ts']);
        await scanBoth('**/*.ts', { cwd: root }, ['a.ts', 'sub/c.ts']);
        await scanBoth('**/*.ts', { cwd: root, dot: true }, ['a.ts', '.dot.ts', 'sub/c.ts', '.hidden/h.ts']);
        await scanBoth('*', { cwd: root, onlyFiles: false }, ['a.ts', 'b.js', 'sub']);
        await scanBoth('./*.ts', { cwd: root }, ['./a.ts']);
        await scanBoth('*.ts', { cwd: root, absolute: true }, [join(root, 'a.ts')]);
        await scanBoth(join(root, '*.ts'), { cwd: root }, [join(root, 'a.ts')]);
        await scanBoth('!*.ts', { cwd: root }, ['b.js']);
        await scanBoth('!sub/*.ts', { cwd: root }, []);
        await scanBoth('{a,b}.{ts,js}', { cwd: root }, ['a.ts', 'b.js']);
        throws(() => [...new Glob('*').scanSync({ cwd: join(root, 'missing') })]);
        throws(() => [...new Glob('*').scanSync({ cwd: join(root, 'a.ts') })], /ENOTDIR/);
        await rejects(async () => { for await (const _ of new Glob('*').scan({ cwd: join(root, 'missing') })) { /* consume */ } });
        await rejects(async () => { for await (const _ of new Glob('*').scan({ cwd: join(root, 'a.ts') })) { /* consume */ } }, /ENOTDIR/);
    });
});

Deno.test('bun Glob: negated scans preserve suffix shape and depth', async () => {
    await withTempDir('bun-glob-negated-depth', async root => {
        Deno.mkdirSync(join(root, 'sub', 'deep', 'more'), { recursive: true });
        Deno.mkdirSync(join(root, 'other', 'deep'), { recursive: true });
        Deno.mkdirSync(join(root, 'sub2'));
        for (const name of [
            'root.ts', 'root.js',
            'sub/s.ts', 'sub/s.js',
            'sub/deep/d.ts', 'sub/deep/d.js', 'sub/deep/more/m.ts',
            'other/o.ts', 'other/o.js', 'other/deep/od.ts', 'other/deep/od.js',
            'sub2/z.ts',
        ]) {
            Deno.writeTextFileSync(join(root, name), 'x');
        }

        await scanBoth('!sub/*.ts', { cwd: root }, ['other/o.ts', 'sub2/z.ts']);
        await scanBoth('!sub/deep/*.ts', { cwd: root }, ['other/deep/od.ts']);
        await scanBoth('!sub/*/*.ts', { cwd: root }, ['other/deep/od.ts']);
        await scanBoth('!**/*.ts', { cwd: root }, []);
    });
});

Deno.test('bun Glob: scan preserves escaped literal metacharacters', async () => {
    await withTempDir('bun-glob-escaped-literals', async root => {
        Deno.mkdirSync(join(root, 'dir*'));
        for (const name of ['file*.ts', 'file?.ts', 'file1.ts', '[draft].ts', 'dir*/inside.ts']) {
            Deno.writeTextFileSync(join(root, name), 'x');
        }
        await scanBoth('file\\*.ts', { cwd: root }, ['file*.ts']);
        await scanBoth('file\\?.ts', { cwd: root }, ['file?.ts']);
        await scanBoth('\\[draft\\].ts', { cwd: root }, ['[draft].ts']);
        await scanBoth('dir\\*/inside.ts', { cwd: root }, ['dir*/inside.ts']);
    });
});

Deno.test('bun Glob: symlink traversal and cycle protection', async () => {
    await withTempDir('bun-glob-links', async root => {
        Deno.mkdirSync(join(root, 'dir'));
        Deno.writeTextFileSync(join(root, 'dir', 'a.ts'), 'x');
        Deno.symlinkSync('dir', join(root, 'link'));
        Deno.symlinkSync('..', join(root, 'dir', 'cycle'));
        Deno.symlinkSync('missing', join(root, 'broken'));
        await scanBoth('**/*.ts', { cwd: root }, ['dir/a.ts']);
        await scanBoth('**/*.ts', { cwd: root, followSymlinks: true }, ['dir/a.ts', 'link/a.ts']);
        await scanBoth('broken', { cwd: root, onlyFiles: false }, ['broken']);
        await scanBoth('broken', { cwd: root }, []);
    });
});

Deno.test('bun Glob: throwErrorOnBrokenSymlink reports broken links', async () => {
    await withTempDir('bun-glob-broken', async root => {
        Deno.symlinkSync('missing', join(root, 'broken'));
        Deno.writeTextFileSync(join(root, 'ok.ts'), 'x');
        throws(() => [...new Glob('*.ts').scanSync({ cwd: root, throwErrorOnBrokenSymlink: true })]);
        throws(() => [...new Glob('broken').scanSync({ cwd: root, throwErrorOnBrokenSymlink: true })]);
        await rejects(async () => { for await (const _ of new Glob('broken').scan({ cwd: root, throwErrorOnBrokenSymlink: true })) { /* consume */ } });
    });
});
