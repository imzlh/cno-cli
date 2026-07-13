import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { hasImportAttributes, extractImports } from '../../cts/src/scan.ts';
import { ImportScanner } from '../../cts/src/import-scanner.ts';
import { tryLoadOxc } from '../../cts/src/oxc.ts';

Deno.test('hasImportAttributes: cheap scan finds with/assert without full TS parse', () => {
    ok(hasImportAttributes(`import data from './x.json' with { type: 'json' };\n`));
    ok(hasImportAttributes(`export { x } from './y' assert { type: 'json' };\n`));
    ok(!hasImportAttributes(`import { with as w } from './z';\nconst assert = 1;\n`));
    // Large type-only file must stay sub-second (old Sucrase isTs path was multi-second).
    const heavy = 'export type T = ' + Array.from({ length: 200 }, (_, i) =>
        `{ a${i}: string | number | boolean | null }`).join(' | ') + ';\n';
    const t0 = Date.now();
    strictEqual(hasImportAttributes(heavy), false);
    ok(Date.now() - t0 < 200, `hasImportAttributes too slow: ${Date.now() - t0}ms`);
    // Ship linear detectors only — full Sucrase parse stays in extractImports fallback.
    const scanSrc = readFileSync(new URL('../../cts/src/scan.ts', import.meta.url), 'utf8');
    const attrBody = scanSrc.match(/export function hasImportAttributes[\s\S]*?\nexport function /)?.[0] ?? '';
    const esmBody = scanSrc.match(/export function hasTopLevelEsmSyntax[\s\S]*?\n(?:export function |type Tokens)/)?.[0] ?? '';
    ok(attrBody.length > 100 && !attrBody.includes('parse(source'), 'hasImportAttributes must not full-parse');
    ok(esmBody.length > 100 && !esmBody.includes('parse(source'), 'hasTopLevelEsmSyntax must not full-parse');
});

Deno.test('ImportScanner: oxc-first main-thread scan matches extractImports edges', () => {
    const oxc = tryLoadOxc();
    ok(oxc, 'oxc extension required for this gate');
    const root = makePosixTempDir('import-scanner');
    try {
        mkdirSync(root, { recursive: true });
        const file = join(root, 'mod.ts');
        const source = [
            `import type { X } from './types';`,
            `import { a } from './a.js';`,
            `export { b } from './b.js';`,
            `const r = require('./c.js');`,
        ].join('\n');
        writeFileSync(file, source);
        const scanner = new ImportScanner(oxc);
        const t0 = Date.now();
        const deps = scanner.scanFile(file).sort();
        ok(Date.now() - t0 < 500, `scanFile slow: ${Date.now() - t0}ms`);
        // type-only import may be omitted by oxc; value edges must remain.
        ok(deps.includes('./a.js'));
        ok(deps.includes('./b.js'));
        // require may or may not appear depending on oxc scan; sucrase path keeps it.
        const sucrase = extractImports(source, true).sort();
        for (const d of deps) ok(sucrase.includes(d) || d.endsWith('.js'), `unexpected dep ${d}`);
        deepStrictEqual(
            deps.filter(d => d === './a.js' || d === './b.js'),
            ['./a.js', './b.js'],
        );
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});
