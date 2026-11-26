import { strictEqual, ok } from 'node:assert';
import { ParseDriver } from '../../cts/src/parse.ts';
import { OxcTranspiler } from '../../cts/src/oxc.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';
import { withTempDir } from '../_helpers/temp.ts';

const smap = import.meta.use('sourcemap');

Deno.test('cts CJS precompile registers OXC maps under the compile identity', async () => {
    await withTempDir('cts-cjs-sourcemap-identity', async (root) => {
        const localPath = joinPaths(root, 'subject.js');
        const sourceIdentity = 'file:///workspace/subject.js';
        const identity = 'pack:app/subject.js';
        await Deno.writeTextFile(localPath, '@decorate class Subject {}\n');

        let receivedFilename: string | undefined;
        const oxc = new OxcTranspiler({
            version: 'test',
            transpile(_source, options) {
                receivedFilename = options?.filename;
                return {
                    code: 'module.exports = 42;',
                    deps: [],
                    sourceMap: JSON.stringify({
                        version: 3,
                        sources: ['subject.ts'],
                        names: [],
                        mappings: 'AAAA',
                    }),
                };
            },
            scanImports() { return []; },
        });

        const driver = new ParseDriver(oxc, 0);
        try {
            let runtimeMapped = false;
            await driver.precompile([{
                specPath: sourceIdentity,
                localPath,
                format: 'cjs',
                identity,
            }], undefined, (_path, _bytecode, compiledSpecPath, mapped) => {
                strictEqual(compiledSpecPath, sourceIdentity);
                runtimeMapped = mapped === true;
            });

            strictEqual(receivedFilename, identity);
            ok(runtimeMapped);
            ok(smap.has(identity), 'the runtime map must use the bytecode identity');
            strictEqual(smap.has(localPath), false, 'the local path must not retain the pack map');
        } finally {
            smap.remove(identity);
            smap.remove(localPath);
            await driver.terminate();
        }
    });
});
