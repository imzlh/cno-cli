import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { parseArgv } from '../../src/cli.ts';
import {
    basename,
    canonicalizePath,
    dirname,
    extname,
    hasLeadingSlashDrive,
    isRelative,
    joinPaths,
    normalizePath,
    pathRoot,
    toPosixPath,
} from '../../cts/src/utils/path.ts';
import { LRU } from '../../cts/src/utils/lru.ts';
import {
    cacheFilename,
    compareVersions,
    fmtBytes,
    hashString,
    latestVersion,
    matchLatestVersion,
    npmNameVersion,
    npmPackageName,
    parseArgs,
    safeParse,
    stripJsonc,
} from '../../cts/src/utils/misc.ts';

Deno.test('cli: run stops flag parsing after entry file', () => {
    const cli = parseArgv(['run', 'main.ts', '--user-flag', 'value']);
    strictEqual(cli.cmd, 'run');
    deepStrictEqual(cli.positional, ['main.ts', '--user-flag', 'value']);
    deepStrictEqual(cli.flags, {});
    strictEqual(cli.rawArgs.action, 'run');
    deepStrictEqual(cli.rawArgs.actionArgs, []);
    strictEqual(cli.rawArgs.entry, 'main.ts');
    deepStrictEqual(cli.rawArgs.args, ['--user-flag', 'value']);
});

Deno.test('cli: implicit run keeps pre-entry runtime flags separate', () => {
    const cli = parseArgv(['--reload', 'script.ts', '--script-flag']);
    strictEqual(cli.cmd, null);
    strictEqual(cli.flags.reload, true);
    deepStrictEqual(cli.positional, ['script.ts', '--script-flag']);
    strictEqual(cli.rawArgs.action, 'run');
    deepStrictEqual(cli.rawArgs.internalArgs, []);
    deepStrictEqual(cli.rawArgs.actionArgs, ['--reload']);
    strictEqual(cli.rawArgs.entry, 'script.ts');
    deepStrictEqual(cli.rawArgs.args, ['--script-flag']);
});

Deno.test('cli: inspect optional value consumes only port-like tokens', () => {
    const withPort = parseArgv(['--inspect', '9333', 'run', 'main.ts']);
    strictEqual(withPort.flags.inspect, '9333');
    deepStrictEqual(withPort.rawArgs.internalArgs, ['--inspect', '9333']);
    strictEqual(withPort.rawArgs.entry, 'main.ts');

    const withFile = parseArgv(['--inspect', 'main.ts']);
    strictEqual(withFile.flags.inspect, true);
    strictEqual(withFile.cmd, null);
    deepStrictEqual(withFile.rawArgs.actionArgs, ['--inspect']);
    strictEqual(withFile.rawArgs.entry, 'main.ts');
});

Deno.test('cli: implicit run keeps Node preload flags in execArgv', () => {
    const cli = parseArgv([
        '--require', './preload.cjs',
        '--import=file:///loader.mjs',
        '--loader', './old-loader.mjs',
        '--reload',
        'main.ts',
        '--user',
    ]);
    strictEqual(cli.cmd, null);
    deepStrictEqual(cli.rawArgs.internalArgs, [
        '--require', './preload.cjs',
        '--import=file:///loader.mjs',
        '--loader', './old-loader.mjs',
    ]);
    deepStrictEqual(cli.rawArgs.actionArgs, ['--reload']);
    strictEqual(cli.rawArgs.entry, 'main.ts');
    deepStrictEqual(cli.rawArgs.args, ['--user']);
});

