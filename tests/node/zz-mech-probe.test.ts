// Scratch: what does engine.eval(EVAL_ASYNC) actually leave in the slot?
const engine = import.meta.use('engine');

Deno.test('probe: engine EVAL_ASYNC slot contents', async () => {
    const slot = '__probeSlot1';
    const ret = await engine.eval(
        `globalThis[${JSON.stringify(slot)}] = (new Promise(r=>setTimeout(()=>r(99),200)))`,
        '<probe>',
        engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE,
    );
    const v = Reflect.get(globalThis, slot);
    console.log('EVAL_RETURN', typeof ret, JSON.stringify(ret));
    console.log('SLOT_TYPE', typeof v, 'isPromise', v instanceof Promise, 'ctor', v && v.constructor && v.constructor.name);
    console.log('SLOT_VALUE', JSON.stringify(v));

    // Without EVAL_ASYNC:
    const slot2 = '__probeSlot2';
    const ret2 = engine.eval(
        `globalThis[${JSON.stringify(slot2)}] = (new Promise(r=>setTimeout(()=>r(7),50)))`,
        '<probe>',
        engine.EVAL_NEW_BACKTRACE,
    );
    const v2 = Reflect.get(globalThis, slot2);
    console.log('NOASYNC_SLOT_TYPE', typeof v2, 'isPromise', v2 instanceof Promise, 'ctor', v2 && v2.constructor && v2.constructor.name);
    console.log('NOASYNC_EVAL_RETURN', typeof ret2, JSON.stringify(ret2));
});
