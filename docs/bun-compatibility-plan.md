# Bunni: Incremental Bun Compatibility Plan

## Maintainer Direction Update (2026-10-30)

The maintainer superseded the extraction boundary below: implement the Bun
compatibility layer in the existing `cno/src/bun/` project, with a separate
`_internal/inject.ts` bootstrap, rather than a new standalone `bunni/` source
component. The project is intended to become Bunni; do not silently change the
existing executable identity or break current consumers during this transition.
The pre-existing nested `bunni/.git` and its contents are not to be removed or
turned into a gitlink without an explicit decision.

Use upstream `@types/bun` as the development typing target, acknowledging that
declarations describe APIs not yet implemented. Runtime behavior and documented
support must not be inferred from those declarations. Claude Code is a longer
term integration target, not an established compatibility claim.

Independent circu.js-based compositions (including custom loaders with cno)
must not require a particular TypeScript composition root. A separate pure-C
circu.js communication facility is being explored for context-owned objects and
notifications. It must not embed TypeScript in circu.js or assume that distinct
JS contexts on the same thread share object ownership. Bun implementation and
tests proceed in parallel; no dependency on a new communication facility should
be invented until its actual contract and lifecycle have been validated.

The maintainer now authorizes focused, validated commits. For changes to
existing submodules, record the submodule commit separately; the parent pointer
alone is not reproducible elsewhere until that commit is published.

## Objective And Decisions

Add a practical, explicitly partial Bun compatibility surface to the existing
`cno` runtime. Keep Deno, Node, Web APIs, the `cno` executable, and existing CLI
semantics. This is an additional compatibility target, not a runtime replacement
or a Bun implementation. No change of engine and no Bun/JSC runtime dependency.

The compatibility layer belongs in `cno/src/bun/` and reuses existing
Web/native primitives rather than copying filesystem, HTTP or resource-lifetime
implementations. Bunni is the intended project direction; the existing `cno/`
submodule and executable remain in place until a migration is deliberately
implemented. Do not invent an upstream URL or publish anything.

## Baseline And Worktree Safety

- Read `AGENT.md`, `cts/AGENT.md`, and any applicable directory instructions.
- Existing `readme.md` changes predate this task. Do not overwrite, reformat,
  stage, or remove them. The maintainer confirmed that previously observed
  missing, unrelated untracked docs and website files are not a blocker.
- The research document is background, not an implementation specification.
  Verify native signatures and actual code rather than copying its examples
  or inheriting its unverified performance/full-compatibility claims.
- Initial submodules `cno`, `cts`, `circu.js`, and `http` are clean.
- Baseline root `pnpm run type-check` passes (2026-10-30).
- A staged native binary and host `cjsc` exist under `build/`.
- Bun is not on PATH. Bun 1.4.4 was installed separately under `/tmp` as a
  differential oracle; it is not a project or runtime dependency. Local tests
  alone do not prove upstream parity.

## Ownership And Integration

| Component | Responsibility |
| --- | --- |
| `cno/src/bun/_internal/inject.ts` | Tiny embedded bootstrap that installs only the lazy `globalThis.Bun` getter |
| `cno/src/bun/` (excluding `_internal`) | Bun-facing TypeScript installed by `cno setup` and loaded on demand |
| `@types/bun` | Upstream API declarations; not a runtime support guarantee |
| `src/` | CLI composition/bootstrap and host adapters, if needed |
| `cts/` | Small loader integration only; no Bun API implementation |
| `cno/` | Existing Web/Deno/Node primitives; change only a real shared contract |
| `http/`, `circu.js/` | Existing lower-level transport/native ownership |
| `tests/bun/` | Public behavior and integration regression coverage |

The Bun implementation must not enter the embedded CLI bundle. The main blob
contains only `_internal/inject.ts`; its lazy getter currently calls the realm's
`require('bun:index')`, which CTS normalizes to the canonical `bun` module. Raw
sources are installed under `<cacheDir>/bun`; ordinary Deno/CNO startup neither
reads nor evaluates them. Missing sources fail only when Bun is requested. The
bootstrap/retry and multi-realm contract remains under review; do not infer it
from this resolver alias.

