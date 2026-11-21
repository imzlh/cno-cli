import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { XML } from '../../cno/src/bun/utils/xml.ts';

Deno.test('bun XML: native parsing preserves compact and ordered document content', () => {
    const source = '<?xml version="1.0"?><root id="A1"><item sku="x">Tea &amp; bread</item><item><![CDATA[Mug <red>]]></item><empty/> hello <b>world</b>!<!-- note --><?go now?></root>';
    const compact = { root: { '@id': 'A1', item: [{ '@sku': 'x', '#text': 'Tea & bread' }, 'Mug <red>'], empty: '', '#text': ' hello !', b: 'world' } };
    deepStrictEqual(XML.parse(source), compact);
    const tree = XML.parse(source, { compact: false });
    deepStrictEqual(tree, {
        name: 'root', attributes: { id: 'A1' }, children: [
            { name: 'item', attributes: { sku: 'x' }, children: ['Tea & bread'] },
            { name: 'item', attributes: {}, children: ['Mug <red>'] },
            { name: 'empty', attributes: {}, children: [] }, ' hello ',
            { name: 'b', attributes: {}, children: ['world'] }, '!', { comment: ' note ' }, { target: 'go', data: 'now' },
        ],
    });
    deepStrictEqual(XML.parse(XML.stringify(compact)), compact);
    deepStrictEqual(XML.parse(XML.stringify(tree), { compact: false }), tree);
    deepStrictEqual(XML.parse('<!DOCTYPE r [<!ENTITY x "hello"><!ATTLIST r n CDATA "default">]><r>&x;</r>'), { r: { '@n': 'default', '#text': 'hello' } });
    deepStrictEqual(XML.parse('<!DOCTYPE r [<!ENTITY % decl "<!ENTITY x \'hello\'>">%decl;]><r>&x;</r>'), { r: 'hello' });
    throws(() => XML.parse('<!DOCTYPE r SYSTEM "file:///tmp/missing"><r>&x;</r>'), /External DTD/);
    throws(() => XML.parse('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/hostname">]><r>&x;</r>'), /External DTD/);
    throws(() => XML.parse('<!DOCTYPE r [<!ENTITY % decl "<!ENTITY x SYSTEM \'file:///tmp/missing\'>">%decl;]><r>a&x;b</r>'), /External DTD/);
    throws(() => XML.parse('<r><x></r>'), SyntaxError);
    throws(() => XML.parse('<r/>', { compact: 'false' } as never), TypeError);
});

