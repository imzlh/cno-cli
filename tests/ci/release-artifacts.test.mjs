import assert from 'node:assert/strict';
import {
    chmodSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const verifier = join(repository, 'scripts/ci/verify-release-artifacts.sh');

const archiveNames = [
    ...['x86_64', 'i386', 'arm64', 'armv7', 'armv6'].flatMap(target => [
        `cno-linux-${target}.tar.gz`, `cno-linux-minimal-${target}.tar.gz`,
    ]),
    ...['x86_64', 'i386', 'arm64', 'armv7', 'armv6', 'mips', 'mipsel', 'mips64', 'riscv64', 'armv5'].flatMap(target => [
        `cno-linux-musl-${target}.tar.gz`, `cno-linux-musl-dynamic-${target}.tar.gz`,
    ]),
    'cno-macos-x86_64.tar.gz', 'cno-macos-arm64.tar.gz',
    'cno-windows-x64.zip', 'cno-windows-arm64.zip',
];

function makeStage(directory, archive, executable) {
    const stage = mkdtempSync(join(directory, 'stage-'));
    mkdirSync(join(stage, 'ext'));
    writeFileSync(join(stage, archive.endsWith('.zip') ? 'cno.exe' : 'cno'), 'runtime');
    writeFileSync(join(stage, 'ext', archive.endsWith('.zip') ? 'oxc.dll' : archive.startsWith('cno-macos-') ? 'oxc.dylib' : 'oxc.so'), 'extension');
    if (archive.includes('-minimal-') || archive.includes('-dynamic-')) {
        mkdirSync(join(stage, 'lib'));
        writeFileSync(join(stage, 'lib', 'libdependency.so.1'), 'dependency');
    }
    if (!archive.endsWith('.zip')) chmodSync(join(stage, 'cno'), executable ? 0o755 : 0o644);
    return stage;
}

function createArchives(directory, mutate) {
    for (const archive of archiveNames) {
        const stage = makeStage(directory, archive, true);
        mutate?.(stage, archive);
        const output = join(directory, archive);
        const result = archive.endsWith('.zip')
            ? spawnSync('zip', ['-q', '-y', '-r', output, '.'], { cwd: stage, encoding: 'utf8' })
            : spawnSync('tar', ['--sort=name', '-czf', output, '-C', stage, '.'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
    }
}

function setWindowsAttributes(archive) {
    const zip = readFileSync(archive);
    const end = zip.length - 22;
    assert.equal(zip.readUInt32LE(end), 0x06054b50);
    let offset = zip.readUInt32LE(end + 16);
    for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
        assert.equal(zip.readUInt32LE(offset), 0x02014b50);
        const nameLength = zip.readUInt16LE(offset + 28);
        const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString();
        zip[offset + 5] = 0; // MS-DOS origin, without Unix mode bits (Compress-Archive).
        zip.writeUInt32LE(name.endsWith('/') ? 0x10 : 0x20, offset + 38);
        offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    writeFileSync(archive, zip);
}

// PKWARE APPNOTE 4.5.7 stores hardlink targets after the 12-byte Unix metadata.
// zip(1) dereferences disk hardlinks, so write this actual ZIP link representation.
function makeLinkedZip(output, member, target, location = 'both') {
    const entries = ['cno.exe', 'ext/oxc.dll'];
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const name of entries) {
        const nameBytes = Buffer.from(name);
        const unix = Buffer.alloc(16 + Buffer.byteLength(target));
        unix.writeUInt16LE(0x000d);
        unix.writeUInt16LE(unix.length - 4, 2);
        unix.write(target, 16);
        const linked = name === member;
        const localExtra = linked && location !== 'central' ? unix : Buffer.alloc(0);
        const centralExtra = linked && location !== 'local' ? unix : Buffer.alloc(0);
        // Empty regular entries keep CRC and sizes zero, including the hardlink.
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(localExtra.length, 28);
        localParts.push(local, nameBytes, localExtra);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50);
        central.writeUInt16LE(0x0314, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(centralExtra.length, 30);
        central.writeUInt32LE(0o100755 * 0x10000, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBytes, centralExtra);
        offset += local.length + nameBytes.length + localExtra.length;
    }
    const central = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    writeFileSync(output, Buffer.concat([...localParts, central, end]));
    const result = spawnSync('unzip', ['-tqq', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.ok(readFileSync(output).includes(Buffer.from(target)));
}

test('release verification accepts regular release archives', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-release-artifacts-valid-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    createArchives(directory);
    for (const archive of archiveNames.filter(name => name.endsWith('.zip')))
        setWindowsAttributes(join(directory, archive));

    const result = spawnSync('sh', [verifier, directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Verified all 34 release archives/);
});

test('release verification rejects a non-executable Unix runtime archive', t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-release-artifacts-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    for (const [index, archive] of archiveNames.entries()) {
        const stage = makeStage(directory, archive, index !== 0);
        const output = join(directory, archive);
        const result = archive.endsWith('.zip')
            ? spawnSync('zip', ['-q', '-r', output, '.'], { cwd: stage, encoding: 'utf8' })
            : spawnSync('tar', ['-czf', output, '-C', stage, '.'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
    }

    const result = spawnSync('sh', [verifier, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must contain executable regular file cno/);
});

test('release verification rejects tar symlink, hardlink, and special members', async t => {
    const cases = [
        ...['cno', 'ext/oxc.so'].flatMap(member => [
            {
                name: `${member} symlink`,
                type: 'l',
                mutate(stage) {
                    unlinkSync(join(stage, member));
                    symlinkSync('../../outside', join(stage, member));
                },
            },
            {
                name: `${member} hardlink`,
                type: 'h',
                mutate(stage) {
                    // Sorted GNU tar stores this source first, then a real hardlink.
                    writeFileSync(join(stage, 'a-target'), 'linked payload');
                    unlinkSync(join(stage, member));
                    linkSync(join(stage, 'a-target'), join(stage, member));
                },
            },
            {
                name: `${member} fifo`,
                type: 'p',
                mutate(stage) {
                    unlinkSync(join(stage, member));
                    const result = spawnSync('mkfifo', [join(stage, member)], { encoding: 'utf8' });
                    assert.equal(result.status, 0, result.stderr || result.error?.message);
                },
            },
        ]),
    ];

    for (const { name, type, mutate } of cases) {
        await t.test(name, t => {
            const directory = mkdtempSync(join(tmpdir(), 'cno-release-artifacts-tar-'));
            t.after(() => rmSync(directory, { recursive: true, force: true }));
            createArchives(directory, (stage, archive) => {
                if (archive === 'cno-linux-x86_64.tar.gz')
                    mutate(stage);
            });
            const listing = spawnSync('tar', ['-tvzf', join(directory, 'cno-linux-x86_64.tar.gz')], { encoding: 'utf8' });
            assert.equal(listing.status, 0, listing.stderr);
            assert.match(listing.stdout, new RegExp(`^${type}`, 'm'), 'fixture must preserve the actual archive member type');

            const result = spawnSync('sh', [verifier, directory], { encoding: 'utf8' });
            assert.notEqual(result.status, 0, `${name}: verifier unexpectedly accepted archive`);
            assert.match(result.stderr, /unsupported non-regular archive member/);
        });
    }
});

test('release verification rejects zip symlink members', async t => {
    for (const member of ['cno.exe', 'ext/oxc.dll']) {
        await t.test(member, t => {
            const directory = mkdtempSync(join(tmpdir(), 'cno-release-artifacts-zip-symlink-'));
            t.after(() => rmSync(directory, { recursive: true, force: true }));
            createArchives(directory, (stage, archive) => {
                if (archive === 'cno-windows-x64.zip') {
                    unlinkSync(join(stage, member));
                    symlinkSync('../../outside', join(stage, member));
                }
            });
            const listing = spawnSync('unzip', ['-Z', '-l', join(directory, 'cno-windows-x64.zip')], { encoding: 'utf8' });
            assert.equal(listing.status, 0, listing.stderr);
            assert.match(listing.stdout, /^l/m, 'zip -y must preserve the actual symlink type');

            const result = spawnSync('sh', [verifier, directory], { encoding: 'utf8' });
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /unsupported non-regular archive member/);
        });
    }
});

test('release verification rejects ZIP hardlinks in central and local extra fields', async t => {
    for (const location of ['both', 'local', 'central']) {
        for (const member of ['cno.exe', 'ext/oxc.dll']) {
            await t.test(`${member}, ${location} headers`, t => {
                const directory = mkdtempSync(join(tmpdir(), 'cno-release-artifacts-zip-hardlink-'));
                t.after(() => rmSync(directory, { recursive: true, force: true }));
                createArchives(directory);
                makeLinkedZip(join(directory, 'cno-windows-x64.zip'), member, '../../outside', location);

                const result = spawnSync('sh', [verifier, directory], { encoding: 'utf8' });
                assert.notEqual(result.status, 0, 'verifier unexpectedly accepted a ZIP hardlink');
                assert.match(result.stderr, /unsupported ZIP link metadata/);
            });
        }
    }
});
