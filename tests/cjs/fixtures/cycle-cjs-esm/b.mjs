// The back-import that closes the cycle. Node never evaluates this body:
// linking it throws ERR_REQUIRE_CYCLE_MODULE because a.cjs is mid-execution.
import a from './a.cjs';
export const aSeen = a && a.value;
export default 'b-value';
