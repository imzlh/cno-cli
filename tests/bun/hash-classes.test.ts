import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { MD4, MD5, SHA1, SHA224, SHA256, SHA384, SHA512, SHA512_256, sha } from '../../cno/src/bun/crypto/hash-classes.ts';
import { md4 } from '../../cno/src/bun/crypto/md4.ts';
import { Blob } from '../../cno/src/webapi/formdata.ts';

// Expected values below were generated with Bun 1.3.14 (the oracle for
// behavior), and cross-checked against bun-types 1.4.4 for the API surface.

// Generated with Bun 1.3.14 (`Bun.<Class>.hash(pattern(length), "hex")`).
const PATTERN_LENGTHS = [0, 1, 3, 55, 56, 63, 64, 65, 111, 112, 128, 129, 1000];
const patternVectors: Record<string, string[]> = {
    SHA1: [
        'da39a3ee5e6b4b0d3255bfef95601890afd80709',
        '9842926af7ca0a8cca12604f945414f07b01e13d',
        '4201de9f98cb0a9b8cf52398be7802b55d45266a',
        'ddf57317ef34bfee3b6df83d359098930eb278bc',
        'a0d492bb0fc889d0eca3bc137066ab6f4f74f369',
        'c55856749bef509bdfe6bfebfc7bf4e793e82132',
        'bede92be29c3874e1b54ddc77988d606fc857a8e',
        'b05a80522b053d6dc7e0a517d0e70212c7dad11f',
        '4a01b1272627e5be00f57bc3c3029c23a452e629',
        '54c08c2a0ed21de25e3d8606c3929454eb1d3f8b',
        'a09133e6730ffe899efb70204cb5646cd5dc24ee',
        '808aea332ce367541d37adae7f94e59c5c1a934e',
        '4231a8a50a10fa9758db8ec71fdef855b751048a',
    ],
    MD5: [
        'd41d8cd98f00b204e9800998ecf8427e',
        '8666683506aacd900bbd5a74ac4edf68',
        'c9aee4810523ef8658121b8d492c6b41',
        '52c0e574e1198de5fe3f8f11440dcb1b',
        '46c9907fc908ee68b1e7b8e71286a518',
        'a62f6d59e837867693f042f5b8f5a236',
        '7160b8fb5e9e4023d549c3971fbaeead',
        '70bd662e7aefbda85a0f7244167b7897',
        '13f00cb15f0c3fe588d1c17cde14b38f',
        '5fe6a9f76b541ec645559589da9a088a',
        '10b2da1a82f16d99a81a7203fe9f02cb',
        '03fefbbcebe2959cf2270241aafe0250',
        '10046f077f2082ac19676b8079f1cb1a',
    ],
    MD4: [
        '31d6cfe0d16ae931b73c59d7e0c089c0',
        '7a71b83fcd0caf6fd77de7573b0d24ab',
        '380318863357e745939884f2f327f6c0',
        '04d44dc3dbdcf7604f259009de6e352f',
        'cdbc435e37e7a468d04702cf9eba65bb',
        '45a8744e99878276c47927b0164921f4',
        '87733dbe6c3fc125ee30897c751bd9d6',
        '82dd3042d4378ef1b420f15c61975b8b',
        'b0e38b32925b4cea070184889e249097',
        '9fe294f062826eade85385ef4035173b',
        '15cb31f3af813097fd7a706b860c5e2e',
        'e09c1bd9574f43fbb57cb987a4a9c238',
        '9a27d966bf4984d8597862b1c33bfbba',
    ],
    SHA224: [
        'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f',
        '15ebd4b8fdfc6905ea002a3efcc8faa71954739ee62bbbf16836eb5c',
        '956a7e9eeefc4f6175e8cd337cd28a80f6a0a988b3fe0ed647b4a953',
        '703a7d6e61c83903b5db54ddf6dda2268211b47c90bbdac2ed306d8a',
        '850fef35478d7a94a417713dbded4a39c18be2b40e6f20f47066d306',
        '246a939bfdd1eedb1ad51b53a250d197b5752aab09580b7f1df50df7',
        'e480c1c21ffd3f109fc0cde0daf967c748932b64f8e259d98db17420',
        '574507bf89b5d3a0b5dcf4a684a645f27f058f3b11fde279d5b0e462',
        '5d5ba2469a7db3e3d5b622bdefbb8fef5582222b0f3dd41db4b62075',
        'df564afcb13bf4a0b08d0d3132418ad63f523107e6003f3506167a5b',
        '6df983e89c8c13cecdfb5f16fc67792ae3c4d062df69124d889a396f',
        'cdb66bc3b48b8c446ba9e6220d9f9c25e2ed612094901834cde92dc6',
        '23729dacbd480285c5c68439e2fe22ca5611a63cd6c14d2ec5ae2c85',
    ],
    SHA256: [
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        '084fed08b978af4d7d196a7446a86b58009e636b611db16211b65a9aadff29c5',
        '6ab0dba1f4f1dfbb37b4f9eeb092c09fca4900ad32bdcd147d8dde35d6c87c35',
        'e7313d333c272e639f790978283f9eb392e843d0f29b7016828bb1daa4aac70b',
        '4324d65f3c103567f5589c710bc08f8523f929a9272e3af36fc968e52abc6c27',
        '81c80242132f230c3bd41b3e63bbcff16107339549214a99614ff26664625055',
        '39e3d7b6b5d075d37d053ad89b24b41bef4f3c29760c84447cab3f3be1882241',
        'aacca6ff74fdbb296d165a45cecfa04e5127bc008770fbbdd48006f2d2fae95e',
        '67d9492e628fd376e0b2efec8ca2b99b123e202cf620deb270728df979b2f73e',
        '96b928cff8528dbb99602c709a65b846cb6467acb8b722f0d758e4dc27bfc508',
        'd2742f1f4ac6bb7ca2b239ee18402ba8b3f9f8e652d2a72973c2b9ba11c08cf6',
        '307f8fc2c1622b92762e818d39a185d4d667ad49a4b07ceae1f4afa008a93ec4',
        '1e9bc38cbf860b9ec31918b065f9b52476c549a782e0e7990bed8ce3868d2371',
    ],
    SHA384: [
        '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b',
        '8a6c69af6fb6247635f837958446fb8f10e39bd5fbc244f7e635176339a3be614f6394247f01dbe1126c178c7bd48cb5',
        'de5060203c58b419f136c17666d339a05705575827e3600f0475f6fb3089870aede26c5a0903dea5938bcded4ee9e619',
        'fc2728f452750d08b5dbad1aea53202e7fc19c06894d13e36c433b0444a899277c49f16e0577c03db0f0605578836ef6',
        '6c969a865f38d2eaac60b7963a84c97ba27bcb76e589cbe1e2e89ead6aee4ad0337a4268f054be49c604ddd99692036d',
        'be67a9a1162c1d97f183980dc811f4f4f835b8b850eb32ecbf87397b26369bc6646a8f2234940dcff142b627c8e21ebb',
        '99d26430f561864c2f7d90b68650b960c86c85d6bf7f54ceeee404bdd59663a7f05588b5c750b862a2a24f6a9ad4c050',
        'cada16d798ec25243470f7827eb89a2402d52680b092dffc0f59f5a919e5058aebf7ad79dba85c61b179d23534d7c855',
        '341388a9dc2275074e90cf394323761919761c805fd9e370977c9966a0e8c81a52135f02577670b0071638a4a26dbc31',
        '619cc5d06138526d70659eccf602d197e63e1050e22039a7feb40a30a5b2b08fb03729e291df12f8c576e6f1cd8af22a',
        'e8480e9c4dd90f88104a79cbaccec48edbd798a142b4f241d726dc252f1502350e824c7d18dadd59d7d716919fb8f9bf',
        '430173387764874661acba1e914e50f6d0fbac534809e859b1da4396fad3d5f24c25c6a2d02486d8fbda3994713d981a',
        '94c38db521ca733b8904c2d14b6e82d33dcfcc26e1318c579dbee1fc2f472019034e792263b9d46e90e700de2f6e7e91',
    ],
    SHA512: [
        'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
        'e45bf5817ddf94aa2f7a407071f0eedc6beb98f768b4cd33d1176d44d1563a45a5d7212290eb7670c6786b13591aedac86478993895e8b24e612014abaa6ba04',
        '8853167ab14c043919981a6409307ef68b5b726f4b80dcab259daa24b7cabcb8b4bbfd3e2e36ed98465059661f672e6529cdcc673e7eabfa78dd3186745b112a',
        '14fd424b1fcadee624da946ab03f7e1def7c0d6e00f689594319881a26ff30b875ba4c622ac13100c8cc784c9c2eb23159aecbb4a02e3999062f551193e2b256',
        '480fa85be41ef55a41208ca28ffc8743c91cf7d24758defe6f95bfb16de614fc86b701034896b047dd571de4318853d80e0809df162f1752cb26da6ddb94a0dd',
        'ecd42a703a4e93e163d60d55e3785b1a763838b0351bc2e6f7c94b4bfb24f9aa15da5d744ebcebe11f0fc4315d45ba3a047b6e60e07448357f2795bf34b73502',
        '8f3cc30b3fb5bf963688a46488249248ac2c67f0f85a145233c6c1e3c16dcd1df634c07d1d31da02576f65b9cf64e1c3fdb318b689b8a14e2e9552bcf30fb133',
        '22050d1b2c5bd016c4b04c3e84f513ffbbbc057f83dc9ab196fee6684e5ee19d98b84c6538b3c5e1fc67dbc484e9d0a198254e41d0fa0cf5106991e106632419',
        '68cffa6d0d76f309c9ce0d35280939f8e25990c43b7b086ccdf709be35b07d4ddba599541ff2b1c19d34ea49aeafb9659adb7ac3c0b078bb30a22d57fc6687ef',
        'd0865c524d1dddf7c23b799c413f5adcd7caefd3f66a9b49750ec81066012c25a8bcf94ddea6dc525691673097ca40e0101e897fc97218cfdb0704084e2bef4b',
        '99b16f17aa0b969a5b8f08f367719d516e330ccd2660b6f0688ec031dbc783de50a1cd185a2568dba75070a2403d17d4741d163578515dfd2ff756ddfe4d47b1',
        'a1556e29185778aa5991e34b8884c840d589f0fbb4b8ed590e51e9ac4eb03a008125000db2671f8fe7f485b59a77b518670078ecb41a54b4cd02a7f1d2ca4c6d',
        '00e36fccf193e59697a92b5ab24666ce6326d7fa16bf10832d0991ddc591112e9dfa6a636950ed9c4d67344a760654c2ff7785e1d60094d651038735b5dccabd',
    ],
    SHA512_256: [
        'c672b8d1ef56ed28ab87c3622c5114069bdd3ad7b8f9737498d0c01ecef0967a',
        '05b577a248fe933b7c4cdaf4a50e9d61eb8cba9f86c4ad546ac25a0341128ed6',
        '3ebca6ae309ae6ee4154c7500c1773319fad8db1beeabcfb0f33b9544db51069',
        '8c12c6a555202a2f24eae9d29d5901bf14d8355b08fdd880b962813c30e2e50e',
        'd8d15e81e95d2c68bde6c76da58ff17930bcc53926ab3fae45d28c420e4f06cd',
        '12bbbb739014d2158f881b0d98fe55399980e2f520dcd46fddbb934d6c4b134c',
        'f6fd50d9eff545c7d1810c1a6d31428de85a3584d974a3830775fd65fe2cb929',
        'c2e05c6b3e0958dae20472c75f51ee9a85db8cb6793e40446dcda28f27090252',
        '32889a63b00e93a91df09b4292875c8e9ea2d30e482b2f5ab713396275e9378b',
        '468a00c6f938065156bfddf56b22592f569052587264673bc893e92cd1953953',
        '5e14bd0208397b56f5f1b3afb8e48bfcce3c7312684a46bbe9b210503680e547',
        '6c92b5cdba34ee8137d902ba15d4f6246bb2a07c0fef5a0fa536bc8d8db0390f',
        '14271b3d36ca983ae2da2693d995fe68412c0bd5394ec2f05b763586db6e24fd',
    ],
};

