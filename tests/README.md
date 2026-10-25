# cno tests
This is the test directory for the `cno` project. It contains various test files for different aspects of the project.
You can run the tests by executing `cno test tests/`, which will execute all the tests in the `tests/` directory and report the results.
Hint: These tests are written in TypeScript and using deno-compatible `Deno.test()` syntax. You can also try them via `deno test tests/`

The Node-hosted runtime integration tests bundle their fixtures before invoking
the staged binary, avoiding expensive source loading in a cold cache. Run them
with `node --test tests/cts/module-id-cycle-guard.test.mjs tests/cts/pack-command.test.mjs`.
Set `CNO_TEST_BINARY` to use a binary outside `build/stage/`.
