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
        ['file{01..03}.ts', 'file02.ts', true], ['{a..e..2}', 'c', true],
        ['@(foo|bar).ts', 'bar.ts', true], ['+(a|b).ts', 'abba.ts', true],
        ['?(a).ts', '.ts', true], ['*(a|b).ts', 'abab.ts', true],
        ['!(foo).ts', 'bar.ts', true], ['!(foo).ts', 'foo.ts', false],
        ['file\\*.ts', 'file*.ts', true], ['file\\?.ts', 'file1.ts', false],
        ['!*.ts', 'a.js', true], ['!*.ts', 'a.ts', false],
        ['*.ts', '.hidden.ts', true], ['./*.ts', './a.ts', true],
        ['[\\d].ts', 'd.ts', true], ['[\\d].ts', '1.ts', false],
        ['[\\s]', 's', true], ['[\\s]', ' ', false],
        ['[\\]]', ']', true], ['[a\\-z]', '-', true],
    ];
    for (const [pattern, value, expected] of cases) {
        strictEqual(new Glob(pattern).match(value), expected, `${pattern} / ${value}`);
    }
    throws(() => new Glob(1 as unknown as string), TypeError);
    throws(() => new Glob('*').match(null as unknown as string), TypeError);
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
        await scanBoth('!sub/*.ts', { cwd: root }, ['a.ts', 'b.js', 'sub/d.js']);
        await scanBoth('{a,b}.{ts,js}', { cwd: root }, ['a.ts', 'b.js']);
        throws(() => [...new Glob('*').scanSync({ cwd: join(root, 'missing') })]);
        throws(() => [...new Glob('*').scanSync({ cwd: join(root, 'a.ts') })], /ENOTDIR/);
        await rejects(async () => { for await (const _ of new Glob('*').scan({ cwd: join(root, 'missing') })) { /* consume */ } });
        await rejects(async () => { for await (const _ of new Glob('*').scan({ cwd: join(root, 'a.ts') })) { /* consume */ } }, /ENOTDIR/);
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
