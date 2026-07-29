import { ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createConfig } from '../../cts/src/config.ts';
import { StepType, type Flow, type Step, type StepResult, type TarFile } from '../../cts/src/flow.ts';
import { NpmHandler } from '../../cts/src/resolve/protocols/npm.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

const PACKAGE_NAME = 'integrity-fixture';
const VERSION = '1.0.0';
const TARBALL_URL = 'https://registry.example.test/integrity-fixture-1.0.0.tgz';
const TARBALL_BODY = engine.encodeString('offline tarball response bytes');

function drive<T>(flow: Flow<T>, handle: (step: Step) => StepResult): T {
    let state = flow.next();
    while (!state.done) {
        const step = state.value;
        let result: StepResult;
        if (step.type === StepType.FLOW) {
            drive(step.flow, handle);
            result = undefined;
        } else if (step.type === StepType.FLOW_ALL) {
            for (const nested of step.flows) drive(nested, handle);
            result = undefined;
        } else {
            result = handle(step);
        }
        state = flow.next(result);
    }
    return state.value;
}

function tarFiles(version = VERSION): TarFile[] {
    const manifest = engine.encodeString(JSON.stringify({
        name: PACKAGE_NAME,
        version,
        main: 'index.js',
    }));
    const source = engine.encodeString('module.exports = 42;\n');
    return [
        { path: 'package/package.json', content: manifest, size: manifest.byteLength, mode: 0o644, type: 'file' },
        { path: 'package/index.js', content: source, size: source.byteLength, mode: 0o644, type: 'file' },
    ];
}

function install(
    root: string,
    dist: { integrity?: string; shasum?: string },
    stats = { archiveCount: 0 },
    options: { requestedVersion?: string; registryVersion?: string; tarVersion?: string } = {},
): { archiveCount: number; entry: string } {
    const cacheDir = join(root, 'cache');
    const handler = new NpmHandler(createConfig({
        cacheDir,
        silent: true,
        ignoreScripts: true,
        disableLock: true,
    }));
    const registryVersion = options.registryVersion ?? VERSION;
    const metadata = engine.encodeString(JSON.stringify({
        versions: {
            [registryVersion]: {
                version: registryVersion,
                dist: { tarball: TARBALL_URL, ...dist },
            },
        },
        'dist-tags': { latest: registryVersion },
    }));
    const requestedVersion = options.requestedVersion ?? VERSION;
    const info = drive(handler.resolve(`npm:${PACKAGE_NAME}@${requestedVersion}`, join(root, 'entry.ts')), (step) => {
        switch (step.type) {
            case StepType.FS_EXISTS:
                return existsSync(step.path);
            case StepType.FS_READ_TEXT:
                return readFileSync(step.path, 'utf8');
            case StepType.FS_READ_BYTES:
                return new Uint8Array(readFileSync(step.path));
            case StepType.FS_ENSURE_DIR:
                mkdirSync(step.path, { recursive: true });
                return undefined;
            case StepType.FS_WRITE_TEXT:
                mkdirSync(dirname(step.path), { recursive: true });
                writeFileSync(step.path, step.text);
                return undefined;
            case StepType.FS_WRITE_BYTES:
                mkdirSync(dirname(step.path), { recursive: true });
                writeFileSync(step.path,
                    step.data instanceof Uint8Array ? step.data : new Uint8Array(step.data));
                return undefined;
            case StepType.NET_FETCH:
                return {
                    status: 200,
                    headers: [],
                    body: step.url === TARBALL_URL ? TARBALL_BODY : metadata,
                };
            case StepType.ARCHIVE_UNTAR_GZ:
                stats.archiveCount++;
                return tarFiles(options.tarVersion);
            default:
                throw new Error(`Unexpected flow step: ${step.type}`);
        }
    });
    return { archiveCount: stats.archiveCount, entry: info.localPath };
}

Deno.test('cts npm registry: rejects mismatched integrity before tar extraction', () => {
    const root = makePosixTempDir('npm-integrity-mismatch');
    try {
        const wrong = engine.encodeString('different bytes');
        const integrity = `sha512-${crypto.base64Encode(crypto.sha512(wrong))}`;
        const correctShasum = crypto.hexEncode(crypto.sha1(TARBALL_BODY));
        const stats = { archiveCount: 0 };
        throws(() => install(root, { integrity, shasum: correctShasum }, stats),
            /Integrity check failed for npm:integrity-fixture@1\.0\.0/);
        strictEqual(stats.archiveCount, 0);
        ok(!existsSync(join(root, 'cache', 'npm', `${PACKAGE_NAME}@${VERSION}`, 'package.json')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm registry: rejects downloads without integrity metadata', () => {
    const root = makePosixTempDir('npm-integrity-missing');
    try {
        const stats = { archiveCount: 0 };
        throws(() => install(root, {}, stats),
            /Integrity check failed for npm:integrity-fixture@1\.0\.0/);
        strictEqual(stats.archiveCount, 0);
        ok(!existsSync(join(root, 'cache', 'npm', `${PACKAGE_NAME}@${VERSION}`, 'package.json')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm registry: accepts SRI and legacy shasum metadata', () => {
    const cases = [
        {
            label: 'sri',
            dist: { integrity: `sha512-${crypto.base64Encode(crypto.sha512(TARBALL_BODY))}` },
        },
        {
            label: 'shasum',
            dist: { shasum: crypto.hexEncode(crypto.sha1(TARBALL_BODY)) },
        },
    ];
    for (const testCase of cases) {
        const root = makePosixTempDir(`npm-integrity-${testCase.label}`);
        try {
            const result = install(root, testCase.dist);
            strictEqual(result.archiveCount, 1);
            strictEqual(readFileSync(result.entry, 'utf8'), 'module.exports = 42;\n');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
});

Deno.test('cts npm registry: rejects path-unsafe resolved versions before extraction', () => {
    const root = makePosixTempDir('npm-registry-version-containment');
    try {
        const stats = { archiveCount: 0 };
        const integrity = `sha512-${crypto.base64Encode(crypto.sha512(TARBALL_BODY))}`;
        throws(() => install(root, { integrity }, stats, {
            requestedVersion: 'latest',
            registryVersion: '1.0.0/../../escape',
        }), /Registry returned invalid version/);
        strictEqual(stats.archiveCount, 0);
        ok(!existsSync(join(root, 'cache', 'escape')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts npm URL tarball: unsafe package version cannot select the store directory', () => {
    const root = makePosixTempDir('npm-url-version-containment');
    try {
        const result = install(root, {}, { archiveCount: 0 }, {
            requestedVersion: TARBALL_URL,
            tarVersion: '1.0.0/../../escape',
        });
        const npmRoot = join(root, 'cache', 'npm');
        ok(result.entry.startsWith(npmRoot + '/'));
        ok(result.entry.includes(`${PACKAGE_NAME}@0.0.0+u`));
        ok(!existsSync(join(root, 'cache', 'escape')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
