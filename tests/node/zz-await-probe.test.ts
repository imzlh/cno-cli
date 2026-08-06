// Scratch probe: confirm awaitPromise:false is ignored, via disk-loaded import.
import { Evaluator } from '../../src/inspector/main/evaluator';
import { Serializer } from '../../src/inspector/main/remote-object';
import type { RpcParams } from '../../src/inspector/shared/rpc-contract';

Deno.test('probe: awaitPromise false', async () => {
    const evaluator = new Evaluator(new Serializer());
    const r = await evaluator.evaluate({
        expression: 'new Promise(r=>setTimeout(()=>r(99),200))',
        awaitPromise: false,
    } as RpcParams['evaluate']);
    console.log('AWAIT_FALSE', JSON.stringify(r));
    const r2 = await evaluator.evaluate({
        expression: 'new Promise(r=>setTimeout(()=>r(99),200))',
        awaitPromise: true,
    } as RpcParams['evaluate']);
    console.log('AWAIT_TRUE', JSON.stringify(r2));
    const c = evaluator.compileScript({ expression: 'Promise.resolve(5)', sourceURL: 't.js', persistScript: true } as RpcParams['compileScript']);
    const rs = await evaluator.runScript({ scriptId: c.scriptId!, awaitPromise: true, returnByValue: true } as RpcParams['runScript']);
    console.log('RUNSCRIPT_AWAIT_TRUE', JSON.stringify(rs));
});
