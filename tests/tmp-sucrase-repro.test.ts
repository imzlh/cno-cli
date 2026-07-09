// Temporary repro: feed hono-base.ts through sucrase directly to see what it produces.
import { transformCnoCode } from '../cts/deps/sucrase/src/index';

const fs = import.meta.use('fs');
const console = import.meta.use('console');

Deno.test('sucrase repro: hono-base.ts', () => {
    const path = '/home/iz/.cts/jsr/hono/hono/4.12.28/src/hono-base.ts';
    const code = new TextDecoder().decode(fs.readFile(path));
    try {
        const out = transformCnoCode(code, path, true, false, 'React.createElement', 'React.Fragment', false);
        console.log('--- SUCRASE OUTPUT (first 200 lines) ---');
        console.log(out.split('\n').slice(0, 200).join('\n'));
    } catch (e) {
        console.log('--- SUCRASE THREW ---');
        console.log(String((e as Error)?.stack ?? e));
    }
});