Deno.test('cli: value flags consume their value before the entry file', () => {
    const run = parseArgv(['run', '--config', 'deno.json', '--cache-dir', '.cache', 'main.ts', '--user']);
    strictEqual(run.cmd, 'run');
    strictEqual(run.flags.config, 'deno.json');
    strictEqual(run.flags['cache-dir'], '.cache');
    deepStrictEqual(run.positional, ['main.ts', '--user']);
    deepStrictEqual(run.rawArgs.actionArgs, ['--config', 'deno.json', '--cache-dir', '.cache']);
    strictEqual(run.rawArgs.entry, 'main.ts');
    deepStrictEqual(run.rawArgs.args, ['--user']);

    const test = parseArgv(['test', '--concurrency', '2', 'tests/cts']);
    strictEqual(test.cmd, 'test');
    strictEqual(test.flags.concurrency, '2');
    deepStrictEqual(test.positional, ['tests/cts']);
    deepStrictEqual(test.rawArgs.actionArgs, ['--concurrency', '2']);
});

Deno.test('cli: run keeps repeated env and preload value flags before entry', () => {
    const cli = parseArgv([
        'run',
        '--env=base.env',
        '--env-file', 'override.env',
        '--preload', './preload.ts',
        '--preload=./second.ts',
        'main.ts',
    ]);
    strictEqual(cli.cmd, 'run');
    strictEqual(cli.flags.env, 'base.env');
    strictEqual(cli.flags['env-file'], 'override.env');
    strictEqual(cli.flags.preload, './second.ts');
    deepStrictEqual(cli.rawArgs.actionArgs, [
        '--env=base.env',
        '--env-file', 'override.env',
        '--preload', './preload.ts',
        '--preload=./second.ts',
    ]);
    strictEqual(cli.rawArgs.entry, 'main.ts');
});

Deno.test('cli: value flags can consume dash-prefixed non-option values', () => {
    const negative = parseArgv(['test', '--concurrency', '-1', 'tests/cts']);
    strictEqual(negative.flags.concurrency, '-1');
    ok(!('1' in negative.flags));
    deepStrictEqual(negative.rawArgs.actionArgs, ['--concurrency', '-1']);
    strictEqual(negative.rawArgs.entry, 'tests/cts');

    const dashPath = parseArgv(['run', '--cache-dir', '-cache', 'main.ts']);
    strictEqual(dashPath.flags['cache-dir'], '-cache');
    ok(!('cache' in dashPath.flags));
    deepStrictEqual(dashPath.rawArgs.actionArgs, ['--cache-dir', '-cache']);
    strictEqual(dashPath.rawArgs.entry, 'main.ts');

    const nextFlag = parseArgv(['run', '--config', '--no-lock', 'main.ts']);
    strictEqual(nextFlag.flags.config, true);
    strictEqual(nextFlag.flags['no-lock'], true);
    deepStrictEqual(nextFlag.rawArgs.actionArgs, ['--config', '--no-lock']);
    strictEqual(nextFlag.rawArgs.entry, 'main.ts');
});

Deno.test('cli: option terminator stops cno flag parsing before entry', () => {
    const explicit = parseArgv(['run', '--no-lock', '--', 'main.ts', '--user-flag']);
    strictEqual(explicit.cmd, 'run');
    strictEqual(explicit.flags['no-lock'], true);
    deepStrictEqual(explicit.positional, ['main.ts', '--user-flag']);
    deepStrictEqual(explicit.rawArgs.actionArgs, ['--no-lock']);
    strictEqual(explicit.rawArgs.entry, 'main.ts');
    deepStrictEqual(explicit.rawArgs.args, ['--user-flag']);

    const implicit = parseArgv(['--reload', '--', '--dash-entry.ts', 'arg']);
    strictEqual(implicit.cmd, null);
    strictEqual(implicit.flags.reload, true);
    deepStrictEqual(implicit.positional, ['--dash-entry.ts', 'arg']);
    deepStrictEqual(implicit.rawArgs.actionArgs, ['--reload']);
    strictEqual(implicit.rawArgs.entry, '--dash-entry.ts');
    deepStrictEqual(implicit.rawArgs.args, ['arg']);
});

Deno.test('cli: exec keeps command args after option terminator', () => {
    const cli = parseArgv(['exec', 'prettier', '--', '--version']);
    strictEqual(cli.cmd, 'exec');
    deepStrictEqual(cli.positional, ['prettier', '--', '--version']);
    strictEqual(cli.rawArgs.entry, 'prettier');
    deepStrictEqual(cli.rawArgs.args, ['--', '--version']);
});