const abcVectors: Record<string, string> = {
    "SHA1": "a9993e364706816aba3e25717850c26c9cd0d89d",
    "MD5": "900150983cd24fb0d6963f7d28e17f72",
    "MD4": "a448017aaf21d8525fc10ae87aa6729d",
    "SHA224": "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
    "SHA256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "SHA384": "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
    "SHA512": "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    "SHA512_256": "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23"
};

const emptyVectors: Record<string, string> = {
    "SHA1": "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    "MD5": "d41d8cd98f00b204e9800998ecf8427e",
    "MD4": "31d6cfe0d16ae931b73c59d7e0c089c0",
    "SHA224": "d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f",
    "SHA256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "SHA384": "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b",
    "SHA512": "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
    "SHA512_256": "c672b8d1ef56ed28ab87c3622c5114069bdd3ad7b8f9737498d0c01ecef0967a"
};

// Hash of "\u00e9\ud83d\ude00\ud800": the lone surrogate becomes U+FFFD before hashing.
const unicodeVectors: Record<string, string> = {
    "SHA1": "031fbb854c3dd48e724841867e94f4dab3b4a933",
    "MD5": "b5965351f8ea5e38ca2a314bc22fbd53",
    "MD4": "f5e04ccabd48b15c2f67bc990a6084a8",
    "SHA224": "172c2486ebccc2900cb1956f183cc4d79ae6f099b11bb04215ba41a4",
    "SHA256": "a427a0766d3135ba1259f1febe6b93f9fc1d27813413293403c29c68ec798e0e",
    "SHA384": "d1ff75d0c4081753a4176d52d2f7e9cfcd79c5163a1bab35967912830c849f4834ad24874f1dd21d6e4ef6b8ba4b3365",
    "SHA512": "cb9c20161fd4739657184b1b4c8799fb06669c3caca7d5acbc91a74cc94f48e9daae67087ac35049b254c268c3c49200a6e723c7d9cc33d482b8386db6f4e0fe",
    "SHA512_256": "5f2c943554b51ea40276605447e7d901e76438e448cfb9692b564dc7ff5b18d8"
};

