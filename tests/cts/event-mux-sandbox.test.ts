import { deepStrictEqual, strictEqual } from 'node:assert';
import { Transformer } from '../../cts/src/source/transform.ts';

const muxUrl = new URL('../../cts/src/runtime/event-mux.ts', import.meta.url).href;
const processUrl = new URL('../../cno/src/node/process/mod.ts', import.meta.url).href;
const source = await Deno.readTextFile(new URL(muxUrl));
const sandboxSource = new Transformer({ sourceMaps: false })
    .transform(source, 'event-mux.ts')
    .replaceAll('import.meta.use', 'globalThis.__use');

const sandboxSetup = `
    const engine = import.meta.use('engine');
    const evbus = import.meta.use('evbus');
    if (!evbus) throw new Error('this fixture requires native evbus');
    const source = ${JSON.stringify(sandboxSource)};
    function makeSandbox() {
        const sandbox = new engine.Sandbox();
        sandbox.global.__engine = engine;
        sandbox.global.__evbus = evbus;
        sandbox.global.log = console.log;
        sandbox.call('globalThis.__use = (name) => name === "engine" ? __engine : __evbus;');
        sandbox.global.mux = sandbox.loadModule(source, '<event-mux-sandbox>');
        return sandbox;
    }
`;

async function runFixture(body: string): Promise<string[]> {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['--no-http', '--no-jsr', 'eval', '--ext=js', sandboxSetup + body],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();
    const timer = setTimeout(() => child.kill(), 10000);
    try {
        const result = await child.output();
        const stdout = new TextDecoder().decode(result.stdout);
        const stderr = new TextDecoder().decode(result.stderr);
        strictEqual(result.code, 0, stdout + stderr);
        return stdout.split(/\r?\n/).filter((line) => line.startsWith('MUX:'));
    } finally {
        clearTimeout(timer);
    }
}

Deno.test({ name: 'event mux: native evbus coordinates independent sandbox subscriptions once', timeout: 15000 }, async () => {
    const lines = await runFixture(`
        const first = makeSandbox();
        const second = makeSandbox();
        first.call(\`mux.installEventReceiver('first', (name, data, ctx) => {
            if (name === 2 || name === 987) { log('MUX:first'); ctx.handled = true; return true; }
        }, 100)\`);
        second.call(\`mux.installEventReceiver('second', (name, data, ctx) => {
            if (name === 2 || name === 987) { log('MUX:second:' + ctx.handled); return true; }
        }, 50)\`);
        const main = await import(${JSON.stringify(muxUrl)});
        main.installEventReceiver('main', (name, data, ctx) => {
            if (name === 2 || name === 987) { console.log('MUX:main:' + ctx.handled); return false; }
        }, 0);
        console.log('MUX:result:' + main.getEventMux().dispatch(987, null));
        Deno.exit(0);
    `);
    deepStrictEqual(lines, [
        'MUX:first', 'MUX:second:true', 'MUX:main:true', 'MUX:result:false',
        'MUX:first', 'MUX:second:true', 'MUX:main:true',
    ]);
});

Deno.test({ name: 'event mux: unsubscribing a sandbox leaves the main subscription active', timeout: 15000 }, async () => {
    const lines = await runFixture(`
        const sandbox = makeSandbox();
        sandbox.call(\`globalThis.off = mux.installEventReceiver('sandbox', (name) => {
            if (name === 997) log('MUX:sandbox');
        }, 50)\`);
        const main = await import(${JSON.stringify(muxUrl)});
        main.installEventReceiver('main', (name) => {
            if (name === 997) console.log('MUX:main');
        }, 0);
        main.getEventMux().dispatch(997, null);
        sandbox.call('off(); off();');
        console.log('MUX:next');
        main.getEventMux().dispatch(997, null);
    `);
    deepStrictEqual(lines, ['MUX:sandbox', 'MUX:main', 'MUX:next', 'MUX:main']);
});

Deno.test({ name: 'event mux: sandbox collection preserves the active snapshot only', timeout: 15000 }, async () => {
    const lines = await runFixture(`
        let sandbox = makeSandbox();
        sandbox.call(\`mux.installEventReceiver('sandbox', (name) => {
            if (name === 998) log('MUX:sandbox');
        }, 0)\`);
        const main = await import(${JSON.stringify(muxUrl)});
        main.installEventReceiver('drop-sandbox', (name) => {
            if (name === 998) {
                console.log('MUX:main');
                sandbox = null;
                engine.gc.run();
            }
        }, 100);
        main.getEventMux().dispatch(998, null);
        console.log('MUX:next');
        main.getEventMux().dispatch(998, null);
    `);
    deepStrictEqual(lines, ['MUX:main', 'MUX:sandbox', 'MUX:next', 'MUX:main']);
});

Deno.test({ name: 'event mux: standalone CNO routes process rejections without CTS', timeout: 15000 }, async () => {
    const lines = await runFixture(`
        const proc = await import(${JSON.stringify(processUrl)});
        let calls = 0;
        proc.on('unhandledRejection', (reason, promise) => {
            calls++;
            console.log('MUX:rejection:' + reason + ':' + promise);
        });
        console.log('MUX:return:' + evbus.dispatchRuntimeEvent(engine.EventType.UNHANDLED_REJECTION, ['promise', 'reason']));
        console.log('MUX:calls:' + calls);
        // A second dispatch delivers again: rejectionEmitted is per dispatch,
        // and CNO's direct bridge is the only delivery path (no CTS bridge).
        console.log('MUX:return:' + evbus.dispatchRuntimeEvent(engine.EventType.UNHANDLED_REJECTION, ['promise', 'reason']));
        console.log('MUX:calls:' + calls);
    `);
    deepStrictEqual(lines, [
        'MUX:rejection:reason:promise', 'MUX:return:false', 'MUX:calls:1',
        'MUX:rejection:reason:promise', 'MUX:return:false', 'MUX:calls:2',
    ]);
});
