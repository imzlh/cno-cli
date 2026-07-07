import { ok, strictEqual } from 'node:assert';

Deno.test({ name: 'argon2: native prebuild hashes and verifies passwords', timeout: 30000 }, async () => {
    const mod = await import('npm:argon2');
    const argon2 = mod.default ?? mod;
    const hash = await argon2.hash('secret', {
        type: argon2.argon2id,
        memoryCost: 2 ** 12,
        timeCost: 2,
        parallelism: 1,
    });

    strictEqual(await argon2.verify(hash, 'secret'), true);
    strictEqual(await argon2.verify(hash, 'wrong'), false);
});

Deno.test({ name: 'sharp: native prebuild loads libvips and renders PNG', timeout: 30000 }, async () => {
    const mod = await import('npm:sharp');
    const sharp = mod.default ?? mod;
    const png = await sharp({
        create: {
            width: 2,
            height: 2,
            channels: 3,
            background: '#ff0000',
        },
    }).png().toBuffer();

    ok(png.length > 16, `unexpected png length: ${png.length}`);
    strictEqual(png[0], 0x89);
    strictEqual(png[1], 0x50);
    strictEqual(png[2], 0x4e);
    strictEqual(png[3], 0x47);
});

Deno.test({ name: 'sharp: resizes decoded image and returns output metadata', timeout: 30000 }, async () => {
    const mod = await import('npm:sharp');
    const sharp = mod.default ?? mod;
    const input = await sharp({
        create: {
            width: 4,
            height: 3,
            channels: 4,
            background: { r: 10, g: 20, b: 30, alpha: 1 },
        },
    }).png().toBuffer();

    const { data, info } = await sharp(input)
        .resize(2, 2)
        .webp()
        .toBuffer({ resolveWithObject: true });

    strictEqual(info.format, 'webp');
    strictEqual(info.width, 2);
    strictEqual(info.height, 2);
    ok(data.length > 10, `unexpected webp length: ${data.length}`);
});
