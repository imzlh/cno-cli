import { throws, ok } from 'node:assert';
import { Transformer } from '../../cts/src/source/transform.ts';

const engine = import.meta.use('engine');

Deno.test('cts: fallback decorator scan preserves TypeScript angle-bracket assertions', () => {
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxcLoader(() => null);
    const source = 'export const value = <number>1; // contact a@b\n';

    const output = transformer.transform(source, 'typed.ts');
    ok(output.includes('value = 1'), output);

    const captured = transformer.transformCapture(source, 'typed-capture.ts').code;
    ok(captured.includes('value = 1'), captured);

    const bytes = transformer.transformBytes(engine.encodeString(source), 'typed-bytes.ts');
    const bytesOutput = typeof bytes === 'string' ? bytes : engine.decodeString(bytes);
    ok(bytesOutput.includes('value = 1'), bytesOutput);
});

Deno.test('cts: fallback still rejects decorators in TS and TSX sources', () => {
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxcLoader(() => null);

    throws(() => transformer.transform('@dec class Decorated {}', 'decorated.ts'),
        /standard decorators require native OXC transformation/);
    throws(() => transformer.transform('const view = <div />; @dec class Decorated {}', 'decorated.tsx'),
        /standard decorators require native OXC transformation/);
});

Deno.test('cts: fallback still rejects bun:bundle imports', () => {
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxcLoader(() => null);

    for (const source of [
        "import { feature } from 'bun:bundle';",
        "import type { feature } from 'bun:bundle';",
        "import type Feature from 'bun:bundle';",
        "import type * as Bundle from 'bun:bundle';",
        "import { type feature } from 'bun:bundle';",
        "import type { feature } from 'bun:\\x62undle';",
    ]) {
        for (const extension of ['ts', 'tsx', 'cts']) {
            const filename = `bundle.${extension}`;
            const diagnostic = /bun:bundle requires native OXC transformation/;
            throws(() => transformer.transform(source, filename), diagnostic, `${filename}: ${source}`);
            throws(() => transformer.transformCapture(source, filename), diagnostic, `${filename}: ${source}`);
            throws(() => transformer.transformBytes(engine.encodeString(source), filename),
                diagnostic, `${filename}: ${source}`);
        }
    }
});

Deno.test('cts: fallback does not classify an escaped ordinary string as bun:bundle', () => {
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxcLoader(() => null);

    const output = transformer.transform(
        'const value = "line\\\ncontinuation"; export { value };',
        'escaped-string.js',
    );
    ok(output.includes('line') && output.includes('continuation'), output);
});

Deno.test('cts: fallback rejects an escaped bun:bundle import', () => {
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxcLoader(() => null);

    throws(() => transformer.transform(
        "import { feature } from 'bun:\\x62undle'; feature('FLAG');",
        'escaped-bundle.ts',
    ), /bun:bundle requires native OXC transformation/);
});
