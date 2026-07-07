import { deepStrictEqual, strictEqual } from 'node:assert';

Deno.test({ name: '@iarna/toml and ini: parse common config formats', timeout: 30000 }, async () => {
    const tomlMod = await import('npm:@iarna/toml');
    const iniMod = await import('npm:ini');
    const toml = tomlMod.default ?? tomlMod;
    const ini = iniMod.default ?? iniMod;

    const parsedToml = toml.parse('name = "cno"\n[build]\nfast = true\n');
    strictEqual(parsedToml.name, 'cno');
    strictEqual(parsedToml.build.fast, true);
    const parsedIni = ini.parse('[section]\nname=cno\ncount=2\n');
    strictEqual(parsedIni.section.name, 'cno');
    strictEqual(parsedIni.section.count, '2');
});

Deno.test({ name: 'csv-parse: sync parser reads quoted records', timeout: 30000 }, async () => {
    const mod = await import('npm:csv-parse/sync');
    const records = mod.parse('name,count\n"a,b",2\nplain,3\n', {
        columns: true,
        skip_empty_lines: true,
    });
    deepStrictEqual(records, [
        { name: 'a,b', count: '2' },
        { name: 'plain', count: '3' },
    ]);
});

Deno.test({ name: 'msgpack-lite: encodes and decodes nested objects', timeout: 30000 }, async () => {
    const mod = await import('npm:msgpack-lite');
    const msgpack = mod.default ?? mod;
    const encoded = msgpack.encode({ name: 'cno', list: [1, true, null] });
    const decoded = msgpack.decode(encoded);
    deepStrictEqual(decoded, { name: 'cno', list: [1, true, null] });
});

Deno.test({ name: 'ms: parses and formats duration strings', timeout: 30000 }, async () => {
    const mod = await import('npm:ms');
    const ms = mod.default ?? mod;
    strictEqual(ms('2 days'), 172800000);
    strictEqual(ms(60000), '1m');
});
