import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { join } from 'node:path';
import { Transformer } from '../../cts/src/source/transform.ts';
import { OxcTranspiler, tryLoadOxc, type OxcModule } from '../../cts/src/oxc.ts';

const engine = import.meta.use('engine');

Deno.test('cts: OXC receives the resolved format through every transform API', () => {
    const source = '@decorate class Subject {}';
    const bytes = engine.encodeString(source);
    for (const api of ['compat', 'fast', 'bytes', 'shared'] as const) {
        const formats: Array<boolean | undefined> = [];
        const native: OxcModule = {
            version: 'format-test',
            transpile(code, options) {
                formats.push(options?.isCjs);
                strictEqual(options?.kind, 'js');
                return { code, deps: [] };
            },
            scanImports() { return []; },
        };
        if (api === 'fast') {
            native.transpileFast = (code, kind, _filename, isCjs) => {
                formats.push(isCjs);
                strictEqual(kind, 0);
                return { code };
            };
        } else if (api === 'bytes') {
            native.transpileBytes = (input, kind, _filename, isCjs) => {
                formats.push(isCjs);
                strictEqual(kind, 0);
                return { code: engine.decodeString(input) };
            };
        } else if (api === 'shared') {
            native.transpileSharedBytes = (input, kind, _filename, isCjs) => {
                formats.push(isCjs);
                strictEqual(kind, 0);
                return { code: input };
            };
        }
        const oxc = new OxcTranspiler(native);
        const transformer = new Transformer({ sourceMaps: false });
        transformer.setOxc(oxc);
        if (api === 'bytes' || api === 'shared') {
            ok(oxc.transpileBytes(bytes, 'package.js', undefined, 'js', true));
            ok(transformer.transformCaptureBytes(bytes, 'package.js'));
            transformer.transformBytes(bytes, 'package.js');
            deepStrictEqual(formats, [true, false, false], api);
        } else {
            transformer.transformForCjs(source, 'package.js');
            transformer.transform(source, 'package.js');
            transformer.transformForCjs(source, 'explicit.cts');
            transformer.transformCapture(source, 'explicit.cjs');
            deepStrictEqual(formats, [true, false, true, false], api);
        }
    }
});