const sha256AbcEncodings: Record<string, string> = {
    'hex': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'base64': 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
    'base64url': 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    'binary': '\u00bax\u0016\u00bf\u008f\u0001\u00cf\u00eaAA@\u00de]\u00ae"#\u00b0\u0003a\u00a3\u0096\u0017z\u009c\u00b4\u0010\u00ffa\u00f2\u0000\u0015\u00ad',
    'latin1': '\u00bax\u0016\u00bf\u008f\u0001\u00cf\u00eaAA@\u00de]\u00ae"#\u00b0\u0003a\u00a3\u0096\u0017z\u009c\u00b4\u0010\u00ffa\u00f2\u0000\u0015\u00ad',
    'ascii': ':x\u0016?\u000f\u0001OjAA@^]."#0\u0003a#\u0016\u0017z\u001c4\u0010\u007far\u0000\u0015-',
    'utf8': '\ufffdx\u0016\ufffd\ufffd\u0001\ufffd\ufffdAA@\ufffd]\ufffd"#\ufffd\u0003a\ufffd\ufffd\u0017z\ufffd\ufffd\u0010\ufffda\ufffd\u0000\u0015\ufffd',
    'utf-8': '\ufffdx\u0016\ufffd\ufffd\u0001\ufffd\ufffdAA@\ufffd]\ufffd"#\ufffd\u0003a\ufffd\ufffd\u0017z\ufffd\ufffd\u0010\ufffda\ufffd\u0000\u0015\ufffd',
    'utf16le': '\u78ba\ubf16\u018f\ueacf\u4141\ude40\uae5d\u2322\u03b0\ua361\u1796\u9c7a\u10b4\u61ff\u00f2\uad15',
    'ucs2': '\u78ba\ubf16\u018f\ueacf\u4141\ude40\uae5d\u2322\u03b0\ua361\u1796\u9c7a\u10b4\u61ff\u00f2\uad15',
    'ucs-2': '\u78ba\ubf16\u018f\ueacf\u4141\ude40\uae5d\u2322\u03b0\ua361\u1796\u9c7a\u10b4\u61ff\u00f2\uad15',
    'HEX': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'Base64': 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
};

