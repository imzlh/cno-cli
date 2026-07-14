/**
 * Structural policy: npm install FLOW keys must never wrap dependency walks.
 * Re-entering the same key while waiting on itself is a permanent hang.
 */
import { ok } from 'node:assert';
import { readFileSync } from 'node:fs';

Deno.test('npm install policy: FLOW keys are body-only; prepare detects cycles', () => {
    const src = readFileSync(new URL('../../cts/src/resolve/protocols/npm.ts', import.meta.url), 'utf8');

    ok(src.includes('cyclePath'), 'call-stack cycle path required (not process-global)');
    ok(src.includes('prepare cycle'), 'cycle edges must log and return partial');
    ok(src.includes('EMPTY_CYCLE'), 'top-level ensure uses empty cycle path');
    ok(src.includes('metaMem'), 'registry meta must be process-local cached');
    ok(src.includes('npm-meta:'), 'concurrent meta fetches must coalesce');
    ok(!src.includes('preparingPackages'), 'global preparing set mis-classifies concurrent waiters');
    // Prepare must NOT use FLOW coalesce — mutual deps under FLOW_ALL cross-deadlock.
    ok(!src.includes('npm-prepare:'), 'prepare must not use a FLOW key');

    // installOnce: FLOW key only runs installPackageBody, then prepare outside.
    const onceIdx = src.indexOf('private *installOnce');
    ok(onceIdx > 0, 'installOnce must exist');
    const onceSlice = src.slice(onceIdx, onceIdx + 600);
    ok(onceSlice.includes("key: `npm-install:${name}@${ver}`"), 'installOnce uses npm-install key');
    ok(onceSlice.includes('this.installPackageBody'), 'installOnce FLOW body is extract-only');
    ok(onceSlice.includes('yield* this.prepareInstalledPackage'), 'prepare runs after FLOW settles');
    ok(onceSlice.includes('cyclePath'), 'installOnce forwards cyclePath into prepare');

    // installPackageBody must not walk deps (that was the hang).
    const bodyIdx = src.indexOf('private *installPackageBody');
    ok(bodyIdx > 0, 'installPackageBody must exist');
    const nextMethod = src.indexOf('\n    private *', bodyIdx + 10);
    const body = src.slice(bodyIdx, nextMethod > 0 ? nextMethod : bodyIdx + 2000);
    ok(!body.includes('installDependencies'), 'body must not walk dependencies');
    ok(!body.includes('installPeerDeps'), 'body must not walk peers');
    ok(!body.includes('installOptionalDeps'), 'body must not walk optionals');
    ok(!body.includes('prepareInstalledPackage'), 'body must not prepare (would re-enter)');

    // ensureInstallGraph body uses the same install key (not a second dual-name hang).
    ok(src.includes("key: `npm-install:${name}@${exactVer}`"), 'install-graph body shares npm-install key');

    // prepare: cyclePath short-circuit, inline body (no FLOW).
    const prepIdx = src.indexOf('private *prepareInstalledPackage(');
    ok(prepIdx > 0);
    const prepEnd = src.indexOf('\n    private *', prepIdx + 10);
    const prep = src.slice(prepIdx, prepEnd > 0 ? prepEnd : prepIdx + 1200);
    ok(prep.includes('cyclePath.has(key)'), 'cycle check on prepare entry');
    ok(prep.includes('installDependencies'), 'prepare walks deps inline');
    ok(!prep.includes('type: StepType.FLOW'), 'prepare must not yield FLOW');

    // tarball URL path: extract under key, prepare outside.
    const tarOnce = src.indexOf('private *installFromTarballUrlOnce');
    ok(tarOnce > 0);
    const tarEnd = src.indexOf('private *extractFromTarballUrl', tarOnce);
    const tarSlice = src.slice(tarOnce, tarEnd > 0 ? tarEnd + 200 : tarOnce + 900);
    ok(tarSlice.includes('extractFromTarballUrl'), 'tarball FLOW is extract-only');
    ok(tarSlice.includes('prepareInstalledPackage'), 'tarball prepare is outside FLOW');
    const extractStart = src.indexOf('private *extractFromTarballUrl');
    ok(extractStart > 0);
    const extractEnd = src.indexOf('\n    private *', extractStart + 10);
    const extractBody = src.slice(extractStart, extractEnd > 0 ? extractEnd : extractStart + 1500);
    ok(!extractBody.includes('installDependencies'), 'tarball extract must not walk deps');
    ok(!extractBody.includes('prepareInstalledPackage'), 'tarball extract must not prepare');
});