Deno.test('cts: native decorators honor CommonJS format for ordinary .js files', async () => {
    const oxc = tryLoadOxc();
    ok(oxc, 'native OXC is required');
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxc(oxc);
    const source = `
        function decorate(value) {
            return class extends value { read() { return super.read() + 2; } };
        }
        @decorate
        class Subject { read() { return 40; } }
        return new Subject().read();
    `;
    const code = transformer.transformForCjs(source, 'commonjs-package/subject.js');
    strictEqual(new Function(code)(), 42);
    throws(() => transformer.transform(source, 'commonjs-package/subject.js'));

    const directory = Deno.makeTempDirSync({ prefix: 'cno-oxc-decorators-cjs-' });
    try {
        Deno.writeTextFileSync(join(directory, 'package.json'), '{"type":"commonjs"}');
        Deno.writeTextFileSync(join(directory, 'subject.js'), source.replace(
            'return new Subject().read();',
            'return module.exports = new Subject().read();',
        ));
        const entry = join(directory, 'entry.mjs');
        Deno.writeTextFileSync(entry, `
            import result from './subject.js';
            if (result !== 42) throw new Error('unexpected decorated CJS export: ' + result);
        `);
        const result = await new Deno.Command(Deno.execPath(), {
            args: ['run', '--no-lock', '--disable-cache', entry],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        strictEqual(result.code, 0, engine.decodeString(result.stderr));
    } finally {
        Deno.removeSync(directory, { recursive: true });
    }
});

Deno.test('cts: native decorator lowering retains OXC comments in string and byte sources', () => {
    const oxc = tryLoadOxc();
    ok(oxc, 'native OXC is required');
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxc(oxc);
    const source = `
        /*! decorator-license */
        function decorate(value) { return value; }
        // before-decorated-class
        @decorate
        class Subject {
            // inside-decorated-method
            method() { return 42; }
        }
        // after-decorated-class
        Subject;
    `;
    const bytes = engine.encodeString(source);
    const outputs = [
        transformer.transform(source, 'comments.js'),
        transformer.transformForCjs(source, 'comments.js'),
        transformer.transformBytes(bytes, 'comments.js'),
    ];
    for (const output of outputs) {
        const code = typeof output === 'string' ? output : engine.decodeString(output);
        for (const comment of [
            '/*! decorator-license */',
            '// before-decorated-class',
            '// inside-decorated-method',
            '// after-decorated-class',
        ]) {
            ok(code.includes(comment), `missing ${comment}:\n${code}`);
        }
        strictEqual(new Function(`${code}\nreturn new Subject().method();`)(), 42);
    }
});

function executeNativeTypeScript(source: string, filename: string): unknown {
    const oxc = tryLoadOxc();
    ok(oxc, 'native OXC is required; refusing to verify decorators through Sucrase fallback');
    const transformer = new Transformer({ sourceMaps: false });
    transformer.setOxc(oxc);
    const code = transformer.transform(`const decoratedResult = (() => {\n${source}\n})();`, filename, 'ts');
    return new Function(`${code}\nreturn decoratedResult;`)();
}

Deno.test('cts: standard decorators preserve contexts, member behavior, and class semantics', () => {
    const source = `
        const events: string[] = [];
        const contexts: any[] = [];
        const accesses: Record<string, any> = {};
        const initializers: Array<{ tag: string; receiver: object }> = [];
        let originalClass: any;

        function computedKey(name: string): string {
            events.push('key:' + name);
            return 'computed_' + name;
        }

        function observe(tag: string) {
            return function(value: any, context: any) {
                contexts.push({
                    tag,
                    kind: context.kind,
                    name: String(context.name),
                    static: context.static === true,
                    private: context.private === true,
                });
                accesses[tag] = context.access;
                context.addInitializer(function(this: object) {
                    initializers.push({ tag, receiver: this });
                });

                if (context.kind === 'field') {
                    return function(initial: number) { return initial + 10; };
                }
                if (context.kind === 'accessor') {
                    return {
                        init(initial: number) { return initial + 2; },
                        get(this: unknown) { return value.get.call(this); },
                        set(this: unknown, next: number) { value.set.call(this, next * 2); },
                    };
                }
                if (context.kind === 'getter') {
                    return function(this: unknown) { return value.call(this) + 1; };
                }
                if (context.kind === 'setter') {
                    return function(this: unknown, next: number) { value.call(this, next * 2); };
                }
                if (context.kind === 'method') {
                    return function(this: unknown, ...args: unknown[]) {
                        return value.apply(this, args) + ':wrapped';
                    };
                }
            };
        }

        function replaceClass(value: any, context: any) {
            contexts.push({
                tag: 'class',
                kind: context.kind,
                name: String(context.name),
                static: context.static === true,
                private: context.private === true,
            });
            context.addInitializer(function(this: object) {
                initializers.push({ tag: 'class', receiver: this });
            });
            originalClass = value;
            return class extends value { static replacement = true; };
        }

        class Parent {
            greet() { return 'parent'; }
        }

        @replaceClass
        class Subject extends Parent {
            constructor(public readonly label: string) { super(); }
            @observe('first') [computedKey('first')]() { return this.label; }
            @observe('second') [computedKey('second')]() { return 'second'; }
            @observe('override') override greet() { return super.greet() + ':child'; }
            @observe('static') static ping() { return 'pong'; }
            @observe('field') field = 2;
            @observe('getter') get doubled() { return this.field; }
            @observe('setter') set assigned(next: number) { this.field = next; }
            @observe('accessor') accessor amount = 3;
            @observe('privateField') #secret = 7;
            @observe('privateMethod') #secretCall(next: number) { return this.#secret + next; }
        }

        const instance = new Subject('parameter-property');
        return {
            events,
            contexts,
            accesses,
            initializers,
            instance,
            Subject,
            originalClass,
        };
    `;
    const result = executeNativeTypeScript(source, 'standard-decorators.ts') as {
        events: string[];
        contexts: Array<{ tag: string; kind: string; name: string; static: boolean; private: boolean }>;
        accesses: Record<string, any>;
        initializers: Array<{ tag: string; receiver: object }>;
        instance: any;
        Subject: any;
        originalClass: any;
    };
    const context = (tag: string) => result.contexts.find(item => item.tag === tag)!;

    deepStrictEqual(result.events.slice(0, 2), ['key:first', 'key:second']);
    strictEqual(context('class').kind, 'class');
    strictEqual(context('class').name, 'Subject');
    strictEqual(context('first').kind, 'method');
    strictEqual(context('first').name, 'computed_first');
    strictEqual(context('getter').kind, 'getter');
    strictEqual(context('setter').kind, 'setter');
    strictEqual(context('field').kind, 'field');
    strictEqual(context('accessor').kind, 'accessor');
    strictEqual(context('static').static, true);
    strictEqual(context('privateField').private, true);
    strictEqual(context('privateField').name, '#secret');
    for (const tag of ['first', 'static', 'field', 'privateField', 'privateMethod']) {
        strictEqual(typeof result.accesses[tag].has, 'function');
    }

    strictEqual(result.Subject !== result.originalClass, true);
    strictEqual(result.Subject.replacement, true);
    strictEqual(result.Subject.ping(), 'pong:wrapped');
    strictEqual(result.instance.label, 'parameter-property');
    strictEqual(result.instance.computed_first(), 'parameter-property:wrapped');
    strictEqual(result.instance.computed_second(), 'second:wrapped');
    strictEqual(result.instance.greet(), 'parent:child:wrapped');
    strictEqual(result.instance.field, 12);
    strictEqual(result.instance.doubled, 13);
    result.instance.assigned = 4;
    strictEqual(result.instance.field, 8);
    strictEqual(result.instance.doubled, 9);
    strictEqual(result.instance.amount, 5);
    result.instance.amount = 6;
    strictEqual(result.instance.amount, 12);

    const privateField = result.accesses.privateField;
    ok(privateField.has(result.instance));
    strictEqual(privateField.get(result.instance), 17);
    privateField.set(result.instance, 19);
    strictEqual(privateField.get(result.instance), 19);
    ok(result.accesses.privateMethod.has(result.instance));
    strictEqual(result.accesses.privateMethod.get(result.instance).call(result.instance, 2), '21:wrapped');

    ok(result.initializers.some(item => item.tag === 'class' && item.receiver === result.Subject));
    ok(result.initializers.some(item => item.tag === 'static' && item.receiver === result.originalClass));
    ok(result.initializers.some(item => item.tag === 'static' && item.receiver !== result.Subject));
    ok(result.initializers.some(item => item.tag === 'field' && item.receiver === result.instance));
    ok(result.initializers.some(item => item.tag === 'privateField' && item.receiver === result.instance));
});

Deno.test('cts: async method decorators execute their wrapped implementation', async () => {
    const source = `
        function wrapAsync(value: any, context: any) {
            if (context.kind !== 'method') throw new Error('expected method decorator');
            return async function(this: unknown, input: number) {
                return (await value.call(this, input)) * 3;
            };
        }

        const failure = new Error('async rejection');
        class AsyncSubject {
            @wrapAsync async calculate(input: number): Promise<number> {
                if (input < 0) throw failure;
                return input + 4;
            }
        }

        const instance = new AsyncSubject();
        return {
            fulfilled: instance.calculate(5),
            rejected: instance.calculate(-1),
            failure,
        };
    `;
    const result = executeNativeTypeScript(source, 'decorated-async.ts') as {
        fulfilled: Promise<number>;
        rejected: Promise<never>;
        failure: Error;
    };
    ok(result.fulfilled instanceof Promise, 'decorated async method must return a promise');
    strictEqual(await result.fulfilled, 27);
    let rejection: unknown;
    try {
        await result.rejected;
    } catch (error) {
        rejection = error;
    }
    strictEqual(rejection, result.failure);
});