// RFC 1320 appendix A.5 test suite.
const md4Rfc: Array<[string, string]> = [
    ["", '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ["a", 'bde52cb31de33e46245e05fbdbd6fb24'],
    ["abc", 'a448017aaf21d8525fc10ae87aa6729d'],
    ["message digest", 'd9130a8164549fe818874806e1c7014b'],
    ["abcdefghijklmnopqrstuvwxyz", 'd79e1c308aa5bbcdeea8ed63df412da9'],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", '043f8582f241db351ce627e153e7f0e4'],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", 'e33b4ddc9c38f2199c3e7b164fcc0536'],
];


interface AnyHasher {
    readonly byteLength: number;
    update(data: unknown, encoding?: unknown): AnyHasher;
    // The digest result type depends on the argument, which these tests vary freely.
    digest(output?: unknown): any;
}
interface AnyHashClass {
    new (...args: unknown[]): AnyHasher;
    readonly prototype: AnyHasher;
    readonly byteLength: number;
    readonly name: string;
    hash(input: unknown, output?: unknown): any;
}

const classes: Record<string, [AnyHashClass, number]> = {
    SHA1: [SHA1 as unknown as AnyHashClass, 20],
    MD5: [MD5 as unknown as AnyHashClass, 16],
    MD4: [MD4 as unknown as AnyHashClass, 16],
    SHA224: [SHA224 as unknown as AnyHashClass, 28],
    SHA256: [SHA256 as unknown as AnyHashClass, 32],
    SHA384: [SHA384 as unknown as AnyHashClass, 48],
    SHA512: [SHA512 as unknown as AnyHashClass, 64],
    SHA512_256: [SHA512_256 as unknown as AnyHashClass, 32],
};

