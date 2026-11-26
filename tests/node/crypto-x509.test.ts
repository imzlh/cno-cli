import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert';
import * as crypto from 'node:crypto';

const ssl = import.meta.use('ssl');

const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIEaTCCA1GgAwIBAgIUQPijuUia1XhncwQ5SOllneNjGmYwDQYJKoZIhvcNAQEL
BQAwVDELMAkGA1UEBhMCQ04xDDAKBgNVBAoMA0NOTzEVMBMGA1UEAwwMZXhhbXBs
ZS50ZXN0MSAwHgYJKoZIhvcNAQkBFhF0ZXN0QGV4YW1wbGUudGVzdDAeFw0yNjEx
MjEwNzMzMjhaFw0zNjExMTgwNzMzMjhaMFQxCzAJBgNVBAYTAkNOMQwwCgYDVQQK
DANDTk8xFTATBgNVBAMMDGV4YW1wbGUudGVzdDEgMB4GCSqGSIb3DQEJARYRdGVz
dEBleGFtcGxlLnRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDE
oc9ihFE6wrme4YYJfCHdfFeq07Bu6+QtSdKvk/gWlnJzAxJz88XMHAhVMSDboNah
dA72U5GgztRBo5ryM6rlR4WpIOf+hldwiqQEVBJxflZJw+OBqs2rAPss9eklpFy6
RZD5DkG6PefFfdwBScs4Jm+vbyqMUjclf34sHhWDBn4uOsbziVm1L5jVKz12FGfg
BvBYDK/f5851owCyjkewh1yA8vf0VhiTGPP67CFxzsm0neBtYQlo0YRKHvQb5fqm
lT38iwLAKLO9qxy2fniTDWxlRg1McIsQq9+tYlmrtke0EcDNIPmciKcD4V2bz5Cf
aHPlYeoEHxI0CFPRw4ifAgMBAAGjggExMIIBLTAdBgNVHQ4EFgQU0E9TJ2q6ACV5
AZYePrRb3ZZ8v+kwHwYDVR0jBBgwFoAU0E9TJ2q6ACV5AZYePrRb3ZZ8v+kwRQYD
VR0RBD4wPIIMZXhhbXBsZS50ZXN0ghMqLndpbGQuZXhhbXBsZS50ZXN0hwR/AAAB
gRF0ZXN0QGV4YW1wbGUudGVzdDBkBggrBgEFBQcBAQRYMFYwJQYIKwYBBQUHMAGG
GWh0dHA6Ly9vY3NwLmV4YW1wbGUudGVzdC8wLQYIKwYBBQUHMAKGIWh0dHA6Ly9j
YS5leGFtcGxlLnRlc3QvaXNzdWVyLnBlbTAPBgNVHRMBAf8EBTADAQH/MA4GA1Ud
DwEB/wQEAwIChDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDQYJKoZI
hvcNAQELBQADggEBAIdSAQyTzgXBJ5lHP2K+dDh50K6j4BQc7hwOo2uuLF+FXiV9
zQeIFOJczEAai4zUgMjF+03AJXe2IN9fKOUYx3SUNH+e/WZS7wfCN/4nX9BpsnBL
NiYeHb968XMEe1MznQHfKaMOKKEh4qUfSHVVPgpJhaI0SxeG8hb5qAKrR2SSjjaR
FfCxmjrlUjc3szNFgNGdA+1wDwRYX4NpTppvlRNBzmAUo2pEkOQlBxYyjvKDH7bj
s7HW/wAWRrQRfKhHA2ExklVuVDKalBdiMT7n2JfShfFMEMryGNWhN0ay5ud+ZZ1T
AlTkM/Eh4RZJFC4gRObFyqFg48zpKKAnQMF/DrQ=
-----END CERTIFICATE-----
`;

const SHA1 = 'AD:61:A1:0E:89:84:F8:32:E5:00:2B:AA:01:A3:E3:33:4B:FE:CD:E1';
const SHA256 = 'BF:A5:6F:AA:F6:ED:3D:9A:CE:07:2A:10:5F:67:48:F5:08:4C:FE:7A:AA:15:EF:A9:24:55:AD:56:9F:FE:7E:71';
const SHA512 = 'D8:51:9E:AD:9D:69:A7:3D:97:25:60:E3:27:46:24:75:B3:25:F2:B1:46:70:5D:2B:4D:3F:F6:08:E7:AF:B0:1B:DF:68:12:A1:BD:AA:8F:EF:01:58:EA:0C:F2:4A:79:9F:A6:15:9B:B2:C5:A4:EB:D8:E7:15:FF:24:2D:08:6A:95';

function certificateInputs(raw: Uint8Array): (ArrayBuffer | ArrayBufferView)[] {
    const padded = new Uint8Array(raw.byteLength + 6);
    padded.set(raw, 3);
    const view = padded.subarray(3, 3 + raw.byteLength);
    const arrayBuffer = padded.buffer.slice(3, 3 + raw.byteLength) as ArrayBuffer;
    return [
        arrayBuffer,
        view,
        new DataView(view.buffer, view.byteOffset, view.byteLength),
    ];
}

Deno.test('crypto.X509Certificate reads certificate metadata and byte inputs', () => {
    const certificate = new crypto.X509Certificate(CERTIFICATE);
    strictEqual(certificate.subject, 'C=CN\nO=CNO\nCN=example.test\nemailAddress=test@example.test');
    strictEqual(certificate.issuer, certificate.subject);
    strictEqual(certificate.subjectAltName, 'DNS:example.test, DNS:*.wild.example.test, IP Address:127.0.0.1, email:test@example.test');
    strictEqual(certificate.infoAccess, 'OCSP - URI:http://ocsp.example.test/\nCA Issuers - URI:http://ca.example.test/issuer.pem');
    strictEqual(certificate.ca, true);
    deepStrictEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
    const legacyInfoAccess = certificate.toLegacyObject().infoAccess;
    deepStrictEqual(legacyInfoAccess, Object.assign(Object.create(null), {
        'OCSP - URI': ['http://ocsp.example.test/'],
        'CA Issuers - URI': ['http://ca.example.test/issuer.pem'],
    }));
    legacyInfoAccess!['OCSP - URI']!.push('mutated');
    deepStrictEqual(certificate.toLegacyObject().infoAccess!['OCSP - URI'], ['http://ocsp.example.test/']);
    strictEqual(certificate.signatureAlgorithm, 'sha256WithRSAEncryption');
    strictEqual(certificate.signatureAlgorithmOid, '1.2.840.113549.1.1.11');
    strictEqual(certificate.validFromDate.getTime(), certificate.validFromMs);
    strictEqual(certificate.validToDate.getTime(), certificate.validToMs);
    strictEqual(certificate.fingerprint, SHA1);
    strictEqual(certificate.fingerprint256, SHA256);
    strictEqual(certificate.fingerprint512, SHA512);
    strictEqual(certificate.pem, CERTIFICATE);
    strictEqual(certificate.toString(), CERTIFICATE);
    strictEqual(certificate.toJSON(), CERTIFICATE);
    strictEqual(certificate.issuerCertificate, undefined);
    ok(certificate.raw instanceof Uint8Array);
    strictEqual(certificate.publicKey.type, 'public');
    strictEqual(certificate.publicKey.asymmetricKeyType, 'rsa');
    strictEqual(certificate.publicKey, certificate.publicKey);

    const raw = certificate.raw;
    for (const input of certificateInputs(raw)) {
        const candidate = new crypto.X509Certificate(input);
        strictEqual(candidate.subject, certificate.subject);
        strictEqual(candidate.serialNumber, certificate.serialNumber);
        deepStrictEqual([...candidate.raw], [...raw]);
    }

    const info = certificate.info;
    ok(info !== certificate.info);
    if (info.keyUsage) info.keyUsage.push('mutated');
    deepStrictEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
});

Deno.test('crypto.X509Certificate checks SAN names and input errors', () => {
    const certificate = new crypto.X509Certificate(CERTIFICATE);
    strictEqual(certificate.checkHost('example.test'), 'example.test');
    strictEqual(certificate.checkHost('one.wild.example.test'), '*.wild.example.test');
    strictEqual(certificate.checkHost('one.wild.example.test', { wildcards: false }), undefined);
    strictEqual(certificate.checkHost('other.example.test'), undefined);
    strictEqual(certificate.checkEmail('test@example.test'), 'test@example.test');
    strictEqual(certificate.checkEmail('other@example.test'), undefined);
    strictEqual(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    strictEqual(certificate.checkIP('127.0.0.2'), undefined);

    throws(() => certificate.checkIP('127.1'), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => certificate.checkHost('example.test', null as never), { code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => certificate.checkHost('example.test', { wildcards: 'yes' } as never), { code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => certificate.checkEmail(null as never), { code: 'ERR_INVALID_ARG_TYPE' });
});

Deno.test('crypto.X509Certificate legacy names preserve escaped values and grouped attributes', () => {
    const raw = new crypto.X509Certificate(CERTIFICATE).raw;
    const encodedName = Buffer.from('0c0c6578616d706c652e74657374', 'hex');
    const issuerOffset = raw.indexOf(encodedName) + 2;
    const subjectOffset = raw.indexOf(encodedName, issuerOffset) + 2;
    ok(issuerOffset >= 2 && subjectOffset > issuerOffset);

    for (const commonName of ['a\nb', 'a\0b', 'a\rb', 'a\u007fb', 'a\\0Ab', 'a + b', 'a\\b']) {
        const bytes = Buffer.from(raw);
        const name = Buffer.alloc(12, 0x78);
        name.set(Buffer.from(commonName));
        bytes.set(name, issuerOffset);
        bytes.set(name, subjectOffset);
        const legacy = new crypto.X509Certificate(bytes).toLegacyObject();
        strictEqual(legacy.issuer.CN, name.toString());
        strictEqual(legacy.subject.CN, name.toString());
    }

    const separate = Buffer.from('310c300a060355040a0c03434e4f3115301306035504030c0c6578616d706c652e74657374', 'hex');
    const grouped = Buffer.from('3123300c060355040a0c05434e4f2b58301306035504030c0c6578616d706c652e74657374', 'hex');
    strictEqual(grouped.byteLength, separate.byteLength);
    const groupOffset = raw.indexOf(separate);
    ok(groupOffset >= 0);
    const attributeOffset = grouped.indexOf(Buffer.from('0603550403', 'hex')) + 4;
    for (const repeated of [false, true]) {
        const bytes = Buffer.from(raw);
        if (repeated) grouped[attributeOffset] = 0x0a;
        bytes.set(grouped, groupOffset);
        const legacy = new crypto.X509Certificate(bytes).toLegacyObject();
        deepStrictEqual(legacy.issuer, Object.assign(Object.create(null), {
            C: 'CN',
            O: repeated ? ['CNO+X', 'example.test'] : 'CNO+X',
            ...(!repeated ? { CN: 'example.test' } : {}),
            emailAddress: 'test@example.test',
        }));
    }
});

Deno.test('crypto.X509Certificate verifies issuers and key objects', () => {
    const first = ssl.createSelfSignedCert({ commonName: 'x509-first.example.test', days: 1 });
    const second = ssl.createSelfSignedCert({ commonName: 'x509-second.example.test', days: 1 });
    const firstCertificate = new crypto.X509Certificate(first.cert);
    const secondCertificate = new crypto.X509Certificate(second.cert);
    const firstPrivateKey = crypto.createPrivateKey(first.key);
    const firstPublicKey = crypto.createPublicKey(first.key);
    const secondPrivateKey = crypto.createPrivateKey(second.key);
    const secondPublicKey = crypto.createPublicKey(second.key);
    const publicPem = Buffer.from(firstPublicKey.export({ type: 'spki', format: 'pem' }) as string);
    const privatePem = Buffer.from(first.key);
    const importedPublicKeys = [
        crypto.createPublicKey(publicPem),
        crypto.createPublicKey({ key: publicPem, format: 'pem' }),
        crypto.createPublicKey(privatePem),
    ];
    const importedPrivateKeys = [
        crypto.createPrivateKey(privatePem),
        crypto.createPrivateKey({ key: privatePem, format: 'pem' }),
    ];
    publicPem.fill(0);
    privatePem.fill(0);

    strictEqual(firstCertificate.checkIssued(firstCertificate), true);
    strictEqual(firstCertificate.checkIssued(secondCertificate), false);
    strictEqual(firstCertificate.verify(firstPublicKey), true);
    for (const key of importedPublicKeys) strictEqual(firstCertificate.verify(key), true);
    strictEqual(firstCertificate.verify(secondPublicKey), false);
    strictEqual(firstCertificate.checkPrivateKey(firstPrivateKey), true);
    for (const key of importedPrivateKeys) strictEqual(firstCertificate.checkPrivateKey(key), true);
    strictEqual(firstCertificate.checkPrivateKey(secondPrivateKey), false);
    strictEqual(firstCertificate.publicKey.asymmetricKeyType, 'rsa');
    strictEqual(firstCertificate.toLegacyObject().infoAccess, undefined);

    throws(() => firstCertificate.verify(firstPrivateKey), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => firstCertificate.checkPrivateKey(firstPublicKey), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => firstCertificate.checkIssued(null as never), { code: 'ERR_INVALID_ARG_TYPE' });
});

Deno.test('crypto.X509Certificate rejects missing and malformed data', () => {
    throws(() => new crypto.X509Certificate(new Uint8Array()));
    throws(() => new crypto.X509Certificate('not a certificate'));
});
