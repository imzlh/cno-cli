// Accessing the module directly makes a missing/incompatible extension fail,
// even if the CLI can still transpile TypeScript with its Sucrase fallback.
const oxc = import.meta.use('oxc');
if (!oxc || typeof oxc.transpile !== 'function' || typeof oxc.version !== 'string') {
    throw new Error('The staged OXC native extension did not load');
}
const result = oxc.transpile('const answer: number = 6 * 7;', {
    kind: 'ts', filename: 'native-oxc-smoke.ts',
});
if (!result || typeof result.code !== 'string'
    || new Function(`${result.code}\nreturn answer;`)() !== 42) {
    throw new Error('Native OXC TypeScript transformation failed');
}
const imports = oxc.scanImports('import { answer } from "./answer.ts"; console.log(answer);', { kind: 'ts' });
if (!Array.isArray(imports) || !imports.includes('./answer.ts')) {
    throw new Error('Native OXC import scanning failed');
}
console.log('CNO_CI_OXC_OK');
