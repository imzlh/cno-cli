import { test } from 'node:test';
import assert from 'node:assert/strict';
import { order, satisfies } from '../../cno/src/bun/semver/index.ts';

test('semver ordering handles prerelease, build, and partial versions', () => {
    const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 1; i < versions.length; i++) {
        assert.equal(order(versions[i - 1], versions[i]), -1);
        assert.equal(order(versions[i], versions[i - 1]), 1);
    }
    assert.equal(order('v01.002.003+first', '1.2.3+second'), 0);
    assert.equal(order('1.2', '1.2.99'), 1);
    assert.equal(order('*', '999.999.999'), 1);
    assert.equal(order('1.2.3-01', '1.2.3-1'), 0);
    assert.throws(() => order('not a version', '1.0.0'));
    assert.equal(order({ toString: () => '1.0.0' }, '1.0.0'), 0);
});

test('semver ranges handle common npm range forms and prereleases', () => {
    const cases = [
        ['1.2.3', '^1.2.0', true], ['2.0.0', '^1.2.0', false],
        ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false],
        ['0.0.4', '^0.0.3', false], ['0.0.9', '^0.0', true],
        ['1.2.9', '~1.2', true], ['1.3.0', '~1.2', false],
        ['1.2.9', '1.2.x', true], ['1.3.0', '1.2.*', false],
        ['1.3.0', '>1.2', true], ['1.2.9', '>1.2', false],
        ['1.2.9', '<=1.2', true], ['1.3.0', '<=1.2', false],
        ['1.4.9', '1.2 - 1.4', true], ['1.5.0', '1.2 - 1.4', false],
        ['2.0.0', '>=1 <2 || >=2.0.0', true],
        ['1.2.3-alpha', '*', false], ['1.2.3-alpha.2', '>=1.2.3-alpha <2', true],
        ['1.3.0-alpha', '>=1.2.3-alpha <2', false],
        ['1.2.3-01', '1.2.3-1', false], ['1.2.3-01', '>=1.2.3-1', true],
        ['01.2.3+build', '1.2.3', true], ['invalid', '*', false],
        ['1.0.0', 'not a range', false], ['1.0.0', '', true],
    ];
    for (const [version, range, expected] of cases) {
        assert.equal(satisfies(version, range), expected, `${version} satisfies ${range}`);
    }
});
