# CLI

The CLI lives in `src/`. `src/cli.ts` owns the option registry, tokenization,
argument regions, and validation. `src/kernel.ts` prepares core settings and
owns runtime initialization. Commands consume prepared settings and their own
options; `src/config.ts` maps normalized values to CTS configuration, and
`src/env.ts` owns environment reads and env-file loading.

## Entry Point

```text
src/main.ts
  registerExtensions()
  mainEntry()
  dispatch()
    parseArgv() / validateInvocation()
    prepareKernel()
    command handler
```

Before dispatching, the CLI imports `../cno/src/main` so the runtime polyfills
are installed.

`dispatch()` applies the effective network settings:

- `--system-proxy`
- `--skip-cert-verify`

Process lifecycle handling is registered once through the CTS event multiplexer,
so the main process, test children, and workers share the same exit boundary.

## Command Routing

| Command | Owner | Notes |
| --- | --- | --- |
| `run <file>` | `src/commands/run.ts` | Creates CTS runtime and evaluates entry |
| `serve <file>` | `src/commands/serve.ts` | Loads the default server export and calls `Deno.serve()` |
| implicit `<file>` | `src/main.ts` -> `run.ts` | First non-command token becomes entry |
| `eval <code>` | `src/commands/eval.ts` | Evaluates source entry |
| `repl` | `src/commands/repl/` | Interactive evaluator |
| `test [paths]` | `src/commands/test.ts` | Runs test files in child processes |
| `task [name]` | `src/commands/task.ts` | Runs deno/package task definitions |
| `cache [file]` | `src/commands/cache.ts` | Resolves graph and writes lock |
| `pack <file>` | `src/commands/pack.ts` | Writes a self-contained `.jspack` module container |
| `setup` | `src/commands/setup.ts` | Installs Node builtin polyfills into cache |
| `exec <bin>` | `src/commands/bin.ts` | Resolves and spawns npm/package binaries |

`serve` evaluates the entry module, reads its default export, and starts
`Deno.serve()` with that export's `fetch` and optional `onListen` handlers. It
requires a non-null object default export with a function-valued `fetch`; an
optional `onListen` must also be a function. Other properties are ignored. It
does not run a file that calls `Deno.serve()` itself; use `run` for that shape.

## Argument Parsing

`src/cli.ts` makes the first non-flag token decide the command:

```text
cno run app.ts a b   -> cmd=run, positional=[app.ts, a, b]
cno app.ts a b       -> cmd=null, implicit run
cno task build       -> cmd=task
cno -e "code"        -> cmd=eval
```

Arguments have three separate regions:

```text
cno [prefix options] <command> [command options] <entry> [script args]
cno --conditions=dev run --cache-dir=.cache app.ts --inspect -- user-value
    └ prefix ─────┘     └ command ───────┘        └ script args ────────┘
```

The registry defines each option's value syntax, aliases, and owner. The parser
preserves every occurrence and its original tokens, so repeated values and
missing values are validated before a later option can hide them.

Core options (`--inspect*`, `--require`, `--import`, `--loader`, `--conditions`,
`--memory-limit`, `--max-stack-size`, `--max-old-space-size`, and `--v8-flags`)
take effect only in the prefix. In the command region they are recognized and
retained in the raw command arguments, but remain inactive. For example,
`cno --require=./init.cjs run app.ts` loads the preload;
`cno run --require=./init.cjs app.ts` does not. Unknown options and missing
required values are rejected in both option regions.

Runtime options such as `--cache-dir` can establish prefix defaults. A value in
the owning command's region overrides that default. Command-specific options
such as `test --filter` and `task --cwd` remain scoped to their commands.

`run`, `serve`, `eval`, `task`, `exec`, and implicit run stop option parsing at
their entry, source text, task name, or binary name. Every subsequent token,
including `--`, empty strings, and apparent cno options, is forwarded unchanged.
`test`, `cache`, and `pack` accept options among their targets until `--`;
`test` uses that separator to begin the test module's arguments.

