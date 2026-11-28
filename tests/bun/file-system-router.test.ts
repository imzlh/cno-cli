import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { dirname, join } from 'node:path';
import Bun, { FileSystemRouter } from 'bun';

Deno.test('bun FileSystemRouter: route precedence, decoded captures and query composition', () => {
    const directory = Deno.makeTempDirSync({ prefix: 'bun-router-matching-' });
    try {
        for (const name of ['index.tsx', 'blog/index.tsx', 'blog/new.tsx', 'blog/[slug].tsx', '[id]/edit.tsx', 'files/[...parts].tsx', 'docs/[[...slug]].tsx', 'hidden.txt', '.ignored.tsx']) {
            const target = join(directory, name);
            Deno.mkdirSync(dirname(target), { recursive: true });
            Deno.writeTextFileSync(target, 'not evaluated');
        }
        const router = new Bun.FileSystemRouter({ dir: directory, style: 'nextjs', origin: 'https://example.test/', assetPrefix: '/assets/' });
        strictEqual(router.match('/blog/new')!.kind, 'exact');
        strictEqual(router.match('/blog/index/')!.name, '/blog');
        strictEqual(router.match('/index')!.name, '/');
        const article = router.match('/blog/hello%20world?slug=ignored&tag=a&tag=b&plus=a+b&__proto__=safe')!;
        strictEqual(Deno.realPathSync(article.filePath), Deno.realPathSync(join(directory, 'blog/[slug].tsx')));
        strictEqual(article.pathname, '/blog/hello world?slug=ignored&tag=a&tag=b&plus=a+b&__proto__=safe');
        deepStrictEqual(article.params, { slug: 'hello world' });
        deepStrictEqual(article.query, JSON.parse('{"slug":"hello world","tag":["a","b"],"plus":"a+b","__proto__":"safe"}'));
        strictEqual(Object.getPrototypeOf(article.query), Object.prototype);
        strictEqual(article.src, 'https://example.test/assets/blog/[slug].tsx');
        strictEqual(article.scriptSrc, article.src);
        const file = router.match('/files/one/two')!;
        strictEqual(file.kind, 'catch-all');
        deepStrictEqual(file.params, { parts: 'one/two' });
        strictEqual(router.match('/files'), null);
        deepStrictEqual(router.match('/docs')!.params, {});
        deepStrictEqual(router.match('/docs/a/b')!.params, { slug: 'a/b' });
        strictEqual(router.match('/docs/edit')!.name, '/[id]/edit');
        strictEqual(router.match('/.ignored'), null);
        strictEqual(router.match('/hidden'), null);
        strictEqual(router.match('/blog//value'), null);
        const decoded = router.match('/blog/%E0%A4?once=%2526a%253Db&invalid=%25zz&bad=%25E0%25A4')!;
        deepStrictEqual(decoded.params, { slug: '�' });
        deepStrictEqual(decoded.query, { slug: '�', once: '&a=b', bad: '�' });
        throws(() => router.match('/blog/%zz'), /DecodingError/);
    } finally {
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test('bun FileSystemRouter: input objects, extension filters and atomic reload', () => {
    const directory = Deno.makeTempDirSync({ prefix: 'bun-router-reload-' });
    try {
        Deno.writeTextFileSync(join(directory, 'index.page'), '');
        Deno.writeTextFileSync(join(directory, 'about.page'), '');
        Deno.writeTextFileSync(join(directory, 'ignored.tsx'), '');
        if (Deno.build.os !== 'windows') {
            Deno.symlinkSync(join(directory, 'missing.page'), join(directory, 'broken.page'));
            Deno.symlinkSync('self.page', join(directory, 'self.page'));
            Deno.symlinkSync(directory, join(directory, 'cycle'));
        }
        const router = new FileSystemRouter({ dir: directory, style: 'nextjs', fileExtensions: ['.page'] });
        strictEqual(router.match('https://other.test/about?value=a%20b')!.query.value, 'a b');
        strictEqual(router.match('https://other.test/../about'), null);
        strictEqual(router.match(new Request('https://other.test/about'))!.name, '/about');
        strictEqual(router.match(new Response('empty URL'))!.name, '/');
        throws(() => router.match(new URL('https://other.test/about') as never), TypeError);
        strictEqual(router.match('/ignored'), null);
        Deno.removeSync(join(directory, 'about.page'));
        Deno.writeTextFileSync(join(directory, 'new.page'), '');
        strictEqual(router.match('/new'), null);
        strictEqual(router.reload(), router);
        strictEqual(router.match('/about'), null);
        strictEqual(router.match('/new')!.src, 'new.page');
        Deno.mkdirSync(join(directory, 'new'));
        Deno.writeTextFileSync(join(directory, 'new/index.page'), '');
        throws(() => router.reload(), /already defined/);
        strictEqual(Deno.realPathSync(router.match('/new')!.filePath), Deno.realPathSync(join(directory, 'new.page')));
        throws(() => new FileSystemRouter({ dir: directory, style: 'other' as never }), TypeError);
        throws(() => new FileSystemRouter({ dir: directory, style: 'nextjs', fileExtensions: [1] as never }), TypeError);
    } finally {
        Deno.removeSync(directory, { recursive: true });
    }
});
