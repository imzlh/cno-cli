import { deepStrictEqual, ok, strictEqual } from 'node:assert';

Deno.test({ name: 'ansi/chalk color stack: generate and strip ANSI sequences', timeout: 30000 }, async () => {
    const ansiEscapesMod = await import('npm:ansi-escapes');
    const stripAnsiMod = await import('npm:strip-ansi');
    const colors = await import('npm:picocolors');
    const chalkMod = await import('npm:chalk');
    const supportsColorMod = await import('npm:supports-color');
    const ansiEscapes = ansiEscapesMod.default ?? ansiEscapesMod;
    const stripAnsi = stripAnsiMod.default ?? stripAnsiMod;
    const chalk = chalkMod.default ?? chalkMod;

    strictEqual(stripAnsi(`${ansiEscapes.cursorTo(0, 0)}${colors.red('red')}`), 'red');
    strictEqual(stripAnsi(chalk.bold.blue('text')), 'text');
    ok('stdout' in supportsColorMod || 'default' in supportsColorMod);
});

Deno.test({ name: 'pako and fflate: gzip round-trip binary data', timeout: 30000 }, async () => {
    const pako = await import('npm:pako');
    const fflate = await import('npm:fflate');
    const input = new TextEncoder().encode('hello compressed world');
    const pakoGzip = pako.gzip(input);
    const pakoOut = pako.ungzip(pakoGzip);
    const fflateGzip = fflate.gzipSync(input);
    const fflateOut = fflate.gunzipSync(fflateGzip);

    deepStrictEqual([...pakoOut], [...input]);
    deepStrictEqual([...fflateOut], [...input]);
});