CTS reserves the complete `bun` / `bun:*` family before import maps, lockfiles,
npm, packs, or network resolution. `bun` maps to `<cacheDir>/bun/index.ts`;
`bun:index` is an alias for that same file and canonical identity. Other safe
`bun:x` names map first to `<cacheDir>/bun/x.ts`, then to
`<cacheDir>/bun/x/index.ts`, while retaining canonical `bun:x` identity. Do not
hide Bun implementations in the Node builtin registry or make package
resolution prefer the `bun` export condition globally.

Do not rewrite import strings with regexes or bypass canonical module identity.
The bare builtin `bun` must not trigger npm resolution; unknown `bun:*` modules
must fail deterministically instead of falling back to npm, network, or arbitrary
paths. Preserve existing Node builtin names and `--no-node` behavior.

## Delivery Scope

### M1: Foundation And First Useful Vertical Slice (Execute Now)

1. Create the `cno/src/bun/` component and integrate only its lazy bootstrap
   after the existing Web/Deno/Node prerequisites are available. Build all
   implementation modules as setup-managed TypeScript sources.
2. Install one `globalThis.Bun` object per JS context. Make the supported named
   exports and default export from `bun` refer to the same implementation.
   Support static/dynamic ESM import and the existing synchronous CJS bridge.
3. Implement simple, well-defined APIs: `Bun.argv`, `Bun.env`, `Bun.main`, and
   `Bun.sleep`. Read argv/env/main at the correct lifecycle point, rather than
   snapshotting before the CLI has set script arguments and environment files.
   Do not fabricate a Bun version/revision or change `process.execPath`,
   `Deno.execPath()`, or the executable's identity to pretend it is Bun.
4. Implement a documented path-based `Bun.file`/`Bun.write` subset:
   - lazy file-backed Blob-compatible objects;
   - string paths and local file URLs, content type override;
   - `text`, `json`, `arrayBuffer`, `bytes`, `exists`, `size`, `type`, `slice`,
     and a pull-based `stream` with cancellation and owned-descriptor cleanup;
   - writes from strings, correctly offset buffer views, ArrayBuffer, Blob,
     Response, and another supported file object; return bytes written;
   - truncation/overwrite, empty files, Unicode content, missing files,
     same-file safety, slice bounds, errors, and repeated reads;
   - interoperability with existing `Response`/`Blob` consumers.
   File descriptors, FileSink/writer, stdin/stdout/stderr file wrappers, remote
   URLs/S3, mmap, and optimized sendfile are explicitly out of scope. Reject
   unsupported overloads/options that would otherwise silently misbehave.
5. Implement an HTTP-only `Bun.serve` subset using an existing server primitive:
   - synchronous server handle; port/hostname and ephemeral port 0;
   - sync/async `fetch(request, server)` and Response/streaming response bodies;
   - useful `port`, `hostname`, and `url` metadata;
   - an intentional stop/shutdown contract and error cleanup.
   First inspect what the host actually supports. Do not advertise placeholder
   lifecycle methods. Reject unsupported websocket/TLS/routes/hot-reload options
   explicitly; do not silently accept them. Document any supported `stop`
   limitation rather than implying force-close semantics the host lacks.
6. Cover `run`, `eval`, cache/precache, lock/frozen behavior, CJS, workers, and
   relocated/offline `.jspack` execution for the initial builtin. Runtime-provided
   modules must not acquire a dependency on the original checkout or be copied
   inconsistently into every pack. Include OXC and `--no-oxc` smoke paths.
7. Wire declarations, root type-check inputs, setup/install dependencies, and
   the normal CI/test discovery path. A clean standalone installation obtains
   the revision-pinned raw sources through `cno setup`; runtime loading does not
   download or precompile them. Check that the CLI-bundle metafile contains no
   Bun implementation input.

