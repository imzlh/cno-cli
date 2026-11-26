// @cno-host: false
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const source = ts.createSourceFile('main.ts',
    readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const networkSource = ts.createSourceFile('network.ts',
    readFileSync(new URL('../../src/network.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

test('CLI startup imports the lightweight blob registry, not network implementations', () => {
    const imports = source.statements.filter(ts.isImportDeclaration)
        .map(statement => statement.moduleSpecifier.text);
    assert.ok(imports.includes('../cno/src/webapi/object-url'));
    for (const path of ['./network', '../cno/src/utils/http', '../cno/src/webapi/url']) {
        assert.ok(!imports.includes(path), `${path} must not initialize on the startup path`);
    }
});

test('network proxy connector stays lazy on the TLS-only path', () => {
    const imports = networkSource.statements.filter(ts.isImportDeclaration)
        .map(statement => statement.moduleSpecifier.text);
    assert.ok(imports.includes('../cno/src/utils/proxy'), 'network still needs proxy types');
    const proxyImport = networkSource.statements.find(statement =>
        ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === '../cno/src/utils/proxy');
    assert.ok(proxyImport && ts.isImportDeclaration(proxyImport));
    assert.ok(proxyImport.importClause?.isTypeOnly === true,
        'createProxyConnector must not initialize with network.ts');

    const startProxy = networkSource.statements.find(statement =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'startProxy');
    assert.ok(startProxy && ts.isFunctionDeclaration(startProxy));
    const text = startProxy.getText(networkSource);
    assert.match(text, /await import\(['"]\.\.\/cno\/src\/utils\/proxy['"]\)/,
        'system proxy must load its connector only when enabled');
});

// Execute the actual flag handler without bootstrapping the native CLI. Keep its
// declaration and lazy module slot intact; only the imported transports are fake.
const declarations = source.statements.filter(statement =>
    (ts.isFunctionDeclaration(statement) && statement.name?.text === 'applyNetworkFlags')
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(
        declaration => declaration.name.getText(source) === 'networkModule')));
assert.equal(declarations.length, 2);
const compiled = await build({
    stdin: {
        contents: declarations.map(statement => statement.getText(source)).join('\n')
            + '\nexport { applyNetworkFlags };',
        loader: 'ts',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{
        name: 'network-fixtures',
        setup(plugin) {
            plugin.onResolve({ filter: /^\.\.?\// }, ({ path }) => ({ path, namespace: 'fixture' }));
            plugin.onLoad({ filter: /./, namespace: 'fixture' }, ({ path }) => ({
                contents: path === './network' ? `
                    __record__('load:network');
                    export function configureTlsHooks(flags) {
                        __record__('tls:' + !!flags['skip-cert-verify']);
                    }
                    export async function startProxy() { __record__('proxy'); }
                ` : `
                    __record__('load:http');
                    export function disableRawCertVerify() { __record__('raw-tls'); }
                `,
            }));
        },
    }],
});

function fixture() {
    const events = [];
    const module = { exports: {} };
    runInNewContext(compiled.outputFiles[0].text, {
        module, exports: module.exports,
        __record__: event => events.push(event),
        C: { warn: value => value }, errMsg: String,
        console: { warn: message => events.push(message) },
    });
    return { events, applyNetworkFlags: module.exports.applyNetworkFlags };
}

for (const [name, flags, expected] of [
    ['no network flags', {}, []],
    ['explicitly disabled flags', { 'system-proxy': false, 'skip-cert-verify': false }, []],
    ['proxy only', { 'system-proxy': true }, ['load:network', 'tls:false', 'proxy']],
    ['TLS only', { 'skip-cert-verify': true }, ['load:network', 'tls:true', 'load:http', 'raw-tls']],
    ['proxy and TLS', { 'system-proxy': true, 'skip-cert-verify': true },
        ['load:network', 'tls:true', 'load:http', 'raw-tls', 'proxy']],
]) {
    test(`CLI lazy network loading: ${name}`, async () => {
        const { events, applyNetworkFlags } = fixture();
        await applyNetworkFlags(flags);
        assert.deepEqual(events, expected);
    });
}

test('CLI lazy network module is reused across flag applications', async () => {
    const { events, applyNetworkFlags } = fixture();
    await applyNetworkFlags({ 'skip-cert-verify': true });
    await applyNetworkFlags({ 'system-proxy': true });
    assert.deepEqual(events,
        ['load:network', 'tls:true', 'load:http', 'raw-tls', 'tls:false', 'proxy']);
});
