import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

function commandEnv(cacheDir: string): Record<string, string> {
    const env = Deno.env.toObject();
    env.CTS_CACHE_DIR = cacheDir;
    env.CTS_LOCK_DIR = '';
    env.CTS_SILENT = 'true';
    env.NODE_OPTIONS = '';
    delete env.__CNO_TEST_CHILD;
    env.ALL_PROXY = '';
    env.HTTP_PROXY = '';
    env.HTTPS_PROXY = '';
    env.all_proxy = '';
    env.http_proxy = '';
    env.https_proxy = '';
    env.no_proxy = '*';
    env.NO_PROXY = '*';
    return env;
}

async function runCno(args: string[], cwd: string, cacheDir: string): Promise<CommandResult> {
    const executable = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(executable, {
        args,
        cwd,
        env: commandEnv(cacheDir),
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

function outputOf(result: CommandResult): string {
    return `${result.stdout}\n${result.stderr}`;
}

function copyPolyfillSource(src: string, dst: string): void {
    Deno.mkdirSync(dst, { recursive: true });
    for (const entry of Deno.readDirSync(src)) {
        const from = join(src, entry.name);
        const to = join(dst, entry.name);
        if (entry.isDirectory) copyPolyfillSource(from, to);
        else if (entry.isFile && entry.name.endsWith('.ts')) Deno.copyFileSync(from, to);
    }
}

function prepareCache(cacheDir: string): void {
    for (const name of ['node', 'bun', 'utils']) {
        copyPolyfillSource(join(Deno.cwd(), 'cno', 'src', name), join(cacheDir, name));
    }
}

function jsonLine(result: CommandResult, prefix: string): Record<string, unknown> {
    const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith(prefix));
    ok(line, `missing ${prefix} line in:\n${outputOf(result)}`);
    return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

Deno.test({ name: 'bun module: static, dynamic, and CJS views share API identity', timeout: 110000 }, async () => {
    await withTempDir('bun-module-identity', async (root) => {
        const cjs = join(root, 'bun-view.cjs');
        const entry = join(root, 'identity.ts');
        await Deno.writeTextFile(cjs, `
            const bun = require('bun');
            module.exports = {
                argv: bun.argv,
                env: bun.env,
                main: bun.main,
                sleep: bun.sleep,
                file: bun.file,
                write: bun.write,
                serve: bun.serve,
                spawn: bun.spawn,
                spawnSync: bun.spawnSync,
                gzipSync: bun.gzipSync,
                gunzipSync: bun.gunzipSync,
                deflateSync: bun.deflateSync,
                inflateSync: bun.inflateSync,
                CryptoHasher: bun.CryptoHasher,
                SHA1: bun.SHA1,
                MD5: bun.MD5,
                MD4: bun.MD4,
                SHA224: bun.SHA224,
                SHA256: bun.SHA256,
                SHA384: bun.SHA384,
                SHA512: bun.SHA512,
                SHA512_256: bun.SHA512_256,
                sha: bun.sha,
                Glob: bun.Glob,
                hash: bun.hash,
                semver: bun.semver,
                randomUUIDv7: bun.randomUUIDv7,
                escapeHTML: bun.escapeHTML,
                pathToFileURL: bun.pathToFileURL,
                fileURLToPath: bun.fileURLToPath,
                concatArrayBuffers: bun.concatArrayBuffers,
                readableStreamToArrayBuffer: bun.readableStreamToArrayBuffer,
                readableStreamToBytes: bun.readableStreamToBytes,
                readableStreamToText: bun.readableStreamToText,
                readableStreamToJSON: bun.readableStreamToJSON,
                sleepSync: bun.sleepSync,
                ArrayBufferSink: bun.ArrayBufferSink,
                Cookie: bun.Cookie,
                CookieMap: bun.CookieMap,
                readableStreamToArray: bun.readableStreamToArray,
                readableStreamToBlob: bun.readableStreamToBlob,
                readableStreamToFormData: bun.readableStreamToFormData,
                deepEquals: bun.deepEquals,
                deepMatch: bun.deepMatch,
                JSONC: bun.JSONC,
                JSON5: bun.JSON5,
                JSONL: bun.JSONL,
                TOML: bun.TOML,
                color: bun.color,
                stripANSI: bun.stripANSI,
                sliceAnsi: bun.sliceAnsi,
                stringWidth: bun.stringWidth,
                wrapAnsi: bun.wrapAnsi,
                which: bun.which,
                nanoseconds: bun.nanoseconds,
                peek: bun.peek,
                allocUnsafe: bun.allocUnsafe,
                indexOfLine: bun.indexOfLine,
                inspect: bun.inspect,
                randomUUIDv5: bun.randomUUIDv5,
                resolve: bun.resolve,
                resolveSync: bun.resolveSync,
                repeat: require('bun'),
            };
        `);
        await Deno.writeTextFile(entry, `
            import Bun, {
                argv, env, main, sleep, file, write, serve, spawn, spawnSync,
                gzipSync, gunzipSync, deflateSync, inflateSync, CryptoHasher,
                SHA1, MD5, MD4, SHA224, SHA256, SHA384, SHA512, SHA512_256, sha,
                Glob, hash, semver,
                randomUUIDv7, escapeHTML, pathToFileURL, fileURLToPath, concatArrayBuffers,
                readableStreamToArrayBuffer, readableStreamToBytes, readableStreamToText,
                readableStreamToJSON,
                sleepSync, ArrayBufferSink, Cookie, CookieMap, readableStreamToArray, readableStreamToBlob, readableStreamToFormData,
                deepEquals, deepMatch, JSONC, JSON5, JSONL, TOML, color, stripANSI, sliceAnsi, stringWidth, wrapAnsi,
                which, nanoseconds, allocUnsafe, indexOfLine, inspect, randomUUIDv5, resolve, resolveSync,
                peek,
            } from 'bun';
            import * as staticNamespace from 'bun';

            const dynamicNamespace = await import('bun');
            const dynamicAgain = await import('bun');
            const cjs = require('./bun-view.cjs');
            console.log('BUN_IDENTITY:' + JSON.stringify({
                global: Bun === globalThis.Bun,
                staticDefaultAbsent: !Object.hasOwn(staticNamespace, 'default'),
                staticNamed: argv === Bun.argv && env === Bun.env && main === Bun.main && sleep === Bun.sleep
                    && file === Bun.file && write === Bun.write && serve === Bun.serve
                    && spawn === Bun.spawn && spawnSync === Bun.spawnSync
                    && gzipSync === Bun.gzipSync && gunzipSync === Bun.gunzipSync
                    && deflateSync === Bun.deflateSync && inflateSync === Bun.inflateSync
                    && CryptoHasher === Bun.CryptoHasher && Glob === Bun.Glob && hash === Bun.hash
                    && SHA1 === Bun.SHA1 && MD5 === Bun.MD5 && MD4 === Bun.MD4
                    && SHA224 === Bun.SHA224 && SHA256 === Bun.SHA256 && SHA384 === Bun.SHA384
                    && SHA512 === Bun.SHA512 && SHA512_256 === Bun.SHA512_256 && sha === Bun.sha
                    && semver === Bun.semver && randomUUIDv7 === Bun.randomUUIDv7
                    && escapeHTML === Bun.escapeHTML && pathToFileURL === Bun.pathToFileURL
                    && fileURLToPath === Bun.fileURLToPath && concatArrayBuffers === Bun.concatArrayBuffers
                    && readableStreamToArrayBuffer === Bun.readableStreamToArrayBuffer
                    && readableStreamToBytes === Bun.readableStreamToBytes
                    && readableStreamToText === Bun.readableStreamToText
                    && readableStreamToJSON === Bun.readableStreamToJSON
                    && sleepSync === Bun.sleepSync
                    && ArrayBufferSink === Bun.ArrayBufferSink
                    && Cookie === Bun.Cookie
                    && CookieMap === Bun.CookieMap
                    && readableStreamToArray === Bun.readableStreamToArray
                    && readableStreamToBlob === Bun.readableStreamToBlob
                    && readableStreamToFormData === Bun.readableStreamToFormData
                    && deepEquals === Bun.deepEquals
                    && deepMatch === Bun.deepMatch
                    && JSONC === Bun.JSONC
                    && JSON5 === Bun.JSON5
                    && JSONL === Bun.JSONL
                    && TOML === Bun.TOML
                    && color === Bun.color
                    && stripANSI === Bun.stripANSI
                    && sliceAnsi === Bun.sliceAnsi
                    && stringWidth === Bun.stringWidth
                    && wrapAnsi === Bun.wrapAnsi
                    && which === Bun.which
                    && nanoseconds === Bun.nanoseconds
                    && peek === Bun.peek
                    && allocUnsafe === Bun.allocUnsafe
                    && indexOfLine === Bun.indexOfLine
                    && inspect === Bun.inspect
                    && randomUUIDv5 === Bun.randomUUIDv5
                    && resolve === Bun.resolve
                    && resolveSync === Bun.resolveSync,
                inspectCustom: Bun.inspect.custom === Symbol.for('nodejs.util.inspect.custom')
                    && inspect.custom === Bun.inspect.custom
                    && inspect.table === Bun.inspect.table,
                dynamicDefaultAbsent: !Object.hasOwn(dynamicNamespace, 'default'),
                dynamicNamed: dynamicNamespace.argv === Bun.argv
                    && dynamicNamespace.env === Bun.env
                    && dynamicNamespace.main === Bun.main
                    && dynamicNamespace.sleep === Bun.sleep
                    && dynamicNamespace.file === Bun.file && dynamicNamespace.write === Bun.write
                    && dynamicNamespace.serve === Bun.serve && dynamicNamespace.spawn === Bun.spawn
                    && dynamicNamespace.spawnSync === Bun.spawnSync,
                dynamicRepeat: dynamicAgain === dynamicNamespace,
                cjsNamed: cjs.argv === Bun.argv
                    && cjs.env === Bun.env
                    && cjs.main === Bun.main
                    && cjs.sleep === Bun.sleep && cjs.file === Bun.file && cjs.write === Bun.write
                    && cjs.serve === Bun.serve && cjs.spawn === Bun.spawn && cjs.spawnSync === Bun.spawnSync,
                cjsRepeat: cjs.repeat === require('bun'),
                cjsDefaultAbsent: !Object.hasOwn(cjs.repeat, 'default'),
                allExportIdentities: Object.keys(Bun).every((key) =>
                    staticNamespace[key] === Bun[key] && dynamicNamespace[key] === Bun[key]
                    && cjs.repeat[key] === Bun[key]),
                globalKeys: Object.keys(Bun).sort(),
                staticKeys: Object.keys(staticNamespace).sort(),
                dynamicKeys: Object.keys(dynamicNamespace).sort(),
                cjsKeys: Object.keys(cjs.repeat).sort(),
            }));
        `);

        const cacheDir = join(root, 'cache');
        prepareCache(cacheDir);
        const result = await runCno([
            'run',
            '--cached-only',
            '--no-http',
            '--no-jsr',
            `--cache-dir=${cacheDir}`,
            '--no-lock',
            '--no-node',
            '--no-oxc',
            entry,
        ], root, cacheDir);
        strictEqual(result.code, 0, outputOf(result));
        const probe = jsonLine(result, 'BUN_IDENTITY:');
        for (const key of [
            'global', 'staticDefaultAbsent', 'staticNamed', 'dynamicDefaultAbsent', 'dynamicNamed',
            'dynamicRepeat', 'inspectCustom', 'cjsNamed', 'cjsRepeat', 'cjsDefaultAbsent', 'allExportIdentities',
        ]) strictEqual(probe[key], true, key);

        const keys = [
            'ArrayBufferSink', 'Cookie', 'CookieMap', 'CryptoHasher', 'SHA1', 'MD5', 'MD4', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'SHA512_256', 'sha',
            'Glob', 'argv', 'concatArrayBuffers', 'deflateSync', 'env', 'escapeHTML',
            'file', 'fileURLToPath', 'gunzipSync', 'gzipSync', 'hash', 'inflateSync', 'main',
            'pathToFileURL', 'randomUUIDv5', 'randomUUIDv7', 'readableStreamToArray', 'readableStreamToArrayBuffer', 'readableStreamToBlob', 'readableStreamToBytes',
            'readableStreamToFormData', 'readableStreamToJSON', 'readableStreamToText', 'semver', 'serve', 'sleep', 'spawn',
            'spawnSync', 'write', 'sleepSync', 'deepEquals', 'deepMatch', 'JSONC', 'JSON5', 'JSONL', 'TOML', 'color', 'stripANSI', 'sliceAnsi', 'stringWidth', 'wrapAnsi',
            'which', 'nanoseconds', 'allocUnsafe', 'indexOfLine', 'inspect', 'resolve', 'resolveSync',
            'peek',
        ];
        const globalKeys = probe.globalKeys as string[];
        for (const key of keys) ok(globalKeys.includes(key), `missing Bun.${key}`);
        deepStrictEqual(probe.cjsKeys, globalKeys);
        deepStrictEqual(probe.staticKeys, globalKeys);
        deepStrictEqual(probe.dynamicKeys, globalKeys);

        let npmCacheExists = false;
        try {
            npmCacheExists = Deno.statSync(join(cacheDir, 'npm')).isDirectory;
        } catch {
            // An offline bare builtin should not create an npm fallback cache.
        }
        strictEqual(npmCacheExists, false);
    });
});