const hex = (bytes: ArrayBufferView | ArrayBuffer) => {
    const view = bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from(view, byte => byte.toString(16).padStart(2, '0')).join('');
};
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 255);
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

Deno.test('bun hash classes: vectors across block boundaries', () => {
    for (const [name, [Hash]] of Object.entries(classes)) {
        PATTERN_LENGTHS.forEach((length, index) => {
            const bytes = pattern(length);
            const expected = patternVectors[name][index];
            strictEqual(Hash.hash(bytes, 'hex'), expected, `${name} static ${length}`);
            // Split updates must equal the one-shot digest.
            const split = Math.floor(length / 3);
            const hasher = new Hash();
            strictEqual(hasher.update(bytes.subarray(0, split)), hasher);
            hasher.update(bytes.subarray(split));
            strictEqual(hasher.digest('hex'), expected, `${name} incremental ${length}`);
        });
        strictEqual(Hash.hash('abc', 'hex'), abcVectors[name]);
        strictEqual(Hash.hash('', 'hex'), emptyVectors[name]);
        strictEqual(new Hash().digest('hex'), emptyVectors[name]);
    }
});

Deno.test('bun hash classes: MD4 matches RFC 1320', () => {
    for (const [input, expected] of md4Rfc) {
        strictEqual(hex(md4(new TextEncoder().encode(input))), expected);
        strictEqual(MD4.hash(input, 'hex'), expected);
    }
});

Deno.test('bun hash classes: class shape matches Bun', () => {
    for (const [name, [Hash, size]] of Object.entries(classes)) {
        strictEqual(typeof Hash, 'function');
        strictEqual(Hash.name, name);
        strictEqual(Hash.length, 0);
        strictEqual(Hash.byteLength, size);
        strictEqual(new Hash().byteLength, size);
        strictEqual(Object.prototype.toString.call(new Hash()), `[object ${name}]`);
        deepStrictEqual(Reflect.ownKeys(new Hash()), []);
        strictEqual(Hash.hash.length, 2);
        strictEqual(Hash.prototype.update.length, 1);
        strictEqual(Hash.prototype.digest.length, 0);
        deepStrictEqual(Reflect.ownKeys(Hash).map(String).sort(), ['byteLength', 'hash', 'length', 'name', 'prototype']);
        deepStrictEqual(Reflect.ownKeys(Hash.prototype).map(String).sort(), ['Symbol(Symbol.toStringTag)', 'byteLength', 'constructor', 'digest', 'update']);
        const byteLength = Object.getOwnPropertyDescriptor(Hash.prototype, 'byteLength')!;
        strictEqual(byteLength.enumerable, true);
        strictEqual(byteLength.configurable, false);
        strictEqual(typeof byteLength.get, 'function');
        strictEqual(Object.getOwnPropertyDescriptor(Hash, 'prototype')!.writable, false);
        throws(() => { (Hash as unknown as () => void)(); }, (error: unknown) => (error as Error).name === 'TypeError' && /cannot be invoked without 'new'/.test((error as Error).message) && code('ERR_ILLEGAL_CONSTRUCTOR')(error));
        throws(() => { (Hash as { byteLength: number }).byteLength = 1; }, TypeError);
        // Extra constructor arguments are ignored and subclasses work.
        class Derived extends Hash {}
        strictEqual(hex(new Derived().update('abc').digest()), abcVectors[name]);
        strictEqual(new Hash('x', 1).update('abc').digest('hex'), abcVectors[name]);
    }
    strictEqual(sha.length, 1);
    strictEqual(sha.name, 'sha');
});

