import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { outputOf, prepareCache, prepareLocalSetupSource, runCno } from '../_helpers/bun-cli.ts';

Deno.test('bun: feature lowering preserves bindings and CJS effects across cached compilation', async () => {
    await withTempDir('bundle-feature', async (root) => {
        prepareLocalSetupSource(root);
        const cache = join(root, 'cache');
        prepareCache(cache);
        const sources = {
            'package.json': JSON.stringify({ type: 'module' }),
            'entry.ts': `
                import { feature } from 'bun:bundle';
                import { selected, local } from './choice.js';
                import { escaped } from './escaped.js';
                import { escapedUnicode } from './escaped-unicode.js';
                import { escapedCodepoint } from './escaped-codepoint.js';
                import { escapedContinuation } from './escaped-continuation.js';
                import { readLive, updateLive, observed } from './graph.ts';
                import value from './worker.cts';
                type FeatureFn = typeof feature;
                const typed: ReturnType<FeatureFn> = feature('DISABLED') ? true : false;
                if (typed) throw new Error('typed disabled branch ran');
                const live = [readLive()];
                updateLive();
                live.push(readLive());
                console.log(JSON.stringify({ selected, local, escaped, escapedUnicode, escapedCodepoint, escapedContinuation, value, live, observed }));
            `,
            'choice.js': `
                import { feature as enabled } from 'bun:bundle';
                export const selected = enabled('DISABLED') ? 'wrong' : 'default';
                export const local = ((enabled) => enabled('LOCAL'))((name) => name);
                if (enabled('DISABLED')) throw new Error('disabled branch ran');
            `,
            'side.cjs': 'globalThis.bundleFeatureSide = 42;',
            'state.js': `
                globalThis.bundleFeatureEffects = ['state'];
                export let live = 5;
                export function update() { live++; }
            `,
            'effects.ts': `
                globalThis.bundleFeatureEffects.push('effects');
                export const unused = 1;
            `,
            'graph.ts': `
                import { feature } from 'bun:bundle';
                import { missing, live, update } from './state.js';
                import { unused } from './effects.ts';
                import { type Absent } from './type-only-missing.ts';
                if (feature('DISABLED')) {
                    await import('./dead-missing.ts');
                }
                if ((globalThis.bundleFeatureEffects.push('left'), true) && feature('DISABLED')) {
                    missing();
                }
                function observe(value: unknown) {
                    globalThis.bundleFeatureEffects.push('decorator');
                }
                @observe
                class Decorated {}
                export function readLive(): number {
                    return feature('DISABLED') ? missing() : live;
                }
                export function updateLive() { update(); }
                export const observed = globalThis.bundleFeatureEffects;
            `,
            'escaped.js': String.raw`/* 'b unmatched candidate */ import { feature } from 'bun\x3abundle'; export const escaped = feature('OFF') ? 0 : 7;`,
            'escaped-unicode.js': String.raw`import { feature } from 'bun\u003abundle'; export const escapedUnicode = feature('OFF') ? 0 : 8;`,
            'escaped-codepoint.js': String.raw`import { feature } from 'bun\u{3a}bundle'; export const escapedCodepoint = feature('OFF') ? 0 : 10;`,
            'escaped-continuation.js': [
                "import { feature } from 'bun:\\",
                "bundle'; export const escapedContinuation = feature('OFF') ? 0 : 9;",
            ].join('\n'),
            'worker.cts': `
                import { feature } from 'bun:bundle';
                import side = require('./side.cjs');
                if (feature('DISABLED')) require('./dead-missing.cjs');
                module.exports = feature('DISABLED') ? 0 : globalThis.bundleFeatureSide;
            `,
            'invalid.js': `import { feature } from 'bun:bundle'; console.log(feature('DISABLED'));`,
            'ordinary.ts': `import { missing } from './state.js'; if (false) missing();`,
        };
        for (const [name, source] of Object.entries(sources)) {
            Deno.writeTextFileSync(join(root, name), source);
        }
        const flags = [`--cache-dir=${cache}`, `--lock-dir=${root}`, '--cached-only', '--no-http', '--no-jsr'];
        const entry = join(root, 'entry.ts');
        const cached = await runCno(['cache', ...flags, entry], root, cache);
        strictEqual(cached.code, 0, outputOf(cached));
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await runCno(['run', ...flags, entry], root, cache);
            strictEqual(result.code, 0, outputOf(result));
            strictEqual(result.stdout.trim(), '{"selected":"default","local":"LOCAL","escaped":7,"escapedUnicode":8,"escapedCodepoint":10,"escapedContinuation":9,"value":42,"live":[5,6],"observed":["state","effects","left","decorator"]}');
        }
        const invalid = await runCno(['run', ...flags, join(root, 'invalid.js')], root, cache);
        ok(invalid.code !== 0, outputOf(invalid));
        ok(outputOf(invalid).includes('bun:bundle: feature()'), outputOf(invalid));
        const ordinary = await runCno(['run', ...flags, join(root, 'ordinary.ts')], root, cache);
        ok(ordinary.code !== 0, outputOf(ordinary));
        ok(outputOf(ordinary).includes("Could not find export 'missing'"), outputOf(ordinary));
        const fallback = await runCno(['run', ...flags, '--disable-cache', '--no-oxc', entry], root, cache);
        ok(fallback.code !== 0, outputOf(fallback));
        ok(outputOf(fallback).includes('bun:bundle requires native OXC transformation'), outputOf(fallback));
    });
});
