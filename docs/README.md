# cno-cli Documentation

This directory is the maintainer-facing documentation layer for `cno-cli`.
README files at the repository root and in subprojects give quick orientation;
these docs explain the active code paths and operational rules in more detail.

For agent-specific workflow rules, coding constraints, and durable debugging
notes, read `../AGENT.md`. Do not duplicate those rules here unless the same
information is useful to human maintainers.

## Contents

| Document | Scope |
| --- | --- |
| `architecture.md` | Runtime layers, package boundaries, and active execution path |
| `api-surfaces.md` | Public and semi-public CLI, config, module, global, and extension surfaces |
| `cli.md` | CLI parser, command routing, flags, and command-specific behavior |
| `compatibility.md` | Compatibility status language and Web/Deno/Node support boundaries |
| `module-loading.md` | CTS resolver/compiler, cache, lock, npm, OXC, and precompile flow |
| `polyfills.md` | Web API, Deno API, Node.js modules, and CNO namespace |
| `build-test.md` | Build commands, staged binary, setup, and focused validation |
| `native-extensions.md` | circu.js core, native modules, allocator rules, extension model |
| `inspector.md` | Chrome DevTools Protocol inspector architecture and routing |

## Maintenance Rules

Keep docs tied to current source paths. If a behavior is implemented in code,
name the file that owns it. If a behavior is planned or partial, say so
directly.

Good documentation updates usually happen when:

- a public command, flag, or environment variable changes
- runtime cache or lock semantics change
- a module boundary moves
- a compatibility surface gains or loses meaningful behavior
- a public or semi-public API surface changes
- build, setup, or validation commands change
- native extension loading or embedding changes

Do not update docs for every local bugfix. Prefer documenting durable behavior
and stable maintenance boundaries.

## Source Of Truth

When docs and code disagree, code wins. Start from these entry points:

| Area | Source |
| --- | --- |
| CLI dispatch | `../src/main.ts` |
| CLI parsing | `../src/cli.ts` |
| Public API index | `api-surfaces.md` |
| Compatibility status | `compatibility.md` |
| Runtime creation | `../src/commands/run.ts` |
| Cache command | `../src/commands/cache.ts` |
| Test command | `../src/commands/test.ts` |
| Setup command | `../src/commands/setup.ts` |
| CTS runtime | `../cts/src/runtime/index.ts` |
| CTS resolver | `../cts/src/resolve/index.ts` |
| CTS compiler | `../cts/src/compile/index.ts` |
| CNO bootstrap | `../cno/src/main.ts` |
| Node injection | `../cno/src/node/_internal/inject.ts` |
| Native runtime | `../circu.js/src/` |
| Root build | `../CMakeLists.txt` |
