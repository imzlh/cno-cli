const a = require('./a.cjs');
exports.fromB = 'B';
exports.aSeen = a.fromA; // partial: 'A' is already set when b runs
