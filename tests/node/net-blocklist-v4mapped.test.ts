import { ok, strictEqual, throws } from 'node:assert';
import * as net from 'node:net';

// net.BlockList exists only for access control, so a missed match is a bypass
// rather than a parity gap: a blocked IPv4 peer that reconnects over IPv6
// presents its address in the IPv4-mapped form ::ffff:a.b.c.d.
//
// Measured against node v24.18.0 on the same machine. Two facts drive the
// implementation and are asserted here so a future refactor cannot quietly
// move the behaviour:
//   1. Rules are stored VERBATIM — `bl.rules` keeps the family and spelling it
//      was given. The mapped/plain equivalence is resolved at check() time, not
//      by rewriting the rule on the way in.
//   2. The equivalence is BIDIRECTIONAL, and applies to addAddress, addRange
//      and addSubnet alike, including the range edges.

Deno.test('net.BlockList: a v4 rule matches the IPv4-mapped IPv6 form', () => {
    const bl = new net.BlockList();
    bl.addAddress('123.123.123.123');

    // The rule is stored as IPv4 and must not be rewritten.
    strictEqual(bl.rules.length, 1);
    strictEqual(bl.rules[0], 'Address: IPv4 123.123.123.123');

    strictEqual(bl.check('123.123.123.123', 'ipv4'), true);
    // THE BYPASS: this was false before the fix.
    strictEqual(bl.check('::ffff:123.123.123.123', 'ipv6'), true);
    // A different address must still not match.
    strictEqual(bl.check('::ffff:123.123.123.124', 'ipv6'), false);
});

Deno.test('net.BlockList: a v4-mapped rule matches the plain v4 form', () => {
    const bl = new net.BlockList();
    bl.addAddress('::ffff:5.6.7.8', 'ipv6');

    strictEqual(bl.rules[0], 'Address: IPv6 ::ffff:5.6.7.8');
    strictEqual(bl.check('::ffff:5.6.7.8', 'ipv6'), true);
    // The reverse direction of the same equivalence.
    strictEqual(bl.check('5.6.7.8', 'ipv4'), true);
    strictEqual(bl.check('5.6.7.9', 'ipv4'), false);
});

Deno.test('net.BlockList: addRange matches mapped addresses including both edges', () => {
    const bl = new net.BlockList();
    bl.addRange('10.0.0.1', '10.0.0.10');

    strictEqual(bl.check('10.0.0.5', 'ipv4'), true);
    strictEqual(bl.check('::ffff:10.0.0.5', 'ipv6'), true);
    // Edges are the classic off-by-one site for a range comparison.
    strictEqual(bl.check('::ffff:10.0.0.1', 'ipv6'), true);
    strictEqual(bl.check('::ffff:10.0.0.10', 'ipv6'), true);
    // Just outside must stay false in the mapped form too.
    strictEqual(bl.check('::ffff:10.0.0.0', 'ipv6'), false);
    strictEqual(bl.check('::ffff:10.0.0.11', 'ipv6'), false);
});

Deno.test('net.BlockList: addSubnet matches mapped addresses in both directions', () => {
    const v4 = new net.BlockList();
    v4.addSubnet('10.0.0.0', 8);
    strictEqual(v4.check('10.1.2.3', 'ipv4'), true);
    strictEqual(v4.check('::ffff:10.1.2.3', 'ipv6'), true);
    strictEqual(v4.check('::ffff:11.1.2.3', 'ipv6'), false);

    // A v6 subnet covering the whole mapped range must catch plain v4 too.
    const v6 = new net.BlockList();
    v6.addSubnet('::ffff:0.0.0.0', 96, 'ipv6');
    strictEqual(v6.check('::ffff:1.2.3.4', 'ipv6'), true);
    strictEqual(v6.check('1.2.3.4', 'ipv4'), true);
});

