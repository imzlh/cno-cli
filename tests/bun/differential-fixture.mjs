import Bun, { file, write, sleep } from 'bun';

const destination = `${process.env.CNO_BUN_ORACLE_DIR}/data.txt`;
const url = new URL(`file:///${destination.replaceAll('\\', '/').replace(/^\//, '')}`);
const input = new Uint8Array([88, 104, 195, 169, 89]);
const written = await write(destination, input.subarray(1, 4));
const handle = file(url, { type: 'text/plain' });
const before = {
    text: await handle.text(),
    bytes: Array.from(await handle.bytes()),
    slice: await handle.slice(1).text(),
    exists: await handle.exists(),
    size: handle.size,
    type: handle.type,
    response: await new Response(handle).text(),
};
await write(destination, '{"value":42}');
const json = await file(destination).json();
await write(destination, '');
await sleep(0);
console.log(JSON.stringify({
    identity: Bun === globalThis.Bun && file === Bun.file && write === Bun.write,
    argv: Bun.argv.slice(1),
    env: Bun.env.CNO_BUN_ORACLE_VALUE,
    main: Bun.main,
    written,
    before,
    json,
    empty: await file(destination).text(),
}));
