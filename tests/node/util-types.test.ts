import { strictEqual } from 'node:assert';
import { types as utilTypes } from 'node:util';
import * as types from 'node:util/types';

Deno.test('util.types: exported namespace and node:util/types share functions', () => {
    strictEqual(utilTypes.isTypedArray, types.isTypedArray);
    strictEqual(utilTypes.isMapIterator, types.isMapIterator);
});

Deno.test('util.types: ArrayBuffer and view predicates distinguish DataView', () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint16Array(buffer);
    const dataView = new DataView(buffer);

    strictEqual(types.isArrayBuffer(buffer), true);
    strictEqual(types.isAnyArrayBuffer(buffer), true);
    strictEqual(types.isArrayBufferView(view), true);
    strictEqual(types.isArrayBufferView(dataView), true);
    strictEqual(types.isTypedArray(view), true);
    strictEqual(types.isTypedArray(dataView), false);
    strictEqual(types.isUint16Array(view), true);
    strictEqual(types.isUint8Array(view), false);
});

Deno.test('util.types: boxed primitive predicates only match boxed values', () => {
    strictEqual(types.isBooleanObject(new Boolean(false)), true);
    strictEqual(types.isNumberObject(new Number(1)), true);
    strictEqual(types.isStringObject(new String('x')), true);
    strictEqual(types.isSymbolObject(Object(Symbol('s'))), true);
    strictEqual(types.isBoxedPrimitive(Object(1n)), true);
    strictEqual(types.isBoxedPrimitive(1), false);
    strictEqual(types.isBoxedPrimitive({ valueOf: () => 1n }), false);
});

Deno.test('util.types: collection and iterator predicates reject plain iterators', () => {
    const map = new Map([[1, 2]]);
    const set = new Set([1]);
    const plainIterator = { next() { return { done: true, value: undefined }; } };

    strictEqual(types.isMap(map), true);
    strictEqual(types.isSet(set), true);
    strictEqual(types.isWeakMap(new WeakMap()), true);
    strictEqual(types.isWeakSet(new WeakSet()), true);
    strictEqual(types.isMapIterator(map.keys()), true);
    strictEqual(types.isMapIterator(map.entries()), true);
    strictEqual(types.isMapIterator(plainIterator), false);
    strictEqual(types.isSetIterator(set.values()), true);
    strictEqual(types.isSetIterator(plainIterator), false);
});

Deno.test('util.types: function, generator, promise and error predicates', async () => {
    async function asyncFn() {}
    function* generatorFn() { yield 1; }

    strictEqual(types.isAsyncFunction(asyncFn), true);
    strictEqual(types.isAsyncFunction(async function* asyncGenerator() {}), true);
    strictEqual(types.isAsyncFunction(function regular() {}), false);
    strictEqual(types.isGeneratorFunction(generatorFn), true);
    strictEqual(types.isGeneratorObject(generatorFn()), true);
    strictEqual(types.isGeneratorObject({ next() { return { done: true }; } }), false);
    strictEqual(types.isPromise(Promise.resolve()), true);
    strictEqual(types.isPromise({ then() {} }), false);
    strictEqual(types.isNativeError(new TypeError('x')), true);
    strictEqual(types.isNativeError({ name: 'Error', message: 'x' }), false);
    await asyncFn();
});

Deno.test('util.types: built-in object predicates cover common branches', () => {
    strictEqual(types.isArgumentsObject((function () { return arguments; })()), true);
    strictEqual(types.isArgumentsObject({ callee: true }), false);
    strictEqual(types.isDate(new Date()), true);
    strictEqual(types.isRegExp(/x/g), true);
    strictEqual(types.isDataView(new DataView(new ArrayBuffer(1))), true);
    strictEqual(types.isProxy(new Proxy({}, {})), true);
    strictEqual(types.isProxy({}), false);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    strictEqual(types.isProxy(revoked.proxy), true);
});

Deno.test('util.types: internal-only brands cannot be forged with public properties', () => {
    const fakeArguments = { [Symbol.toStringTag]: 'Arguments' };
    const fakeGenerator = { [Symbol.toStringTag]: 'Generator', next() {} };
    const fakeMapIterator = { [Symbol.toStringTag]: 'Map Iterator', next() {} };
    const fakeSetIterator = { [Symbol.toStringTag]: 'Set Iterator', next() {} };
    const fakeNamespace = { [Symbol.toStringTag]: 'Module' };
    function regular() {}
    Object.defineProperty(regular, 'constructor', { value: { name: 'GeneratorFunction' } });

    strictEqual(types.isArgumentsObject(fakeArguments), false);
    strictEqual(types.isGeneratorFunction(regular), false);
    strictEqual(types.isGeneratorObject(fakeGenerator), false);
    strictEqual(types.isMapIterator(fakeMapIterator), false);
    strictEqual(types.isSetIterator(fakeSetIterator), false);
    strictEqual(types.isModuleNamespaceObject(fakeNamespace), false);
    strictEqual(types.isModuleNamespaceObject(types), true);
    strictEqual(types.isGeneratorObject((async function* () {})()), true);
});

Deno.test('util.types: built-in predicates use internal brands, not Symbol.hasInstance or tags', () => {
    const constructors = [ArrayBuffer, DataView, Date, Map, Promise, RegExp, Set, Error, Uint8Array] as Function[];
    const descriptors = constructors.map((ctor) => Object.getOwnPropertyDescriptor(ctor, Symbol.hasInstance));
    try {
        for (const ctor of constructors) {
            Object.defineProperty(ctor, Symbol.hasInstance, { value: () => false, configurable: true });
        }
        strictEqual(types.isArrayBuffer(new ArrayBuffer(1)), true);
        strictEqual(types.isDataView(new DataView(new ArrayBuffer(1))), true);
        strictEqual(types.isDate(new Date()), true);
        strictEqual(types.isMap(new Map()), true);
        strictEqual(types.isPromise(Promise.resolve()), true);
        strictEqual(types.isRegExp(/x/), true);
        strictEqual(types.isSet(new Set()), true);
        strictEqual(types.isNativeError(new Error('x')), true);
        const bytes = new Uint8Array(1);
        Object.defineProperty(bytes, Symbol.toStringTag, { value: 'Wrong' });
        strictEqual(types.isUint8Array(bytes), true);
        strictEqual(types.isTypedArray(bytes), true);

        const boxed = Object(1n);
        Object.defineProperty(boxed, Symbol.toStringTag, { value: 'Wrong' });
        strictEqual(types.isBoxedPrimitive(boxed), true);
        strictEqual(types.isBoxedPrimitive({ [Symbol.toStringTag]: 'BigInt' }), false);
    } finally {
        constructors.forEach((ctor, index) => {
            const descriptor = descriptors[index];
            if (descriptor) Object.defineProperty(ctor, Symbol.hasInstance, descriptor);
            else Reflect.deleteProperty(ctor, Symbol.hasInstance);
        });
    }
});
