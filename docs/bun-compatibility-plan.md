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

- Read `AGENTS.md`, `cts/AGENT.md`, and any applicable directory instructions.
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
- [x] M2 batch (2026-11-05): TCP-only `Bun.connect`/`Bun.listen` over the host Deno
  net primitives, `Bun.stdin/stdout/stderr` descriptor handles with
  `Bun.write` support, `Bun.gc`, `Bun.enableANSIColors`, `CryptoHasher`
  `blake2b256` (pure-JS keyed BLAKE2b, RFC 7693-verified), and a native
  `bytesIsUtf8`+`engine.decodeString` byte-path decode in `Bun.file`. Also
  fixed a pre-existing `CryptoHasher.digest(encoding)` regression that never
  converted encodings. New tests: blake2b, net, stdio,
  runtime-globals; the full `tests/bun` bucket is green apart from seven
  failures A/B-proven pre-existing at HEAD (array-buffer-sink, cli,
  cookie-class, hash-classes, module, pack-worker, streams). Root and CTS
  type-checks and the boundary/unit lanes pass identically to HEAD. The batch
  went through three independent agent review passes; review fixed a blake2b
  counter-word bug (≥4 GiB inputs), an empty-key semantics deviation, the
  net.ts socket close-state machine (idempotent close, drain-deferred close,
  detached-handler failure routing). The same pass surfaced and fixed three
  `hash-classes` regressions (digest
  encoding, `digest`/`sha` arity, lone-surrogate inputs), taking that suite
  from the pre-existing-failure list to green. Known follow-up: the blob's
  bundled Buffer class (installed as the global by the node inject) and the
  runtime-resolved `node:buffer` class are distinct evaluations; node's
  contract makes them one class, and the builtin registry handing out the
  blob's instance is a separate cross-layer fix.
- [ ] `Bun.password` remains unsupported. Bun 1.4.4 only accepts Argon2
  and bcrypt; the native crypto binding has neither, and substituting scrypt or
  PBKDF2 under Bun's API would create non-interoperable security output.
- [x] Third pass (2026-11-05): `BunFile.writer()`/FileSink (buffered writes,
  advisory highWaterMark, GC-safe descriptor release, stdio `writer()`),
  `Bun.write` ReadableStream input, `blake2b512` keyed-BLAKE2b semantics
  (python differential 100/100), and fixes for four more pre-existing bun
  failures: `ArrayBufferSink` lone-surrogate encoding, `Cookie` getter
  names/receivers/enumerability and `toStringTag`, `readableStreamToText`
  BOM/WHATWG replacement, and the `hash-classes` regressions. The bun bucket
  is 42/45 with only the three timing-class files (cli, module, pack-worker)
  failing, as documented. Root and CTS type-checks pass; boundary lane
  unchanged from HEAD.
- [x] Fourth pass (2026-11-05, implementation complete; consolidated serial
  verification in progress): `Bun.serve({ routes })` now supports bounded
  exact-path handlers, static `Response` values, method maps, routes-only
  servers, fallback, and atomic route-table reload. Static response snapshots
  are eagerly read, limited to 16 MiB/16,384 chunks per response and a
  process-wide 32 MiB cache budget (including reload overlap); unused tables
  release snapshots, and static `HEAD` responses avoid a body copy. Response
  streams are copied in bounded 64 KiB chunks, and response/table finalizers
  release retained snapshot state after consumption, cancellation, reload, or
  garbage collection. Parameters,
  wildcards, directory/BunFile/HTML routes, TLS, and WebSockets remain outside
  the subset. `Bun.write(path, Request)` now uses the existing staged stream
  path, handles bodyless requests as truncation, and rejects used or locked
  bodies; Request stream writes to fixed stdio handles remain unsupported.
  Added `Bun.unsafe.memoryFootprint()` as a Linux-only, best-effort
  `/proc/self/smaps_rollup` PSS reader returning `undefined` on unsupported or
  malformed hosts. `Bun.unsafe.arrayBufferToString()` now provides a copying
  ASCII `ArrayBuffer`/`Uint8Array` path and a copying `Uint16Array` path;
  typed-array input follows Bun's byte/UTF-16 interpretation while DataView is rejected. `Bun.shrink()` is a
  best-effort engine collection request. `Bun.isStandaloneExecutable` and
  `Bun.embeddedFiles` are truthful frozen feature-detection values (`false`
  and an empty list) because cno does not produce Bun compile artifacts.
  `Bun.color` now accepts numeric typed-array and StringLike inputs, supports
  deterministic foreground ANSI-256 output (`ansi-256`, `ansi_256`, `ansi256`),
  and rejects malformed/non-finite CSS functional input; ANSI-16 and automatic
  ANSI remain unsupported.
  `ArrayBufferSink` restores cross-realm binary brand checks without silently
  coercing arbitrary array-like inputs, and `Bun.dns` exposes stable Bun flag
  values for the host DNS bridge. Focused coverage was added for routes,
  Request writes, unsafe, ANSI-256/StringLike/typed-array parser cases,
  standalone feature detection, and sink/DNS edges. The earlier ten-case Node
  route-unit lane passed before the later aggregate-budget, 64 KiB stream-copy,
  and finalizer work; the updated route-budget lane and all newly added focused
  lanes still require serial reruns. `cno` type-check, staged runtime tests,
  and the payload-boundary lane also remain required, so this checkbox stays
  open until the maintainer's final verification. Serial verification
  completed 2026-11-06 on a rebuilt stage binary with a refreshed payload:
  all focused lanes, the node --test unit lane, the payload-boundary lane,
  and cno type-check pass; full tests/bun bucket 49/53 with module.test at
  108s. The remaining failures are the spawn-heavy cli-* files, which hang
  on child-process spawn in this environment and fail identically at HEAD
  (A/B verified) — a documented environment limitation, not a regression.
