/**
 * Version-selection policy for UNCONSTRAINED npm ranges ('' / 'latest' / '*').
 *
 * Regression pinned here: ensureInstalled() used to return from the warm-store
 * fast path (findCachedPackageMatching) BEFORE resolveVersion() — the only
 * reader of `dist-tags` — so an unversioned `npm:foo` resolved to
 * `latestVersion(<whatever sat in the store>)`. A planted `commander@99.0.0`,
 * published by no registry, won a top-level import while metadata saying
 * `dist-tags.latest = 15.0.0` sat readable on disk. Store contents are sticky,
 * so that was a supply-chain hazard, not just a wrong answer.
 *
 * The policy these tests pin (see resolveUnconstrainedVersion in
 * cts/src/resolve/protocols/npm.ts):
 *   tier 1  metadata fresh (<24h) or fetchable -> dist-tags.latest, and a
 *           refusal rather than a substitution when that version is absent.
 *   tier 2  metadata on disk at ANY age -> highest store version ATTESTED by
 *           it. Membership in meta.versions cannot go stale, so this rejects
 *           planted versions while still working offline.
 *   tier 3  no metadata at all -> store-highest, so offline still resolves.
 * Constrained ranges (^/~/exact) are unchanged and keep the fast path.
 *
 * Every test runs with cachedOnly so no registry is contacted; seeded tarball
 * URLs point at registry.invalid so an accidental fetch dies at DNS.
 */
import { ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { createRuntime } from '../../cts/src/api/index.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

/** Extracted store package: <cache>/npm/<name>@<version>/. */
function seedPkg(cacheDir: string, name: string, version: string): string {
    const dir = joinPaths(cacheDir, 'npm', `${name}@${version}`);
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, 'index.js'), `export const v = '${version}';\n`);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name,
        version,
        main: 'index.js',
        type: 'module',
    }));
    return dir;
}
/**
 * On-disk registry metadata at <cache>/npm/.meta/<name>/meta.json (+ `.ts`
 * marker). `ageHours` drives the 24h gate in fetchMetaBody: under 24 means
 * tier 1 reads it as authoritative; over means tier 1 must fetch (which
 * cachedOnly refuses) so only the any-age attestation reader sees it.
 */
function seedMeta(
    cacheDir: string,
    name: string,
    versions: string[],
    latest: string,
    ageHours: number,
): void {
    const dir = joinPaths(cacheDir, 'npm', '.meta', name);
    mkdirSync(join(dir), { recursive: true });
    const records: Record<string, unknown> = {};
    for (const v of versions) {
        records[v] = {
            version: v,
            // registry.invalid: an accidental fetch dies at DNS, never a real registry.
            dist: { tarball: `https://registry.invalid/${name}/-/${name}-${v}.tgz` },
        };
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ versions: records, 'dist-tags': { latest } }));
    writeFileSync(join(dir, 'meta.json.ts'), String(Date.now() - Math.round(ageHours * 3600 * 1000)));
}

function rtOpts(cacheDir: string, projectDir: string) {
    return {
        cacheDir,
        lockDir: projectDir,
        enableCache: true,
        enableNode: false,
        enableHttp: false,
        enableJsr: false,
        cachedOnly: true as const,
        silent: true,
        disableLock: true,
        ignoreScripts: true,
        nodeModulesMode: 'normal' as const,
    };
}
interface PrecacheLike {
    errors: unknown[];
    modules: { specPath: string }[];
}

/** Resolved version for `name` as it appears in a precache module list. */
function resolvedVersionOf(result: PrecacheLike, name: string): string | null {
    const prefix = `npm:${name}@`;
    for (const m of result.modules) {
        const i = m.specPath.indexOf(prefix);
        if (i < 0) continue;
        const rest = m.specPath.slice(i + prefix.length);
        const slash = rest.indexOf('/');
        return slash < 0 ? rest : rest.slice(0, slash);
    }
    return null;
}

