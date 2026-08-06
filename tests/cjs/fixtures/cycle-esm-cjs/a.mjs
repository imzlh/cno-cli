// a.mjs imports a CJS module that require()s a.mjs back. The require()
// lands on an ESM module that is still mid-compile, which Node refuses
// with ERR_REQUIRE_CYCLE_MODULE ("Cannot require() ES Module ... in a cycle").
import b from './b.cjs';
export const bSeen = b && b.value;
export const aVal = 'a-value';
export default 'a-default';
