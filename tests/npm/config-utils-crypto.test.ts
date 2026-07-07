import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Deno.test({ name: 'cheerio: loads server DOM parser dependencies', timeout: 30000 }, async () => {
    const cheerio = await import('npm:cheerio');
    const $ = cheerio.load('<ul><li data-id="a">one</li><li data-id="b">two</li></ul>');
    strictEqual($('li').length, 2);
    strictEqual($('li[data-id="b"]').text(), 'two');
});

Deno.test({ name: 'cheerio: mutates nested DOM and serializes attributes', timeout: 30000 }, async () => {
    const cheerio = await import('npm:cheerio');
    const $ = cheerio.load('<main><article><h1>Title</h1><p class="body">hello</p></article></main>');

    $('article').attr('data-state', 'ready');
    $('p.body').append(' <strong>world</strong>');
    $('main').prepend('<nav><a href="/docs?x=1&amp;y=2">docs</a></nav>');

    strictEqual($('article[data-state="ready"] strong').text(), 'world');
    strictEqual($('nav a').attr('href'), '/docs?x=1&y=2');
    ok($.html().includes('<article data-state="ready">'));
    ok($.html().includes('<strong>world</strong>'));
});

Deno.test({ name: 'config parsers: yaml json5 dotenv round-trip', timeout: 30000 }, async () => {
    const yamlMod = await import('npm:js-yaml');
    const json5Mod = await import('npm:json5');
    const dotenvMod = await import('npm:dotenv');
    const yaml = yamlMod.default ?? yamlMod;
    const json5 = json5Mod.default ?? json5Mod;
    const dotenv = dotenvMod.default ?? dotenvMod;

    deepStrictEqual(yaml.load('name: cno\nitems:\n  - npm\n'), { name: 'cno', items: ['npm'] });
    deepStrictEqual(json5.parse('{name:"cno", trailing:[1,2,],}'), { name: 'cno', trailing: [1, 2] });
    deepStrictEqual(dotenv.parse('A=1\nQUOTED="two"\n'), { A: '1', QUOTED: 'two' });
});

Deno.test({ name: 'dotenv: config reads env file and mutates process.env', timeout: 30000 }, async () => {
    const dotenvMod = await import('npm:dotenv');
    const dotenv = dotenvMod.default ?? dotenvMod;
    const dir = mkdtempSync(join(tmpdir(), 'cno-dotenv-'));
    const previousFile = process.env.CNO_DOTENV_FILE;
    const previousQuoted = process.env.CNO_DOTENV_QUOTED;

    try {
        const file = join(dir, '.env');
        writeFileSync(file, 'CNO_DOTENV_FILE=loaded\nCNO_DOTENV_QUOTED="two words"\n');
        delete process.env.CNO_DOTENV_FILE;
        delete process.env.CNO_DOTENV_QUOTED;

        const result = dotenv.config({ path: file });
        strictEqual(result.parsed?.CNO_DOTENV_FILE, 'loaded');
        strictEqual(process.env.CNO_DOTENV_FILE, 'loaded');
        strictEqual(process.env.CNO_DOTENV_QUOTED, 'two words');
    } finally {
        if (previousFile === undefined) delete process.env.CNO_DOTENV_FILE;
        else process.env.CNO_DOTENV_FILE = previousFile;
        if (previousQuoted === undefined) delete process.env.CNO_DOTENV_QUOTED;
        else process.env.CNO_DOTENV_QUOTED = previousQuoted;
        rmSync(dir, { recursive: true, force: true });
    }
});

Deno.test({ name: 'lodash and lodash-es: CJS and ESM utility packages both execute', timeout: 30000 }, async () => {
    const lodashMod = await import('npm:lodash');
    const lodash = lodashMod.default ?? lodashMod;
    const lodashEs = await import('npm:lodash-es');

    deepStrictEqual(lodash.chunk([1, 2, 3], 2), [[1, 2], [3]]);
    strictEqual(lodashEs.camelCase('hello cno runtime'), 'helloCnoRuntime');
});

Deno.test({ name: 'jsonwebtoken: signs and verifies HS256 tokens', timeout: 30000 }, async () => {
    const mod = await import('npm:jsonwebtoken');
    const jwt = mod.default ?? mod;
    const token = jwt.sign({ sub: 'compat' }, 'secret', { algorithm: 'HS256' });
    const decoded = jwt.verify(token, 'secret');
    strictEqual(decoded.sub, 'compat');
});

Deno.test({ name: 'jsonwebtoken: signs and verifies RS256 PEM tokens', timeout: 30000 }, async () => {
    const mod = await import('npm:jsonwebtoken');
    const crypto = await import('node:crypto');
    const jwt = mod.default ?? mod;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

    const token = jwt.sign({ sub: 'compat', scope: ['read', 'write'] }, privatePem, {
        algorithm: 'RS256',
        keyid: 'compat-key',
    });
    const decoded = jwt.verify(token, publicPem, { algorithms: ['RS256'] });

    strictEqual(decoded.sub, 'compat');
    deepStrictEqual(decoded.scope, ['read', 'write']);
});

Deno.test({ name: 'bcryptjs: hashes and compares passwords in pure JS', timeout: 60000 }, async () => {
    const bcryptjs = await import('npm:bcryptjs');
    const hash = await bcryptjs.hash('secret', 4);
    strictEqual(await bcryptjs.compare('secret', hash), true);
    strictEqual(await bcryptjs.compare('wrong', hash), false);
});

Deno.test({ name: 'bcrypt: loads native addon and compares passwords', timeout: 30000 }, async () => {
    const mod = await import('npm:bcrypt');
    const bcrypt = mod.default ?? mod;
    ok(typeof bcrypt.hash === 'function', 'bcrypt should expose hash');
    const hash = await bcrypt.hash('secret', 4);
    strictEqual(await bcrypt.compare('secret', hash), true);
});