Deno.test('bun hash classes: digest outputs', () => {
    for (const [name, [Hash, size]] of Object.entries(classes)) {
        const digest = new Hash().update('abc').digest() as Uint8Array;
        strictEqual(Object.getPrototypeOf(digest), Uint8Array.prototype, name);
        strictEqual(digest.byteLength, size);
        strictEqual(hex(digest), abcVectors[name]);
        for (const empty of [undefined, null]) {
            strictEqual(hex(new Hash().update('abc').digest(empty) as Uint8Array), abcVectors[name]);
        }
        strictEqual(hex(Hash.hash('abc') as Uint8Array), abcVectors[name]);

        // Buffer encoding is case-insensitive and returns a Buffer.
        for (const spelling of ['buffer', 'Buffer']) {
            const buffer = new Hash().update('abc').digest(spelling) as Buffer;
            ok(Buffer.isBuffer(buffer));
            strictEqual(hex(buffer), abcVectors[name]);
        }

        // Output buffers: written in place, larger buffers keep their tail.
        const exact = new Uint8Array(size);
        strictEqual(Hash.hash('abc', exact), exact);
        strictEqual(hex(exact), abcVectors[name]);
        const wide = new Uint8Array(size + 8).fill(7);
        strictEqual(new Hash().update('abc').digest(wide), wide);
        strictEqual(hex(wide.subarray(0, size)), abcVectors[name]);
        deepStrictEqual(Array.from(wide.subarray(size)), Array(8).fill(7));
        const arrayBuffer = new ArrayBuffer(size + 4);
        strictEqual(Hash.hash('abc', arrayBuffer), arrayBuffer);
        strictEqual(hex(arrayBuffer.slice(0, size)), abcVectors[name]);
        const view = new DataView(new ArrayBuffer(size));
        strictEqual(Hash.hash('abc', view), view);
        strictEqual(hex(view), abcVectors[name]);
        const backing = new Uint8Array(size + 6).fill(42);
        const window = backing.subarray(3, 3 + size);
        strictEqual(Hash.hash('abc', window), window);
        deepStrictEqual(Array.from(backing.subarray(0, 3)), [42, 42, 42]);
        deepStrictEqual(Array.from(backing.subarray(3 + size)), [42, 42, 42]);
        if (size % 4 === 0) {
            const words = new Uint32Array(size / 4);
            strictEqual(Hash.hash('abc', words), words);
            strictEqual(hex(words), abcVectors[name]);
        }
        const shared = new Uint8Array(new SharedArrayBuffer(size));
        strictEqual(Hash.hash('abc', shared), shared);
        strictEqual(hex(shared), abcVectors[name]);

        throws(() => Hash.hash('abc', new Uint8Array(size - 1)), (error: unknown) => error instanceof TypeError && error.message === `TypedArray must be at least ${size} bytes` && code('ERR_INVALID_ARG_TYPE')(error));
        throws(() => new Hash().digest(new ArrayBuffer(size - 1)), /must be at least/);
    }
});

Deno.test('bun hash classes: string encodings', () => {
    for (const [encoding, expected] of Object.entries(sha256AbcEncodings)) {
        strictEqual(new SHA256().update('abc').digest(encoding as never), expected, encoding);
        strictEqual(SHA256.hash('abc', encoding as 'hex'), expected, `hash ${encoding}`);
    }
    strictEqual(SHA256.hash('abc', new String('hex') as unknown as 'hex'), sha256AbcEncodings.hex);
    for (const bad of ['', 'utf-16le', 'base32', 'hex ', 'nope']) {
        throws(() => new SHA256().digest(bad as 'hex'), (error: unknown) => error instanceof TypeError && error.message === `Unknown encoding: ${bad}` && code('ERR_INVALID_ARG_VALUE')(error), `digest ${JSON.stringify(bad)}`);
        throws(() => SHA256.hash('abc', bad as 'hex'), /Unknown encoding/);
    }
    for (const bad of [5, true, {}, 0n, () => 1, Symbol('x'), []]) {
        throws(() => new SHA256().digest(bad as never), (error: unknown) => error instanceof TypeError && error.message === 'expected string or buffer' && code('ERR_INVALID_ARG_TYPE')(error));
        throws(() => SHA256.hash('abc', bad as never), /expected string or buffer/);
    }
    // hash() treats null as a bad output while digest() treats it as "none".
    throws(() => SHA256.hash('abc', null as never), /expected string or buffer/);
    // A rejected digest() argument does not consume the hasher.
    const hasher = new SHA256().update('abc');
    throws(() => hasher.digest('nope' as 'hex'), TypeError);
    throws(() => hasher.digest(new Uint8Array(4)), TypeError);
    throws(() => hasher.digest(5 as never), TypeError);
    strictEqual(hasher.digest('hex'), abcVectors.SHA256);
});

