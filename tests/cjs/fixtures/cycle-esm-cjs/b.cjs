// require() back into the in-flight ESM module. Node throws here; the
// catch records the code so the test can assert on it without killing
// the whole graph (a.mjs still finishes loading afterwards, as in Node).
let cycleCode = null;
let cycleMessage = '';
let namespaceLeaked = null;
try {
    const a = require('./a.mjs');
    namespaceLeaked = { aVal: a && a.aVal, default: a && a.default };
} catch (e) {
    cycleCode = e && e.code;
    cycleMessage = String((e && e.message) || '');
}
exports.cycleCode = cycleCode;
exports.cycleMessage = cycleMessage;
exports.namespaceLeaked = namespaceLeaked;
exports.value = 'b-value';