- [x] Fifth pass (2026-11-06): `Bun.serve({ routes })` gained Bun 1.4.4's dynamic patterns over
  the fourth-pass exact-path subset: `:param` segments capture one
  non-empty decoded segment, a trailing `/*` matches everything under its
  prefix (including the prefix slash form, not the bare prefix), matching
  prefers exact, then parameter, then wildcard patterns with more static
  segments first and registration order breaking ties (upstream's finer
  ordering remains unverified against a live oracle), and route-dispatched handlers receive a non-enumerable
  read-only `params` property (empty for exact and wildcard routes, mirroring
  `BunRequest`'s typed params and the upstream behavior that wildcard
  remainders are not captured). Pattern keys are precompiled whole-segment
  matchers that avoid per-request allocations on non-matching paths, and
  dynamic patterns are capped at 1024 per table. BunFile route values reuse
  the static snapshot mechanism (eager buffered read inside the 16 MiB/32 MiB
  budgets, HEAD without a body copy, inferred content type) and 404 for files
  missing at registration. Directory route values (`{ dir }` on `/*` keys, the
  documented Bun 1.4.4 form) stream files per request, percent-decode the
  remainder once, reject non-canonical remainders and dot segments with 404,
  enforce realpath containment (symlink escapes 404 rather than clamping),
  redirect directory requests to the trailing-slash URL, serve `index.html`,
  and accept `statCache` as a no-op. Directory support is wired through a
  route-value resolver installed by the bun namespace so serve.ts stays free
  of filesystem imports. `Bun.write` now streams Request bodies into fixed
  stdio handles chunk by chunk (bodyless requests write zero bytes; used or
  locked bodies reject; a failing destination cancels the body); Response and
  ReadableStream input for stdio remains rejected. `Bun.color` gained
  foreground ANSI 16 (`ansi-16`/`ansi_16`, chained deterministically through
  the existing ansi-256 mapping onto a fixed xterm 16-color reference palette)
  and the automatic `ansi` format, which selects ansi-16m/ansi-256/ansi-16 by
  Bun's documented environment detection (`FORCE_COLOR`, then `NO_COLOR`, then
  the TERM/TMUX/CI/TERM_PROGRAM/COLORTERM table gated on the stdout TTY
  snapshot) and returns an empty string when stdout supports no ANSI color.
  New tests: serve-routes-params-unit, color-depth-unit, serve-routes-params,
  serve-static, write-request-stdio; the fourth-pass route unit lanes were
  updated for the widened grammar. Serial verification completed 2026-11-06:
  all node --test unit lanes (28/28), 51 staged use cases across the routes/
  static/write/color/file/serve lanes, and the cno type-check (at baseline)
  pass. An independent review pass found no P0/P1 issues; its P2 notes
  (parameter-bearing directory prefixes now rejected loudly, route-key error
  message updated for the widened grammar, empty-object route value behavior
  recorded) were applied before commit.
  Post-commit hardening (2026-11-06, codex rounds two and three + this
  session): static file responses gained content-length (only for trusted
  sizes; procfs-style zero-size files keep EOF framing), conditional GET
  (If-None-Match with quote-aware validator splitting / If-Modified-Since →
  304), and single byte ranges (206 with content-range, unsatisfiable →
  416, multi-range and non-byte units → full body); the follow-up review
  replaced the locking TransformStream window with BunFile's bounded slice,
  fixed malformed/zero-suffix range parsing, and added date-form If-Range;
  the color depth table was rewritten against the
  installed Bun 1.4.4 oracle (FORCE_COLOR numeric parse and clamping,
  NO_COLOR=false/0 enabled, TERM table without a stdout-TTY gate);
  serve-static rejects percent-encoded aliases of literal filenames and
  `//`; route params are own data properties (a ':__proto__' pattern keeps
  its capture). URLPattern stays behind the shared optional-module accessor,
  and urlpattern.ts imports the vendor class directly so the module cannot
  recurse through its own accessor.