If a shared primitive cannot support an advertised behavior faithfully, reduce
and document that overload instead of adding a broad native rewrite. The M1
acceptance bar is a working, tested vertical slice, not the longest API list.

### M2: Database And Process Adapters (In Progress)

- `bun:sqlite` now has an initial adapter over the native SQLite surface:
  Database, Statement, positional/named binding, run/get/all/values, nested
  transactions, safe integers, query caching, close/finalize behavior, errors,
  functions, and aggregates. This is a tested partial implementation, not a
  claim of full Bun parity; unsupported Statement APIs still throw explicitly.
- `Bun.spawn`/`spawnSync`: argv-only launch first, exit status and signal behavior,
  pipes/backpressure, cancellation and cleanup, no implicit shell emulation.
- Additional practical helpers only when a real use case and tests justify them.

### M3: Use-Case-Driven Expansion (Planned)

- Select real Bun-first applications/adapters and record their specific missing
  APIs. Promote compatibility only after fixture/integration coverage passes.
- Consider websocket serve, password/hash helpers, FFI, and additional file
  overloads individually, with explicit native/behavioral costs.
- Plan the Bunni project rename with explicit migration and publication steps;
  preserve compatibility for existing users until the transition is agreed.

### Non-Goals

No Bun package manager/lockfile emulation, `bun build`/bundler, `bun:test`, tagged
shell `$`, Bun plugins/transpiler, JSC internals, full FFI, all export conditions,
or claims that Elysia/Drizzle/all Bun packages already work. No deletion of Deno
code, command renaming, CLI impersonation, or broad README/website redesign.

## Validation And Acceptance

- Add focused tests under `tests/bun/` plus narrow CTS tests for loader changes.
- Test observable behavior, not just existence of a property or import success.
- Use unique test cache/temp directories; never share a cache with another run.
- Exercise errors, unsupported options, resource cancellation, and child exits.
  Test missing/unknown `bun:*` without any network access or checkout fallback.
- Run `pnpm run type-check`, bundle, and rebuild the staged binary before runtime
  tests. If sandbox restrictions affect pnpm/network/socket tests, request the
  required command approval; do not quietly turn failures into passing skips.
- Run the new Bun bucket, relevant CTS/CJS/worker/pack tests, and focused existing
  Deno/Web/Node filesystem/HTTP regressions for reused contracts.
- Run a standalone/offline smoke test outside the source tree with a fresh cache.
- If Bun is available, run a small shared oracle fixture for the supported
  contracts and record its exact version. Otherwise label results as cno tests,
  not differential confirmation.
- Add a supported/partial/unsupported matrix and small runnable examples in
  `cno/src/bun/README.md` and link maintainer documentation from `docs/README.md`.
  Update this plan with actual scope, command results, and remaining limitations.
- Commit focused, validated changes. Summarize root and existing submodule changes
  separately, including the publication requirement for changed submodules.

## Execution Record

- [x] Inspect architecture, current Deno/Node/bootstrap/CTS ownership, and dirty files.
- [x] Select component name and repository boundary.
- [x] Record scope, non-goals, staged rollout, and validation requirements.
- [x] Hand the plan to Luna (`shareai/gpt-5.6-luna`).
- [x] Install upstream `@types/bun` 1.4.4 and pass root type-check.
- [x] Prepare a Bun 1.4.4 oracle and a shared differential fixture.
- [x] Implement the M1 code slice: lazy global injection, setup-managed builtin
  sources, lifecycle globals, file/write, HTTP-only serve,
  cache/frozen/pack/worker integration, and focused tests. `bun:sqlite` was also
  started as an explicitly partial M2 slice.
- [x] Finish the unified rebuilt-binary test pass: 35/35 Bun test files,
  2/2 focused CTS files, and 45/45 boundary/unit tests pass against the staged
  executable; root and CTS type-checks plus the release bundle also pass.
- [x] Add the supported/partial/unsupported matrix and examples in
  `cno/src/bun/README.md`.
- [x] Parent review and focused commits for the cno source tree, CTS loader, and
  root build/runtime integration.