Deno.test('net.BlockList: the equivalence is confined to the ::ffff:0:0/96 prefix', () => {
    // A *pure* IPv6 rule must never be matched by an unrelated v4 address —
    // widening the mapping to all of IPv6 would over-block, which is its own
    // defect. node v24.18.0 returns false here.
    const bl = new net.BlockList();
    bl.addAddress('2001:db8::1', 'ipv6');
    strictEqual(bl.check('2001:db8::1', 'ipv6'), true);
    strictEqual(bl.check('1.2.3.4', 'ipv4'), false);

    // ::1.2.3.4 is IPv4-*compatible*, not IPv4-*mapped* (no ffff), so it must
    // NOT match a v4 rule. Verified false on node.
    const v4 = new net.BlockList();
    v4.addAddress('1.2.3.4');
    strictEqual(v4.check('::1.2.3.4', 'ipv6'), false);
});

Deno.test('net.BlockList: alternate spellings of the mapped form all match', () => {
    const bl = new net.BlockList();
    bl.addAddress('1.2.3.4');
    // All three denote the same 128-bit value; node matches every one, so a
    // string-comparison implementation would be a bypass.
    strictEqual(bl.check('::FFFF:1.2.3.4', 'ipv6'), true, 'uppercase hex');
    strictEqual(bl.check('::ffff:0102:0304', 'ipv6'), true, 'hex-group form');
    strictEqual(bl.check('0:0:0:0:0:ffff:1.2.3.4', 'ipv6'), true, 'fully expanded');
});

// --- the `type` argument defaults to 'ipv4', it is not auto-detected ---------
//
// node v24.18.0: addAddress('::1') with no type throws ERR_INVALID_ADDRESS, and
// check('::1') with no type is false even when a matching IPv6 rule exists.
// cno auto-detected the family, which silently installed rules node rejects.

Deno.test('net.BlockList: type defaults to ipv4 rather than auto-detecting', () => {
    const bl = new net.BlockList();
    throws(() => bl.addAddress('::1'), { code: 'ERR_INVALID_ADDRESS' });
    throws(() => bl.addAddress('2001:db8::1'), { code: 'ERR_INVALID_ADDRESS' });
    throws(() => bl.addSubnet('::', 64), { code: 'ERR_INVALID_ADDRESS' });
    throws(() => bl.addRange('::1', '::9'), { code: 'ERR_INVALID_ADDRESS' });
    strictEqual(bl.rules.length, 0, 'a rejected rule must not be installed');

    const v6 = new net.BlockList();
    v6.addAddress('::1', 'ipv6');
    strictEqual(v6.check('::1', 'ipv6'), true);
    strictEqual(v6.check('::1'), false, 'no type must mean ipv4, so a v6 literal cannot match');
});

Deno.test('net.BlockList: check returns false for an unparseable address', () => {
    // node returns false rather than throwing; a check() that throws turns a
    // deny-list miss into a crash at the call site.
    const bl = new net.BlockList();
    bl.addAddress('1.2.3.4');
    strictEqual(bl.check('not-an-ip'), false);
    strictEqual(bl.check(''), false);
    // The add path, by contrast, does throw — and carries node's code.
    throws(() => bl.addAddress('not-an-ip'), { code: 'ERR_INVALID_ADDRESS' });
    throws(() => bl.addRange('10.0.0.10', '10.0.0.1'), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => bl.addAddress('1.2.3.4', 'bogus'), { code: 'ERR_INVALID_ARG_VALUE' });
});

Deno.test('net.BlockList: rules are returned verbatim and the getter is a copy', () => {
    const bl = new net.BlockList();
    bl.addAddress('1.1.1.1');
    bl.addRange('10.0.0.1', '10.0.0.3');
    bl.addSubnet('192.168.0.0', 24);
    const rules = bl.rules;
    ok(rules.includes('Address: IPv4 1.1.1.1'));
    ok(rules.includes('Range: IPv4 10.0.0.1-10.0.0.3'));
    ok(rules.includes('Subnet: IPv4 192.168.0.0/24'));
    rules.push('mutated');
    strictEqual(bl.rules.length, 3, 'the rules getter must not expose the backing array');
});
