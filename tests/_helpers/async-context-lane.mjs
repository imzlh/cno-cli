import { AssertionError } from 'node:assert';
import process from 'node:process';

const [file, selected] = process.argv.slice(2);
const definitions = [];
const register = (definition, fn) => {
    if (typeof definition === 'string') return;
    if (!definition.ignore) return;
    if (!definition.name.startsWith('[known gap: async-context] ')) {
        throw new Error(`Unclassified ignored test: ${definition.name}`);
    }
    definitions.push({ ...definition, fn: fn ?? definition.fn });
};

// The same test bodies run under Node and cno; unrelated Deno.test bodies never run here.
if (typeof globalThis.Deno === 'undefined') globalThis.Deno = { test: register };
else Deno.test = register;
await import(file);

let result;
if (selected === '--list') {
    result = definitions.map(definition => definition.name);
} else {
    const matches = definitions.filter(definition => definition.name === selected);
    if (matches.length !== 1) throw new Error(`Expected one contract, found ${matches.length}: ${selected}`);
    try {
        await matches[0].fn();
        result = { outcome: 'pass' };
    } catch (error) {
        if (!(error instanceof AssertionError) || error.code !== 'ERR_ASSERTION' ||
            !error.message.startsWith('async-context:')) throw error;
        result = { outcome: 'gap', message: error.message, stack: error.stack };
    }
}
console.log(`CNO_ASYNC_CONTEXT_RESULT ${JSON.stringify(result)}`);
