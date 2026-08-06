// a.cjs require()s an ESM module that imports back from a.cjs.
// Node refuses the back-import with ERR_REQUIRE_CYCLE_MODULE
// ("Cannot import CommonJS Module ./a.cjs in a cycle"), so this
// require() throws and `loaded` never becomes true.
exports.early = 'a-early';
const b = require('./b.mjs');
exports.bDefault = b && b.default;
exports.value = 'a-value';