Deno.test('cli: eval aliases collect code as entry', () => {
    const short = parseArgv(['-e', 'console.log(1)']);
    strictEqual(short.cmd, 'eval');
    deepStrictEqual(short.positional, ['console.log(1)']);
    strictEqual(short.rawArgs.action, 'eval');
    strictEqual(short.rawArgs.entry, 'console.log(1)');
    deepStrictEqual(short.rawArgs.args, []);

    const long = parseArgv(['--eval', 'console.log(2)']);
    strictEqual(long.cmd, 'eval');
    strictEqual(long.rawArgs.entry, 'console.log(2)');

    const inline = parseArgv(['--eval=console.log(3)']);
    strictEqual(inline.cmd, 'eval');
    deepStrictEqual(inline.positional, ['console.log(3)']);
    deepStrictEqual(inline.flags, {});
    strictEqual(inline.rawArgs.action, 'eval');
    strictEqual(inline.rawArgs.entry, 'console.log(3)');
    deepStrictEqual(inline.rawArgs.args, []);
});

Deno.test('cts path: normalizes separators and drive prefixes', () => {
    strictEqual(toPosixPath('a\\b\\c'), 'a/b/c');
    strictEqual(canonicalizePath('c:\\Users\\me'), 'C:/Users/me');
    strictEqual(hasLeadingSlashDrive('/c:/tmp'), true);
    strictEqual(hasLeadingSlashDrive('/tmp'), false);
    strictEqual(pathRoot('/tmp/a'), '/');
    strictEqual(pathRoot('D:\\tmp\\a'), 'D:/');
});

Deno.test('cts path: basename dirname extname and joins handle common edges', () => {
    strictEqual(basename('/tmp/file.ts', '.ts'), 'file');
    strictEqual(basename('/tmp/dir/'), 'dir');
    strictEqual(dirname('C:\\tmp\\file.ts'), 'C:/tmp');
    strictEqual(dirname('C:/file.ts'), 'C:/');
    strictEqual(dirname('file.ts'), '.');
    strictEqual(extname('.env'), '');
    strictEqual(extname('archive.tar.gz'), '.gz');
    strictEqual(joinPaths('/a/', '/b', 'c'), '/a/b/c');
    strictEqual(joinPaths('C:\\a', 'b'), 'C:/a/b');
});

Deno.test('cts path: normalizePath collapses dot segments without escaping roots', () => {
    strictEqual(normalizePath('/a/./b/../c'), '/a/c');
    strictEqual(normalizePath('a/../../b'), '../b');
    strictEqual(normalizePath('C:\\a\\..\\b'), 'C:/b');
    strictEqual(normalizePath('/../../x'), '/x');
});

Deno.test('cts path: isRelative accepts only explicit relative specifiers', () => {
    for (const spec of ['.', '..', './x', '../x', '.\\x', '..\\x']) {
        ok(isRelative(spec), `${spec} should be relative`);
    }
    for (const spec of ['x', 'pkg/subpath', '/x', 'node:fs']) {
        ok(!isRelative(spec), `${spec} should not be relative`);
    }
});

Deno.test('cts LRU: get updates recency and set evicts least-recently-used', () => {
    const cache = new LRU<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    strictEqual(cache.get('a'), 1);
    cache.set('c', 3);
    strictEqual(cache.has('a'), true);
    strictEqual(cache.has('b'), false);
    strictEqual(cache.has('c'), true);

    cache.set('a', 11);
    cache.set('d', 4);
    strictEqual(cache.get('a'), 11);
    strictEqual(cache.has('c'), false);
    strictEqual(cache.size, 2);

    cache.delete('a');
    strictEqual(cache.has('a'), false);
    cache.clear();
    strictEqual(cache.size, 0);
});