## Core Preparation

`prepareKernel()` loads prefix env files followed by command env files in
occurrence order, then reads and validates `NODE_OPTIONS`. This allows an env
file to supply Node options before any runtime or Inspector starts.

`NODE_OPTIONS` uses the same registry and option tokenizer as the CLI. Its
string grammar recognizes whitespace, double quotes, and escapes within double
quotes; it does not expand shell syntax. Only core options and `--no-warnings`
are allowed. Command options, positional tokens, malformed quoting, and missing
values fail explicitly. Here `-r` means `--require`; on the cno command line it
continues to mean `--reload`.

Node options establish core defaults, with explicit prefix values taking
precedence. Repeated conditions and Node preloads accumulate in that order.
The cno-specific `--memory-limit` / `CTS_MEMORY_LIMIT` retains priority over
the compatibility `--max-old-space-size` limit.

Commands that execute code use `openKernelRuntime()`: attach the Inspector,
create CTS, initialize argv and polyfills, run `--preload` modules in prefix /
command order, then run Node preloads from `NODE_OPTIONS` and the prefix.
`--loader` currently emits an unsupported-loader warning.

Configuration retains its owning layer: project settings provide defaults,
prepared core settings override them, and effective command runtime options
apply last. Commands do not rescan argv or `NODE_OPTIONS` to recover core values.

## Runtime Lifetime And Exit

Entry evaluation can finish while timers, servers, or dynamic imports are still
active. `run` and `eval` call the kernel session's `finish()` at that boundary.
It lets the Inspector stop keeping the process alive; it leaves the runtime and
Inspector bridge usable by pending application work. An Inspector opened later
through the bridge also receives this exit policy.

`KernelRuntime.close()` is terminal and idempotent. Concurrent calls share one
promise; it disposes the bridge, detaches the Inspector, and cleans up CTS even
if detachment fails. Construction or initialization failures use the same close
path while preserving the original error. The REPL closes its session when it
ends. Bounded commands such as `cache` and `pack` release their CTS runtime in
`finally` after success or failure.

`src/main.ts` synchronizes the exit status with `os.setExitCode()` after dispatch
and on native `EV.BEFORE_EXIT`, after user `beforeExit` handlers. Explicit
`process.exitCode` takes precedence over the first nonzero status requested by
runtime diagnostics. Synchronizing the status neither stops pending work nor
adds polling handles; `beforeExit` can schedule more work and run again.

Terminal process cleanup runs once on native `EV.EXIT`, after user exit/unload
handlers. It stops CLI network services, closes remaining lock stores, and
releases process-owned resources. Returning from the command handler does not
trigger this cleanup.

## Worker Configuration

Runtime initialization publishes a schema-filtered configuration snapshot through
`src/config.ts`. Arrays and nested maps, including conditions, import maps,
scopes, and path aliases, are copied; changing the runtime configuration does not
mutate the published snapshot. The schema also carries resource limits, JSX
settings, request/cache timing, and runtime feature switches.

Web and Node workers receive this snapshot and decode another independent copy.
They prepare an empty core invocation with `inheritNodeOptions: false`, so parent
Inspector options and Node preloads are not executed again. Both file and eval
workers receive the decoded configuration. Test children instead reconstruct
their separately transmitted argument regions and prepare their own invocation.

## Runtime argv

The parser builds an `Args` object used by `cno/src/utils/args.ts`. `src/main.ts`
sets this for every command so `Deno.args`, `process.argv`, and related values
are not limited to `run`.

`kernelArgs`, `commandArgs`, and `scriptArgs` share storage with the legacy
`internalArgs`, `actionArgs`, and `args` names. `process.execArgv` contains the
original prefix tokens, plus the eval spelling and source for eval invocations;
it excludes command options and `NODE_OPTIONS`. Script arguments feed both
`Deno.args` and `process.argv` without being reparsed.

