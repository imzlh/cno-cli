import { ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join } from 'node:path';

function makeTempDir(name: string): string {
    return Deno.makeTempDirSync({ prefix: `cno-${name}-` });
}

function readFirstJsFile(dir: string): string {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = readFirstJsFile(path);
            if (nested) return nested;
        } else if (entry.name.endsWith('.js')) {
            return readFileSync(path, 'utf8');
        }
    }
    return '';
}

function requestText(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.once('error', reject);
        req.end();
    });
}

function getFreePort(): Promise<number> {
    const server = createServer((_, res) => res.end());
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('server did not expose a port')));
                return;
            }
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}

Deno.test({ name: 'vite: builds a disk app through rolldown/native resolver path', timeout: 150000 }, async () => {
    const root = makeTempDir('vite-app');
    try {
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.js"></script>\n');
        writeFileSync(join(root, 'src', 'dep.js'), 'export const value = 20 + 2;\n');
        writeFileSync(join(root, 'src', 'main.js'), 'import { value } from "./dep.js"; document.querySelector("#app").textContent = String(value);\n');

        const vite = await import('npm:vite');
        await vite.build({
            root,
            logLevel: 'silent',
            build: {
                outDir: 'dist',
                emptyOutDir: true,
                minify: false,
            },
        });

        ok(existsSync(join(root, 'dist', 'index.html')), 'vite should emit index.html');
        const js = readFirstJsFile(join(root, 'dist', 'assets'));
        ok(js.includes('20 + 2') || js.includes('22'), `vite output should include bundled dependency value: ${js}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'vite: dev server serves transformed TypeScript from disk', timeout: 90000 }, async () => {
    const root = makeTempDir('vite-dev');
    const port = await getFreePort();
    let server: any;
    try {
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>\n');
        writeFileSync(join(root, 'src', 'main.ts'), 'const value: number = 42; console.log(value);\n');

        const vite = await import('npm:vite');
        server = await vite.createServer({
            root,
            logLevel: 'silent',
            server: {
                host: '127.0.0.1',
                port,
                strictPort: true,
                hmr: false,
            },
        });
        await server.listen();

        const baseUrl = `http://127.0.0.1:${port}`;
        const html = await requestText(`${baseUrl}/`);
        strictEqual(html.status, 200);
        ok(html.body.includes('/src/main.ts'), `vite should serve project HTML: ${html.body}`);

        const transformed = await requestText(`${baseUrl}/src/main.ts`);
        strictEqual(transformed.status, 200);
        ok(transformed.body.includes('const value = 42'), `vite should transform TypeScript: ${transformed.body}`);
    } finally {
        if (server) await server.close();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'webpack: compiles a disk ESM entry with default CJS exports shape', timeout: 90000 }, async () => {
    const root = makeTempDir('webpack-app');
    try {
        mkdirSync(join(root, 'src'), { recursive: true });
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'src', 'dep.js'), 'export const value = 21;\n');
        writeFileSync(join(root, 'src', 'entry.js'), 'import { value } from "./dep.js"; console.log(value * 2);\n');

        const webpackMod = await import('npm:webpack');
        const webpack = webpackMod.default ?? webpackMod;
        await new Promise<void>((resolve, reject) => {
            webpack({
                mode: 'development',
                context: root,
                entry: './src/entry.js',
                output: {
                    path: join(root, 'dist'),
                    filename: 'bundle.js',
                },
                target: 'node',
                optimization: { minimize: false },
            }, (error: Error | null | undefined, stats: any) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (stats?.hasErrors?.()) {
                    reject(new Error(stats.toString({ all: false, errors: true })));
                    return;
                }
                resolve();
            });
        });

        const output = readFileSync(join(root, 'dist', 'bundle.js'), 'utf8');
        ok(output.includes('value = 21'), `webpack bundle should include dependency module: ${output}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: '@babel/core: parses, transforms and generates modern syntax', timeout: 30000 }, async () => {
    const babel = await import('npm:@babel/core');
    const result = babel.transformSync('const value = source?.answer ?? 42;', {
        filename: 'input.js',
        ast: true,
        code: true,
        plugins: [
            () => ({
                visitor: {
                    Identifier(path: any) {
                        if (path.node.name === 'source') path.node.name = 'runtime';
                    },
                },
            }),
        ],
    });

    ok(result?.ast, 'babel should return an AST');
    ok(result?.code?.includes('runtime?.answer'), `babel should generate transformed code: ${result?.code}`);
});

Deno.test({ name: 'react-dom/server: renders React with a stable non-prerelease peer version', timeout: 30000 }, async () => {
    const reactMod = await import('npm:react');
    const server = await import('npm:react-dom/server');
    const React = reactMod.default ?? reactMod;

    const html = server.renderToString(React.createElement('section', { id: 'app' }, 'ok'));
    strictEqual(html, '<section id="app">ok</section>');
});

Deno.test({ name: '@vue/compiler-sfc: parses and compiles template, script setup and style', timeout: 30000 }, async () => {
    const compiler = await import('npm:@vue/compiler-sfc');
    const source = [
        '<template><h1 class="title">{{ msg }}</h1></template>',
        '<script setup>const msg = "ok"</script>',
        '<style>.title { color: red; }</style>',
    ].join('\n');

    const parsed = compiler.parse(source, { filename: 'Fixture.vue' });
    strictEqual(parsed.errors.length, 0);

    const script = compiler.compileScript(parsed.descriptor, { id: 'data-v-cno' });
    ok(script.content.includes('const msg = "ok"'), `compiled script should include setup binding: ${script.content}`);

    const template = compiler.compileTemplate({
        source: parsed.descriptor.template?.content ?? '',
        filename: 'Fixture.vue',
        id: 'data-v-cno',
    });
    strictEqual(template.errors.length, 0);
    ok(template.code.includes('toDisplayString'), `compiled template should render interpolation: ${template.code}`);

    const style = compiler.compileStyle({
        source: parsed.descriptor.styles[0].content,
        filename: 'Fixture.vue',
        id: 'data-v-cno',
    });
    strictEqual(style.errors.length, 0);
    ok(style.code.includes('color: red'), `compiled style should preserve CSS declaration: ${style.code}`);
});

Deno.test({ name: 'graphql: builds schema and executes resolver-backed queries', timeout: 30000 }, async () => {
    const { buildSchema, graphql } = await import('npm:graphql');
    const schema = buildSchema(`
        type Query {
            hello: String!
            sum(values: [Int!]!): Int!
        }
    `);

    const result = await graphql({
        schema,
        source: '{ hello sum(values: [2, 3, 5]) }',
        rootValue: {
            hello: 'world',
            sum: ({ values }: { values: number[] }) => values.reduce((total, value) => total + value, 0),
        },
    });

    strictEqual(result.errors, undefined);
    strictEqual(result.data?.hello, 'world');
    strictEqual(result.data?.sum, 10);
});