Deno.test('cts misc: hash and cache filenames are stable', () => {
    strictEqual(hashString('hello'), '4f9f2cab');
    strictEqual(cacheFilename('https://example.test/a/b/mod.ts?x=1'), '7b990bea.ts');
    strictEqual(cacheFilename('https://example.test/pkg'), 'e0b5d81c.js');
    strictEqual(cacheFilename('not a url'), hashString('not a url'));
});

Deno.test('cts misc: bytes and semver matching cover common range forms', () => {
    strictEqual(fmtBytes(12), '12B');
    strictEqual(fmtBytes(1536), '1.5KB');
    ok(compareVersions('1.2.3', '1.2.4') < 0);
    ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
    strictEqual(latestVersion(['1.0.0', '1.0.1-beta', '1.0.1']), '1.0.1');
    strictEqual(matchLatestVersion(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0'), '1.2.0');
    strictEqual(matchLatestVersion(['0.1.0', '0.1.5', '0.2.0'], '^0.1.0'), '0.1.5');
    strictEqual(matchLatestVersion(['1.2.0', '1.2.9', '1.3.0'], '1.2'), '1.2.9');
    strictEqual(matchLatestVersion(['1.5.0', '1.5.1', '2.0.0', '2.0.2'], '>= 1.5.0 < 2'), '1.5.1');
    strictEqual(matchLatestVersion(['19.2.7', '19.3.0-canary-a757cb76-20251002'], '^19.2.7'), '19.2.7');
    strictEqual(matchLatestVersion(['19.2.7', '19.3.0-canary-a757cb76-20251002'], '>=19.3.0-canary <20'), '19.3.0-canary-a757cb76-20251002');
    strictEqual(matchLatestVersion(['1.0.0'], '<1.0.0'), null);
});

Deno.test('cts misc: npm specPath parser handles scoped packages and subpaths', () => {
    deepStrictEqual(npmNameVersion('npm:left-pad@1.3.0'), { name: 'left-pad', version: '1.3.0' });
    deepStrictEqual(npmNameVersion('npm:@scope/pkg@2.0.1/sub/path'), { name: '@scope/pkg', version: '2.0.1' });
    strictEqual(npmPackageName('npm:@scope/pkg@2.0.1/sub/path'), '@scope/pkg');
    strictEqual(npmNameVersion('jsr:@scope/pkg@1.0.0'), null);
    strictEqual(npmNameVersion('npm:missing-version'), null);
});

Deno.test('cts misc: stripJsonc removes comments without touching strings', () => {
    const src = `{
        "url": "https://example.test//path",
        // remove this
        "text": "/* keep this */",
        "n": 1 /* remove this too */
    }`;
    const stripped = stripJsonc(src);
    ok(!stripped.includes('remove this'));
    deepStrictEqual(safeParse(stripped), {
        url: 'https://example.test//path',
        text: '/* keep this */',
        n: 1,
    });
});

Deno.test('cts misc: parseArgs handles long, short, inline and positional boundaries', () => {
    const parsed = parseArgs(
        ['--name', 'alice', '--count=3', '--flag=false', '-abc', 'entry.ts', '--raw'],
        { name: 'string', count: 'number', flag: 'boolean', a: 'boolean', b: 'boolean', c: 'boolean' },
    );
    strictEqual(parsed.name, 'alice');
    strictEqual(parsed.count, 3);
    strictEqual(parsed.flag, false);
    strictEqual(parsed.a, true);
    strictEqual(parsed.b, true);
    strictEqual(parsed.c, true);
    strictEqual(parsed._, 'entry.ts');
    deepStrictEqual(parsed._args, ['--raw']);
    strictEqual(parsed._offset, 6);

    const shortValue = parseArgs(['-p8080', '-o', 'out.txt'], { p: 'number', o: 'string' });
    strictEqual(shortValue.p, 8080);
    strictEqual(shortValue.o, 'out.txt');

    const unknown = parseArgs(['--debug=wire', '--loose'], {});
    strictEqual(unknown.debug, 'wire');
    strictEqual(unknown.loose, true);
});
