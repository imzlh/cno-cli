import { strictEqual, throws } from 'node:assert';
import { order, satisfies } from '../../cno/src/bun/semver/index.ts';

// Expected results were checked against Bun 1.4.4's Bun.semver.
Deno.test('bun: semver orders versions and prerelease identifiers', () => {
    const cases: [string, string, number][] = [
        ['1.2.3', '1.2.4', -1],
        ['1.2.3-alpha.2', '1.2.3-alpha.11', -1],
        ['1.2.3-01', '1.2.3-1', 0],
        ['1.2.3-1', '1.2.3-alpha', -1],
        ['1.2.3-alpha', '1.2.3', -1],
        ['v01.002.003+one', '1.2.3+two', 0],
        ['1.2', '1.2.99', 1],
        ['*', '1.2.3', 1],
    ];
    for (const [left, right, expected] of cases) {
        strictEqual(order(left, right), expected, `${left} vs ${right}`);
        strictEqual(order(right, left), -expected || 0, `${right} vs ${left}`);
    }
    throws(() => order('invalid', '1.0.0'));
});

Deno.test('bun: semver range alternatives distinguish wildcards from empty branches', () => {
    const cases: [string, string, boolean][] = [
        ['2.0.0', '1.2.3 || *', true],
        ['2.0.0', '* || 1.2.3', true],
        ['2.0.0', '1.2.3 ||', false],
        ['2.0.0', '|| 1.2.3', false],
        ['2.0.0', '', true],
        ['1.2.3-a', '1.2.3 || *', false],
        ['1.2.3-a', '1.2.3-a || *', true],
        ['1.2.3-01', '1.2.3-1', false],
        ['1.2.3-01', '1.2.3-1 || *', true],
        ['1.2.3-01', '>=1.2.3-1', true],
        ['1.2.9', '1.2 - 1.3', true],
        ['1.4.0', '1.2 - 1.3', false],
        ['1.2.3-a', '^1.2.3-a', true],
        ['1.3.0-a', '^1.2.3-a', false],
        ['1.3.0', '>1.2', true],
        ['1.2.9', '>1.2', false],
        ['invalid', '*', false],
    ];
    for (const [version, range, expected] of cases) {
        strictEqual(satisfies(version, range), expected, `${version} satisfies ${range}`);
    }
});
