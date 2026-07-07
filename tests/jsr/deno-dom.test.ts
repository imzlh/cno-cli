import { ok, strictEqual } from 'node:assert';
import { writeFileSync, unlinkSync } from 'node:fs';

function writeWorker(source: string): string {
    const file = Deno.makeTempFileSync({ prefix: 'cno-jsr-deno-dom-worker-', suffix: '.ts' });
    writeFileSync(file, source);
    return file;
}

Deno.test({ name: 'deno-dom: parses HTML through jsr wasm entry', timeout: 30000 }, async () => {
    const mod = await import('jsr:@b-fuze/deno-dom@0.1.56/wasm');
    const parser = new mod.DOMParser();
    const doc = parser.parseFromString(
        '<main id="app"><h1>Hello</h1><a href="/docs">docs</a></main>',
        'text/html',
    );

    ok(doc, 'DOMParser should return a document');
    strictEqual(doc.querySelector('#app h1')?.textContent, 'Hello');
    strictEqual(doc.querySelector('a')?.getAttribute('href'), '/docs');
});

Deno.test({ name: 'deno-dom: preserves utf8 text and attributes through wasm string glue', timeout: 30000 }, async () => {
    const mod = await import('jsr:@b-fuze/deno-dom@0.1.56/wasm');
    const parser = new mod.DOMParser();
    const doc = parser.parseFromString(
        '<main><img alt="异世界悠闲农家 第二季"><a>中文标题</a></main>',
        'text/html',
    );

    ok(doc, 'DOMParser should return a document');
    strictEqual(doc.querySelector('img')?.getAttribute('alt'), '异世界悠闲农家 第二季');
    strictEqual(doc.querySelector('a')?.textContent, '中文标题');
});

Deno.test({ name: 'deno-dom: parses HTML through jsr wasm entry inside a worker', timeout: 60000 }, async () => {
    const file = writeWorker(`
        try {
            const mod = await import('jsr:@b-fuze/deno-dom@0.1.56/wasm');
            const parser = new mod.DOMParser();
            const doc = parser.parseFromString(
                '<section><h2>Worker DOM</h2><span data-id="42">ok</span></section>',
                'text/html',
            );
            self.postMessage({
                heading: doc?.querySelector('h2')?.textContent,
                id: doc?.querySelector('span')?.getAttribute('data-id'),
            });
        } catch (error) {
            self.postMessage({
                error: error instanceof Error ? error.stack || error.message : String(error),
            });
        }
    `);
    const worker = new Worker(file, { type: 'module', name: 'deno-dom-jsr-worker' });
    try {
        const reply: { heading?: string; id?: string; error?: string } = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });

        strictEqual(reply.error, undefined, reply.error);
        strictEqual(reply.heading, 'Worker DOM');
        strictEqual(reply.id, '42');
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});