## Common Flags

| Flag | Effect |
| --- | --- |
| `--cache-dir=<dir>` | Override CTS cache directory |
| `--lock-dir=<dir>` | Override lock directory |
| `--no-lock` | Use in-memory lock only |
| `--frozen` | Refuse resolution not already in lock |
| `--reload`, `-r` | Precache before running |
| `--precache` | Precache before running |
| `--no-http` | Disable http/https remote imports |
| `--no-jsr` | Disable JSR imports |
| `--no-node` | Disable Node builtin resolution |
| `--no-oxc` | Disable OXC extension use |
| `--disable-cache` | Disable module cache behavior |
| `--ignore-scripts` | Skip deferred npm lifecycle scripts during cache |
| `--npm-mode=normal|soft|hard` | Materialize node_modules during cache |
| `--silent`, `-q` | Reduce output |

The CLI accepts many Deno permission and unstable flags as no-ops so Deno-style
commands can run without immediate flag failures.

## Inspector Flags

Inspector addresses are validated in `src/inspector/options.ts`.
`src/kernel.ts` owns attachment, the runtime bridge, and cleanup for commands
that execute code. Place Inspector options before the command:

```sh
cno --inspect[=host:port] run app.ts
cno --inspect-brk[=host:port] eval "code"
cno --inspect-wait[=host:port] test tests/
```

The inspector must attach before `createRuntime()` so it can wrap module hooks
before CTS installs its own engine hook.

## Cache Command

`cno cache` without an entry collects specifiers from:

- `deno.json` or `deno.jsonc` imports
- `package.json` dependencies
- `package.json` devDependencies
- `package.json` optionalDependencies

`cno cache <file>...` resolves every entry. If any entry belongs to the local
project, it also seeds package dependencies, including development tools; the
entry graph supplies the relevant import-map edges. Remote-only entries do not
seed unrelated project dependencies.

The command sets `persistLock: true`, so it is the normal path that writes
`cts.lock`. Both invocation forms share runtime preparation and cleanup, including
failures during entry resolution or dependency scanning.

## Pack Command

`cno pack <entry> [-o output.jspack]` resolves one complete module graph and
writes it to a portable container. The entry project's nearest config file is
used even when the command is launched from a parent directory. Output defaults
to `<entry-name>.jspack` in the current directory. `--silent`/`-q` suppresses
both progress and the final artifact summary; `cno pack --help` lists the
pack-specific options.

An extensionless entry uses TypeScript syntax by default, matching `cno run`.
Use `--ext=js`, `--ext=jsx`, or another explicit language when needed.

Packed execution never resolves missing edges against the original source tree.
A dependency or compile error therefore fails the pack instead of producing a
partially portable artifact. Source bytes are retained beside bytecode so a pack
can recompile when the QuickJS bytecode ABI differs or import attributes require
the source path. Dependency downloads may populate the shared CTS cache, but
packing does not create or update `cts.lock`; persistent lock ownership remains
with `cno cache`.

## Setup Command

`cno setup` installs Node builtin polyfill `.ts` files to:

```text
<cacheDir>/node
```

It prefers a local checkout source such as `cno/src/node`. If no local source is
found, it can fetch files from GitHub.

After editing only `cno/src/node/`, running setup is usually enough to refresh
the staged runtime cache.

## Test Command

`cno test` discovers files matching:

```text
[._]test.[jt]sx?
```

Skipped directories:

```text
node_modules, .git, dist, build, build_release
```

Each test file runs in a real child process using a versioned environment
sentinel carrying the prefix and command arguments separately. This
keeps process and signal behavior closer to normal runtime behavior than a
worker-only runner. Test script arguments are passed directly in the child
argv; they cannot become runner flags. `exec` and `task` also preserve prefix
tokens when forwarding to a cno child and do not promote inactive command
options into that child's prefix.
