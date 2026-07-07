import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

async function runCno(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
        env: { CTS_SILENT: 'true' },
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

Deno.test({ name: 'cts runtime: data URL modules run through static and dynamic imports', timeout: 15000 }, async () => {
    await withTempDir('cts-data-url-runtime', async (root) => {
        const source = 'export const a = "a";\nexport enum A { A, B, C }\n';
        const dataUrl = `data:application/typescript;base64,${btoa(source)}`;
        const entry = join(root, 'main.ts');
        await Deno.writeTextFile(entry, `
            import * as stat from ${JSON.stringify(dataUrl)};
            const dyn = await import(${JSON.stringify(dataUrl)});
            console.log(stat.a, stat.A.C);
            console.log(dyn.a, dyn.A.B);
        `);

        const result = await runCno(['run', entry], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'a 2\na 1');
    });
});

Deno.test({ name: 'cts runtime: blob URL modules support TypeScript JSX and relative-import failures', timeout: 15000 }, async () => {
    await withTempDir('cts-blob-url-runtime', async (root) => {
        const entry = join(root, 'main.ts');
        await Deno.writeTextFile(entry, `
            const tsUrl = URL.createObjectURL(new Blob([
                'export const a = "a";\\nexport enum A { A, B, C }\\n',
            ], { type: "application/typescript" }));
            const tsMod = await import(tsUrl);
            console.log(tsMod.a, tsMod.A.C);

            const jsxUrl = URL.createObjectURL(new Blob([
                'export default function render() { return <div>Hello CNO</div>; }\\n',
            ], { type: "text/jsx" }));
            globalThis.React = {
                createElement(...args) {
                    console.log(args[0], args[1], args[2]);
                },
            };
            const jsxMod = await import(jsxUrl);
            jsxMod.default();

            const relativeUrl = URL.createObjectURL(new Blob([
                'export { value } from "./dep.ts";\\n',
            ], { type: "application/javascript" }));
            try {
                await import(relativeUrl);
                console.log("relative-ok");
            } catch (error) {
                console.log(error instanceof Error, /Invalid object URL|invalid URL|Module not found/.test(error.message));
            }
        `);

        const result = await runCno(['run', entry], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), [
            'a 2',
            'div null Hello CNO',
            'true true',
        ].join('\n'));
    });
});

Deno.test({ name: 'cts runtime: import attributes expose bytes and text module views', timeout: 15000 }, async () => {
    await withTempDir('cts-raw-imports', async (root) => {
        await Deno.writeTextFile(join(root, 'hello.ts'), `
            export function hello(): string {
                return "hello";
            }
        `);
        await Deno.writeTextFile(join(root, 'data.txt'), 'abc');
        const entry = join(root, 'main.ts');
        await Deno.writeTextFile(entry, `
            import { hello } from "./hello.ts";
            import helloBytes from "./hello.ts" with { type: "bytes" };
            import helloText from "./hello.ts" with { type: "text" };
            import dataBytes from "./data.txt" with { type: "bytes" };
            import dataText from "./data.txt" with { type: "text" };

            const { default: dynamicHelloBytes } = await import("./hello.ts", { with: { type: "bytes" } });
            const { default: dynamicHelloText } = await import("./hello.ts", { with: { type: "text" } });
            const { default: dynamicDataBytes } = await import("./data.txt", { with: { type: "bytes" } });
            const { default: dynamicDataText } = await import("./data.txt", { with: { type: "text" } });

            if (hello() !== "hello") throw new Error("source view failed");
            if (!(helloBytes instanceof Uint8Array) || helloBytes.length === 0) throw new Error("static TS bytes failed");
            if (!helloText.includes("function hello")) throw new Error("static TS text failed");
            if (!(dataBytes instanceof Uint8Array) || dataBytes.length !== 3) throw new Error("static text-file bytes failed");
            if (dataText !== "abc") throw new Error("static text-file text failed");
            if (!(dynamicHelloBytes instanceof Uint8Array) || dynamicHelloBytes.length === 0) throw new Error("dynamic TS bytes failed");
            if (!dynamicHelloText.includes("function hello")) throw new Error("dynamic TS text failed");
            if (!(dynamicDataBytes instanceof Uint8Array) || dynamicDataBytes.length !== 3) throw new Error("dynamic text-file bytes failed");
            if (dynamicDataText !== "abc") throw new Error("dynamic text-file text failed");
            console.log("raw-ok");
        `);

        const result = await runCno(['run', entry], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'raw-ok');
    });
});

Deno.test({ name: 'cts runtime: json import attributes work for static and dynamic imports', timeout: 15000 }, async () => {
    await withTempDir('cts-json-attrs', async (root) => {
        await Deno.writeTextFile(join(root, 'data.json'), JSON.stringify({ a: 'b', c: { d: 10 } }));
        const entry = join(root, 'main.ts');
        await Deno.writeTextFile(entry, `
            import data1 from "./data.json" with { type: "json" };
            import data2 from "./data.json" with { type: "json" };
            const data3 = await import("./data.json", { with: { type: "json" } });
            console.log(JSON.stringify([data1, data2, data3.default]));
        `);

        const result = await runCno(['run', entry], root);
        strictEqual(result.code, 0, result.stderr);
        ok(result.stdout.includes('[{"a":"b","c":{"d":10}},{"a":"b","c":{"d":10}},{"a":"b","c":{"d":10}}]'), result.stdout);
    });
});
