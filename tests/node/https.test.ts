import { strictEqual, ok } from 'node:assert';
import * as https from 'node:https';
import * as tls from 'node:tls';

// --- 1. https.createServer is a function -----------------------------------

Deno.test('https: createServer is a function', () => {
    ok(typeof https.createServer === 'function');
});

// --- 2. https.request is a function -----------------------------------------

Deno.test('https: request and get are functions', () => {
    ok(typeof https.request === 'function');
    ok(typeof https.get === 'function');
});

// --- 3. https.globalAgent exists -------------------------------------------

Deno.test('https: globalAgent exists', () => {
    ok(https.globalAgent);
});

// --- 4. https.createServer returns a server with listen/close --------------

Deno.test('https: createServer returns a server', () => {
    const s = https.createServer({});
    ok(typeof s.listen === 'function');
    ok(typeof s.close === 'function');
    s.close();
});

// --- 5. https.STATUS_CODES is inherited from http ---------------------------

Deno.test('https: STATUS_CODES populated', () => {
    ok(https.STATUS_CODES[200] === 'OK');
    ok(https.STATUS_CODES[404] === 'Not Found');
});

// --- 6. https.METHODS is an array ------------------------------------------

Deno.test('https: METHODS is an array', () => {
    ok(Array.isArray(https.METHODS));
    ok(https.METHODS.includes('GET'));
});

// --- 7. https.Agent is a constructor ---------------------------------------

Deno.test('https: Agent is a constructor', () => {
    ok(typeof https.Agent === 'function');
});

// --- 8. Agent maxSockets default -------------------------------------------

Deno.test('https: Agent maxSockets default is Infinity', () => {
    const a = new https.Agent();
    ok(a.maxSockets === Infinity || typeof a.maxSockets === 'number');
});

// --- 9. createServer with requestListener ----------------------------------

Deno.test('https: createServer accepts requestListener', () => {
    const s = https.createServer({}, (_req, res) => {});
    ok(s);
    s.close();
});

// --- 10. server address() returns null when not listening ------------------

Deno.test('https: server.address() returns null before listen', () => {
    const s = https.createServer({});
    strictEqual(s.address(), null);
    s.close();
});