/** Precache a single import spec; returns the result plus elapsed ms. */
async function precacheSpec(
    cacheDir: string,
    projectDir: string,
    specs: string[],
): Promise<{ result: PrecacheLike; elapsed: number; threw: string | null }> {
    mkdirSync(join(projectDir), { recursive: true });
    writeFileSync(
        join(projectDir, 'main.ts'),
        specs.map(s => `import '${s}';`).join('\n') + '\n',
    );
    const entry = joinPaths(projectDir, 'main.ts');
    const rt = createRuntime(rtOpts(cacheDir, projectDir), projectDir);
    const t0 = performance.now();
    let result: PrecacheLike = { errors: [], modules: [] };
    let threw: string | null = null;
    try {
        result = await rt.precache(entry, entry) as unknown as PrecacheLike;
    } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
    }
    const elapsed = performance.now() - t0;
    rt.cleanup();
    return { result, elapsed, threw };
}
/**
 * THE PLANTED-VERSION CASE (tier 2). `verplant@99.0.0` is in the store but in
 * no metadata; stale (100h) metadata knows 2.20.3. Under cachedOnly tier 1
 * cannot fetch, so the any-age attestation reader decides — and must reject
 * 99.0.0 even though it is semver-highest.
 */
Deno.test('npm version policy: unconstrained rejects a store version absent from metadata', async () => {
    const root = makePosixTempDir('npm-verpolicy-planted');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        seedPkg(cacheDir, 'verplant', '2.20.3');
        seedPkg(cacheDir, 'verplant', '99.0.0');
        // Metadata never published 99.0.0. Stale, so tier 1 must fall through.
        seedMeta(cacheDir, 'verplant', ['1.0.0', '2.20.3', '15.0.0'], '15.0.0', 100);

        const { result, threw } = await precacheSpec(cacheDir, projectDir, ['npm:verplant']);
        ok(threw === null, `unexpected throw: ${threw}`);
        const picked = resolvedVersionOf(result, 'verplant');
        ok(picked !== '99.0.0', 'planted version absent from metadata must not win an unconstrained range');
        strictEqual(picked, '2.20.3', `expected the attested store version; modules: ${result.modules.map(m => m.specPath).join(', ')}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * TIER 1: fresh metadata is authoritative, so dist-tags.latest wins over
 * store-highest. This is the direct proof that dist-tags is now consulted at
 * all for an unversioned import — the defect never read it.
 */
Deno.test('npm version policy: unconstrained honours dist-tags.latest over store-highest', async () => {
    const root = makePosixTempDir('npm-verpolicy-disttags');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        seedPkg(cacheDir, 'vertag', '1.0.0');
        seedPkg(cacheDir, 'vertag', '99.0.0');
        // latest is 1.0.0 even though 99.0.0 sits in the store. age 0 -> tier 1.
        seedMeta(cacheDir, 'vertag', ['1.0.0', '2.0.0'], '1.0.0', 0);

        const { result, threw } = await precacheSpec(cacheDir, projectDir, ['npm:vertag']);
        ok(threw === null, `unexpected throw: ${threw}`);
        strictEqual(resolvedVersionOf(result, 'vertag'), '1.0.0',
            'fresh dist-tags.latest must beat the semver-highest store entry');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
/**
 * TIER 3: no metadata anywhere. Offline usability is the reason this is not a
 * hard refusal — the store IS the cache. Also pins the measured ordering fact
 * that selection is semver-highest, not readdir-first (readdir/lexical order
 * here is 0.9.0, 1.0.0, 10.0.0).
 */
Deno.test('npm version policy: unconstrained falls back to store when no metadata exists', async () => {
    const root = makePosixTempDir('npm-verpolicy-nometa');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        seedPkg(cacheDir, 'vernometa', '0.9.0');
        seedPkg(cacheDir, 'vernometa', '1.0.0');
        seedPkg(cacheDir, 'vernometa', '10.0.0');

        const { result, threw } = await precacheSpec(cacheDir, projectDir, ['npm:vernometa']);
        ok(threw === null, `offline unconstrained import must still resolve; threw: ${threw}`);
        strictEqual(result.errors.length, 0, `errors: ${JSON.stringify(result.errors)}`);
        strictEqual(resolvedVersionOf(result, 'vernometa'), '10.0.0',
            'no metadata -> highest store version (semver-highest, not readdir-first)');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * TIER 1 refusal: fresh metadata names 15.0.0, which is not in the store, and
 * cachedOnly forbids fetching. The policy refuses rather than silently
 * substituting 1.0.0 — deno 2.9.3 --cached-only behaves the same way, and a
 * quiet downgrade is exactly the class of bug this replaced.
 */
Deno.test('npm version policy: unconstrained refuses rather than substituting under cached-only', async () => {
    const root = makePosixTempDir('npm-verpolicy-refuse');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        seedPkg(cacheDir, 'verrefuse', '1.0.0');
        seedMeta(cacheDir, 'verrefuse', ['1.0.0', '15.0.0'], '15.0.0', 0);

        const { result, threw } = await precacheSpec(cacheDir, projectDir, ['npm:verrefuse']);
        const picked = resolvedVersionOf(result, 'verrefuse');
        ok(picked !== '1.0.0',
            'must not silently substitute a different store version for the requested latest');
        const refused = threw !== null || result.errors.length > 0;
        ok(refused, `expected a refusal; threw=${threw} errors=${JSON.stringify(result.errors)} picked=${picked}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
/**
 * The warm-store fast path must survive for CONSTRAINED ranges. There is no
 * metadata for any of these names and cachedOnly forbids fetching, so if a
 * constrained range stopped being answered from the store every import here
 * would fail rather than merely slow down. Timing is reported and bounded so a
 * regression back toward the minutes-long resolve stall is visible.
 */
Deno.test('npm version policy: constrained ranges keep the warm-store fast path', async () => {
    const root = makePosixTempDir('npm-verpolicy-fastpath');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        for (let i = 0; i < 12; i++) {
            seedPkg(cacheDir, `verfast${i}`, '1.0.0');
            seedPkg(cacheDir, `verfast${i}`, '2.3.4');
        }
        const specs: string[] = [];
        for (let i = 0; i < 12; i++) {
            // Mix of caret, tilde and exact — all constrained, all store-answerable.
            if (i % 3 === 0) specs.push(`npm:verfast${i}@^1.0.0`);
            else if (i % 3 === 1) specs.push(`npm:verfast${i}@~2.3.0`);
            else specs.push(`npm:verfast${i}@2.3.4`);
        }

        const { result, elapsed, threw } = await precacheSpec(cacheDir, projectDir, specs);
        ok(threw === null, `constrained ranges must resolve from the store offline; threw: ${threw}`);
        strictEqual(result.errors.length, 0, `errors: ${JSON.stringify(result.errors)}`);
        for (let i = 0; i < 12; i++) {
            const want = i % 3 === 0 ? '1.0.0' : '2.3.4';
            strictEqual(resolvedVersionOf(result, `verfast${i}`), want, `verfast${i} range must pick ${want}`);
        }
        // No metadata may be created or required for a constrained store hit.
        for (let i = 0; i < 12; i++) {
            ok(!existsSync(join(cacheDir, 'npm', '.meta', `verfast${i}`, 'meta.json')),
                `constrained range must not need registry meta for verfast${i}`);
        }
        ok(elapsed < 5000, `12 constrained store-hit ranges took ${elapsed.toFixed(1)}ms (want <5000ms)`);
        console.log(`npm-verpolicy-timing: 12 constrained store-hit ranges ${elapsed.toFixed(1)}ms`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * The unconstrained policy must not slow the constrained path down by dragging
 * metadata reads into it: same store, same names, one unconstrained import
 * alongside constrained ones still resolves offline via tier 3.
 */
Deno.test('npm version policy: mixed constrained and unconstrained resolve together offline', async () => {
    const root = makePosixTempDir('npm-verpolicy-mixed');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        seedPkg(cacheDir, 'vermixa', '1.0.0');
        seedPkg(cacheDir, 'vermixa', '2.0.0');
        seedPkg(cacheDir, 'vermixb', '3.0.0');

        const { result, elapsed, threw } = await precacheSpec(cacheDir, projectDir, [
            'npm:vermixa@^1.0.0',
            'npm:vermixb',
        ]);
        ok(threw === null, `unexpected throw: ${threw}`);
        strictEqual(result.errors.length, 0, `errors: ${JSON.stringify(result.errors)}`);
        strictEqual(resolvedVersionOf(result, 'vermixa'), '1.0.0', 'constrained range unaffected');
        strictEqual(resolvedVersionOf(result, 'vermixb'), '3.0.0', 'unconstrained resolves via store fallback');
        console.log(`npm-verpolicy-timing: mixed constrained+unconstrained ${elapsed.toFixed(1)}ms`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
