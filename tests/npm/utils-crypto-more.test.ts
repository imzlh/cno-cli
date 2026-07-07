import { deepStrictEqual, ok, strictEqual } from 'node:assert';

Deno.test({ name: 'ramda date-fns and dayjs: functional and date utilities execute', timeout: 30000 }, async () => {
    const ramda = await import('npm:ramda');
    const dateFns = await import('npm:date-fns');
    const dayjsMod = await import('npm:dayjs');
    const dayjs = dayjsMod.default ?? dayjsMod;

    deepStrictEqual(ramda.pipe(ramda.map((n: number) => n + 1), ramda.filter((n: number) => n > 2))([1, 2, 3]), [3, 4]);
    strictEqual(dateFns.format(new Date('2020-01-02T00:00:00Z'), 'yyyy-MM-dd'), '2020-01-02');
    strictEqual(dayjs('2020-01-02').add(1, 'day').format('YYYY-MM-DD'), '2020-01-03');
});

Deno.test({ name: 'uuid and nanoid: generate valid identifiers', timeout: 30000 }, async () => {
    const uuid = await import('npm:uuid');
    const nanoid = await import('npm:nanoid');
    const id = uuid.v4();
    const tiny = nanoid.nanoid(12);

    ok(/^[0-9a-f-]{36}$/.test(id), id);
    strictEqual(tiny.length, 12);
});

Deno.test({ name: 'crypto-js: hashes and HMACs data in pure JS', timeout: 30000 }, async () => {
    const mod = await import('npm:crypto-js');
    const CryptoJS = mod.default ?? mod;
    strictEqual(CryptoJS.SHA256('abc').toString(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    strictEqual(CryptoJS.HmacSHA256('abc', 'secret').toString(), '9946dad4e00e913fc8be8e5d3f7e110a4a9e832f83fb09c345285d78638d8a0e');
});

Deno.test({ name: 'jose: signs and verifies HS256 JWTs through WebCrypto', timeout: 30000 }, async () => {
    const jose = await import('npm:jose');
    const secret = new TextEncoder().encode('secret-secret-secret-secret');
    const jwt = await new jose.SignJWT({ sub: 'compat' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secret);
    const verified = await jose.jwtVerify(jwt, secret);
    strictEqual(verified.payload.sub, 'compat');
});