Deno.test('bun hash classes: inputs', () => {
    for (const [name, [Hash]] of Object.entries(classes)) {
        const expected = abcVectors[name];
        const bytes = new TextEncoder().encode('abc');
        const padded = new Uint8Array([9, ...bytes, 9]);
        strictEqual(Hash.hash(bytes, 'hex'), expected);
        strictEqual(Hash.hash(bytes.buffer, 'hex'), expected);
        strictEqual(Hash.hash(padded.subarray(1, 4), 'hex'), expected);
        strictEqual(Hash.hash(new DataView(padded.buffer, 1, 3), 'hex'), expected);
        strictEqual(Hash.hash(Buffer.from('abc'), 'hex'), expected);
        strictEqual(Hash.hash(new String('abc'), 'hex'), expected);
        strictEqual(Hash.hash(new Blob(['abc']), 'hex'), expected);
        strictEqual(Hash.hash(new Blob([]), 'hex'), emptyVectors[name]);
        strictEqual(new Hash().update(new Blob(['a'])).update(new Blob(['bc'])).digest('hex'), expected);
        strictEqual(Hash.hash(new Uint8Array(new SharedArrayBuffer(0)), 'hex'), emptyVectors[name]);
        strictEqual(Hash.hash(new SharedArrayBuffer(0), 'hex'), emptyVectors[name]);
        strictEqual(Hash.hash(new Uint16Array([0x6261, 0x0063]).subarray(0, 1), 'hex'), Hash.hash('ab', 'hex'));
        strictEqual(Hash.hash('a\0b', 'hex'), Hash.hash(new Uint8Array([97, 0, 98]), 'hex'));
        // The second argument to update() is not an encoding.
        strictEqual(new Hash().update('abc', 'hex' as never).digest('hex'), expected);
        // Lone surrogates hash as U+FFFD; astral pairs stay intact.
        strictEqual(Hash.hash('\u00e9\ud83d\ude00\ud800', 'hex'), unicodeVectors[name]);
        strictEqual(Hash.hash('\ud800', 'hex'), Hash.hash('\ufffd', 'hex'));
        strictEqual(Hash.hash('\ude00\ud83d', 'hex'), Hash.hash('\ufffd\ufffd', 'hex'));
    }
});

Deno.test('bun hash classes: update snapshots its input', () => {
    for (const [name, [Hash]] of Object.entries(classes)) {
        const input = new Uint8Array([97, 98, 99]);
        const hasher = new Hash();
        hasher.update(input);
        input.fill(0);
        strictEqual(hasher.digest('hex'), abcVectors[name]);
    }
});

Deno.test('bun hash classes: rejects unsupported inputs', () => {
    for (const [, [Hash]] of Object.entries(classes)) {
        for (const bad of [5, null, undefined, {}, [97], true, 0n, Symbol('x'), () => 1]) {
            throws(() => new Hash().update(bad), (error: unknown) => error instanceof TypeError && error.message === 'expected blob or string or buffer' && code('ERR_INVALID_ARG_TYPE')(error));
            throws(() => Hash.hash(bad), (error: unknown) => error instanceof TypeError && error.message === 'expected blob, string or buffer' && code('ERR_INVALID_ARG_TYPE')(error));
        }
        throws(() => (Hash.hash as () => unknown)(), /expected blob, string or buffer/);
        throws(() => (new Hash().update as () => unknown).call(new Hash()), /expected blob or string or buffer/);
        // A rejected update leaves the hasher usable.
        const hasher = new Hash();
        throws(() => hasher.update(5), TypeError);
        strictEqual(hasher.update('').digest('hex'), emptyVectors[Object.keys(classes).find(key => classes[key][0] === Hash)!]);
        // Input is validated before the output argument.
        throws(() => Hash.hash(5, 'nope'), /expected blob, string or buffer/);
        throws(() => Hash.hash('a', 'nope'), /Unknown encoding/);
    }
});