Deno.test('bun XML: binary windows, encodings, Blob input and safe property names', () => {
    const source = '<?xml version="1.0" encoding="ISO-8859-1"?><r a="é">café</r>';
    const bytes = Buffer.from('!' + source + '!', 'latin1');
    deepStrictEqual(XML.parse(new DataView(bytes.buffer, bytes.byteOffset + 1, bytes.byteLength - 2)), { r: { '@a': 'é', '#text': 'café' } });
    const unicode = '<?xml version="1.0" encoding="UTF-16"?><r>茶😀</r>';
    deepStrictEqual(XML.parse(Buffer.from('\ufeff' + unicode, 'utf16le')), { r: '茶😀' });
    for (const encoding of ['UTF-16', 'UTF-16LE', 'UTF-16BE']) {
        const utf16 = Buffer.from(`<?xml version="1.0" encoding="${encoding}"?><r>茶😀</r>`, 'utf16le');
        deepStrictEqual(XML.parse(utf16), { r: '茶😀' });
        deepStrictEqual(XML.parse(Buffer.from(utf16).swap16()), { r: '茶😀' });
    }
    for (const encoding of ['ASCII', 'us-ascii']) {
        deepStrictEqual(XML.parse(Buffer.from(`\ufeff<?xml version="1.0" encoding="${encoding}"?><r>é</r>`)), { r: 'é' });
    }
    deepStrictEqual(XML.parse(Buffer.from('<?xml version="1.0" encoding="ISO_8859-1"?><r>é</r>', 'latin1')), { r: 'é' });
    deepStrictEqual(XML.parse(Buffer.from('<?xml version="1.0"' + ' '.repeat(300) + 'encoding="ISO-8859-1"?><r>é</r>', 'latin1')), { r: 'é' });
    deepStrictEqual(XML.parse(new Blob(['<r>茶</r>'])), { r: '茶' });
    deepStrictEqual(XML.parse(source), { r: { '@a': 'é', '#text': 'café' } });
    const named = XML.parse('<root><__proto__>safe</__proto__><constructor>x</constructor></root>');
    deepStrictEqual(named, JSON.parse('{"root":{"__proto__":"safe","constructor":"x"}}'));
    strictEqual(Object.getPrototypeOf(named.root), Object.prototype);
    let inheritedAccess = 0;
    const properties = ['xmlTrap', '@a', '#text'];
    const descriptors = properties.map(key => Object.getOwnPropertyDescriptor(Object.prototype, key));
    for (const key of properties) {
        Object.defineProperty(Object.prototype, key, {
            configurable: true, get() { inheritedAccess++; return 'inherited'; }, set() { inheritedAccess++; },
        });
    }
    try {
        const attributed = XML.parse('<root __proto__="safe" constructor="x" xmlTrap="y"/>', { compact: false });
        deepStrictEqual(attributed.attributes, JSON.parse('{"__proto__":"safe","constructor":"x","xmlTrap":"y"}'));
        strictEqual(Object.getPrototypeOf(attributed.attributes), Object.prototype);
        deepStrictEqual(XML.parse('<r a="x">before<b/>after</r>'), { r: { '@a': 'x', '#text': 'beforeafter', b: '' } });
        strictEqual(inheritedAccess, 0);
    } finally {
        for (const [index, key] of properties.entries()) {
            const descriptor = descriptors[index];
            if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
            else Reflect.deleteProperty(Object.prototype, key);
        }
    }
    throws(() => XML.parse(new Uint8Array([0x3c, 0x72, 0x3e, 0xff, 0x3c, 0x2f, 0x72, 0x3e])), SyntaxError);
    throws(() => XML.parse(Buffer.from('<?xml version="1.0" encoding="gbk"?><r/>')), SyntaxError);
    throws(() => XML.parse(Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-8"?><r/>', 'utf16le')), SyntaxError);
    throws(() => XML.parse(Buffer.from('\ufeff<?xml version="1.0" encoding="ISO-8859-1"?><r/>')), SyntaxError);
    for (const declaration of ['', '<?xml version="1.0"?>']) {
        const utf16 = Buffer.from(declaration + '<r/>', 'utf16le');
        throws(() => XML.parse(utf16), SyntaxError);
        throws(() => XML.parse(utf16.swap16()), SyntaxError);
    }
    throws(() => XML.parse('<?xml version="1.0" encoding="utf 8"?><r/>'), SyntaxError);
});

Deno.test('bun XML: compact and tree serialization escape and validate complete structures', () => {
    strictEqual(XML.stringify({ order: { '@id': 'A\t"&', item: ['Tea', 'Mug'], paid: null } }, null, 2), '<order id="A&#x9;&quot;&amp;">\n  <item>Tea</item>\n  <item>Mug</item>\n  <paid/>\n</order>');
    strictEqual(XML.stringify({ name: 'p', attributes: { class: 'x' }, children: ['Hi ', { name: 'b', children: ['!'] }, { comment: ' note ' }, { target: 'go', data: 'now' }] }, null, 2), '<p class="x">Hi <b>!</b><!-- note --><?go now?></p>');
    strictEqual(XML.stringify({ r: { date: new Date('2026-01-01T00:00:00Z'), count: 3n, ignored: undefined, text: '<&>\r' } }), '<r><date>2026-01-01T00:00:00.000Z</date><count>3</count><text>&lt;&amp;&gt;&#xD;</text></r>');
    strictEqual(XML.stringify({ r: { '#text': 'pre', x: { y: 'line\nbreak', z: '' } } }, null, 2), '<r>pre<x>\n  <y>line\nbreak</y>\n  <z/>\n</x></r>');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    throws(() => XML.stringify({ r: circular }), /Circular/);
    for (const value of [{ 'bad name': '' }, { r: { '@bad name': 'x' } }, { r: '\0' }, { r: { '#text': {} } }, { r: [['nested']] }]) {
        throws(() => XML.stringify(value));
    }
    throws(() => XML.stringify({ name: 'r', children: [{ comment: '--' }] }));
    throws(() => XML.stringify({ name: 'r', children: [{ target: 'go', data: '?>' }] }));
});
