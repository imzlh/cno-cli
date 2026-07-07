import { strictEqual, ok } from 'node:assert';
import * as repl from 'node:repl';
import { PassThrough } from 'node:stream';

function createRepl(prompt = '> ') {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => {
        text += chunk.toString();
    });
    const server = repl.start({ input, output, terminal: false, prompt });
    return {
        input,
        server,
        readOutput: () => text,
    };
}

Deno.test('repl: start returns REPLServer with configured prompt', () => {
    const { server } = createRepl('p> ');
    try {
        ok(typeof server === 'object');
        strictEqual(server.getPrompt(), 'p> ');
    } finally {
        server.close();
    }
});

Deno.test('repl: displayPrompt writes prompt to supplied output', async () => {
    const { server, readOutput } = createRepl('p> ');
    try {
        server.displayPrompt();
        await new Promise((resolve) => setTimeout(resolve, 20));
        strictEqual(readOutput(), 'p> p> ');
    } finally {
        server.close();
    }
});

Deno.test('repl: input expression is evaluated and printed', async () => {
    const { server, input, readOutput } = createRepl('p> ');
    try {
        input.write('1 + 2\n');
        await new Promise((resolve) => setTimeout(resolve, 50));
        strictEqual(readOutput(), 'p> 3\np> ');
    } finally {
        server.close();
    }
});

Deno.test('repl: defineCommand action can write to output and redisplay prompt', async () => {
    const { server, input, readOutput } = createRepl('p> ');
    try {
        server.defineCommand('test', {
            help: 'test cmd',
            action() {
                this.output.write('hello\n');
                this.displayPrompt();
            },
        });
        input.write('.test\n');
        await new Promise((resolve) => setTimeout(resolve, 50));
        strictEqual(readOutput(), 'p> hello\np> ');
    } finally {
        server.close();
    }
});

Deno.test('repl: defineCommand stores command metadata', () => {
    const { server } = createRepl('p> ');
    try {
        server.defineCommand('test', {
            help: 'help text',
            action() {},
        });
        const commands = Reflect.get(server, 'commands') as Record<string, { action: unknown; help: unknown }>;
        strictEqual(typeof commands.test.action, 'function');
        strictEqual(commands.test.help, 'help text');
    } finally {
        server.close();
    }
});

Deno.test('repl: .help output includes custom command help', async () => {
    const { server, input, readOutput } = createRepl('p> ');
    try {
        server.defineCommand('test', {
            help: 'help text',
            action() {},
        });
        input.write('.help\n');
        await new Promise((resolve) => setTimeout(resolve, 80));
        ok(readOutput().includes('.test    help text'));
    } finally {
        server.close();
    }
});

Deno.test('repl: evaluating property access prints result and re-prompts', async () => {
    const { server, input, readOutput } = createRepl('p> ');
    try {
        input.write('({ a: 1 }).a\n');
        await new Promise((resolve) => setTimeout(resolve, 80));
        strictEqual(readOutput(), 'p> 1\np> ');
    } finally {
        server.close();
    }
});

Deno.test('repl: REPL_MODE_SLOPPY and REPL_MODE_STRICT are symbols', () => {
    ok(typeof repl.REPL_MODE_SLOPPY === 'symbol');
    ok(typeof repl.REPL_MODE_STRICT === 'symbol');
    ok(repl.REPL_MODE_SLOPPY !== repl.REPL_MODE_STRICT);
});

Deno.test('repl: builtinModules is array', () => {
    ok(Array.isArray(repl.builtinModules));
});

Deno.test('repl: recoveredFromError is undefined in node module surface', () => {
    strictEqual((repl as typeof repl & { recoveredFromError?: unknown }).recoveredFromError, undefined);
});