Deno.test('bun hash classes: Bun.file blobs are rejected like Bun', async () => {
    const { file, write } = await import('../../cno/src/bun/file.ts');
    const directory = await Deno.makeTempDir({ prefix: 'cno-bun-hash-classes-' });
    try {
        const path = `${directory}/input.txt`;
        await write(path, 'abc');
        for (const input of [file(path), file(path).slice(0, 1)]) {
            throws(() => SHA256.hash(input, 'hex'), (error: unknown) => error instanceof TypeError && error.message === 'File blob cannot be used here' && code('ERR_INVALID_ARG_TYPE')(error));
            throws(() => new SHA256().update(input), /File blob cannot be used here/);
            throws(() => sha(input, 'hex'), /File blob cannot be used here/);
        }
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test('bun hash classes: single-use state errors', () => {
    for (const [name, [Hash]] of Object.entries(classes)) {
        const hasher = new Hash();
        hasher.update('abc');
        strictEqual(hasher.digest('hex'), abcVectors[name]);
        for (const action of [() => hasher.update('x'), () => hasher.update(5 as never), () => hasher.digest(), () => hasher.digest('nope' as 'hex')]) {
            throws(action, (error: unknown) => error instanceof Error && !(error instanceof TypeError) && code('ERR_INVALID_STATE')(error) && error.message.startsWith(`${name} hasher already digested, create a new instance to `));
        }
        throws(() => hasher.update('x'), /create a new instance to update$/);
        throws(() => hasher.digest(), /create a new instance to digest again$/);
        strictEqual(hasher.byteLength, classes[name][1]);
        // Instances are independent.
        const other = new Hash();
        strictEqual(other.update('abc').digest('hex'), abcVectors[name]);
    }
});

Deno.test('bun hash classes: receiver checks', () => {
    const sha1 = new SHA1();
    throws(() => SHA256.prototype.update.call(sha1 as never, 'a'), (error: unknown) => error instanceof TypeError && error.message === 'Expected this to be instanceof SHA256, but received an instance of SHA1' && code('ERR_INVALID_THIS')(error));
    throws(() => (SHA256.prototype.digest as Function).call({}), (error: unknown) => error instanceof TypeError && error.message === 'Expected this to be instanceof SHA256, but received an instance of Object' && code('ERR_INVALID_THIS')(error));
    throws(() => SHA256.prototype.update.call(undefined as never, 'a'), TypeError);
    throws(() => Object.create(SHA256.prototype).update('a'), /Expected this to be instanceof SHA256/);
    const byteLength = Object.getOwnPropertyDescriptor(SHA256.prototype, 'byteLength')!.get!;
    throws(() => byteLength.call({}), (error: unknown) => error instanceof TypeError && error.message === 'The SHA256.byteLength getter can only be used on instances of SHA256');
    throws(() => byteLength.call(sha1), TypeError);
    // Static hash() does not depend on its receiver.
    const detached = SHA256.hash;
    strictEqual(detached('abc', 'hex'), abcVectors.SHA256);
    strictEqual((SHA256.hash as Function).call(undefined, 'abc', 'hex'), abcVectors.SHA256);
});

Deno.test('bun hash classes: sha helper is SHA-512/256', () => {
    strictEqual(sha('abc', 'hex'), abcVectors.SHA512_256);
    strictEqual(sha('abc', 'base64'), 'UwSOJoGUHvmbLim3a0x9q+TC0MY0/G1G4OLxMQfnryM=');
    const digest = sha('abc');
    strictEqual(Object.getPrototypeOf(digest), Uint8Array.prototype);
    strictEqual(hex(digest), abcVectors.SHA512_256);
    strictEqual(hex(sha(new Uint8Array(0))), emptyVectors.SHA512_256);
    const wide = new Uint8Array(40).fill(7);
    strictEqual(sha('abc', wide), wide);
    strictEqual(hex(wide.subarray(0, 32)), abcVectors.SHA512_256);
    deepStrictEqual(Array.from(wide.subarray(32)), Array(8).fill(7));
    const buffer = new ArrayBuffer(32);
    strictEqual(sha(new Blob(['abc']), buffer), buffer);
    strictEqual(hex(buffer), abcVectors.SHA512_256);
    ok(Buffer.isBuffer(sha('abc', 'buffer' as 'hex')));
    strictEqual((sha as (input: string, output?: unknown) => unknown)('abc', undefined) instanceof Uint8Array, true);
    throws(() => sha('abc', new Uint8Array(16)), /TypedArray must be at least 32 bytes/);
    throws(() => sha('abc', 'nope' as 'hex'), /Unknown encoding: nope/);
    throws(() => sha('abc', null as never), /expected string or buffer/);
    throws(() => (sha as () => unknown)(), /expected blob, string or buffer/);
    throws(() => sha(5 as never, 'hex'), /expected blob, string or buffer/);
});

Deno.test('bun hash classes: no cross-talk between algorithms', () => {
    const digests = new Set(Object.values(classes).map(([Hash]) => hex(Hash.hash('abc') as Uint8Array)));
    strictEqual(digests.size, 8); // SHA256 and SHA512_256 share a length but not a value.
    notStrictEqual(abcVectors.SHA256, abcVectors.SHA512_256);
    strictEqual(new Set(Object.keys(classes)).size, 8);
});
