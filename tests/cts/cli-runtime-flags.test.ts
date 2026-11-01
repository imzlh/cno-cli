// End-to-end coverage for runtime-option scope widening: --env/--env-file on
// eval and task, and the --import-map wiring in flagsToConfig.
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

async function runCli(args: string[], cwd?: string): Promise<{ code: number; text: string }> {
    const output = await new Deno.Command(Deno.execPath(), {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        text: new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr),
    };
}

Deno.test({ name: 'cli: eval loads --env-file before evaluating', timeout: 15000 }, async () => {
    await withTempDir('cli-eval-env', async (dir) => {
        await Deno.writeTextFile(join(dir, '.env'), 'CNO_EVAL_ENV_MARKER=from-env-file\n');
        const { code, text } = await runCli([
            'eval', `--env-file=${join(dir, '.env')}`,
            'console.log("marker=" + Deno.env.get("CNO_EVAL_ENV_MARKER"))',
        ], dir);
        strictEqual(code, 0, text);
        ok(text.includes('marker=from-env-file'), text);
    });
});

Deno.test({ name: 'cli: task --env-file reaches the task shell', timeout: 15000 }, async () => {
    await withTempDir('cli-task-env', async (dir) => {
        await Deno.writeTextFile(join(dir, '.env'), 'CNO_TASK_ENV_MARKER=from-task-env\n');
        const { code, text } = await runCli([
            'task', `--env-file=${join(dir, '.env')}`, '--eval', 'echo marker=$CNO_TASK_ENV_MARKER',
        ], dir);
        strictEqual(code, 0, text);
        ok(text.includes('marker=from-task-env'), text);
    });
});

Deno.test({ name: 'cli: --import-map resolves relative targets from the map directory', timeout: 15000 }, async () => {
    await withTempDir('cli-import-map', async (dir) => {
        // The map and its target live in a subdirectory while eval runs from
        // `dir`, so "./vendor.ts" can only resolve through the map's own dir.
        // Keys are plain bare specifiers: "#" keys belong to package.json
        // imports and never reach the import map.
        await Deno.mkdir(join(dir, 'maps'));
        await Deno.writeTextFile(join(dir, 'maps', 'vendor.ts'), 'export const value = 42;\n');
        await Deno.writeTextFile(join(dir, 'maps', 'map.json'), JSON.stringify({
            imports: { 'vendor-lib': './vendor.ts' },
        }));

        const { code, text } = await runCli([
            'eval', `--import-map=${join(dir, 'maps', 'map.json')}`,
            'import { value } from "vendor-lib"; console.log("value=" + value)',
        ], dir);
        strictEqual(code, 0, text);
        ok(text.includes('value=42'), text);

        const missing = await runCli([
            'eval', `--import-map=${join(dir, 'missing.json')}`, '1',
        ], dir);
        strictEqual(missing.code, 1);
        ok(missing.text.includes('cannot read import map file'), missing.text);
    });
});

Deno.test({ name: 'cli: a relative --import-map path still resolves targets from the map directory', timeout: 15000 }, async () => {
    await withTempDir('cli-relative-import-map', async (dir) => {
        await Deno.mkdir(join(dir, 'maps'));
        await Deno.writeTextFile(join(dir, 'maps', 'vendor.ts'), 'export const value = 43;\n');
        await Deno.writeTextFile(join(dir, 'maps', 'map.json'), JSON.stringify({
            imports: { 'vendor-lib': './vendor.ts' },
        }));

        const { code, text } = await runCli([
            'eval', '--import-map=maps/map.json',
            'import { value } from "vendor-lib"; console.log("value=" + value)',
        ], dir);
        strictEqual(code, 0, text);
        ok(text.includes('value=43'), text);
    });
});
