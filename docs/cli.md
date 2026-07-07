# CLI

The CLI lives in `src/`. `src/main.ts` is the entry point; `src/cli.ts` parses
arguments and reconstructs runtime argv for Deno and Node compatibility.

## Entry Point

```text
src/main.ts
  registerExtensions()
  mainEntry()
  dispatch()
```

Before dispatching, the CLI imports `../cno/src/main` so the runtime polyfills
are installed.

`dispatch()` also installs process cleanup and optional network settings:

- `--system-proxy`
- `--skip-cert-verify`

## Command Routing

| Command | Owner | Notes |
| --- | --- | --- |
| `run <file>` | `src/commands/run.ts` | Creates CTS runtime and evaluates entry |
| implicit `<file>` | `src/main.ts` -> `run.ts` | First non-command token becomes entry |
| `eval <code>` | `src/commands/eval.ts` | Evaluates source entry |
| `repl` | `src/commands/repl/` | Interactive evaluator |
| `test [paths]` | `src/commands/test.ts` | Runs test files in child processes |
| `task [name]` | `src/commands/task.ts` | Runs deno/package task definitions |
| `cache [file]` | `src/commands/cache.ts` | Resolves graph and writes lock |
| `setup` | `src/commands/setup.ts` | Installs Node builtin polyfills into cache |
| `exec <bin>` | `src/commands/bin.ts` | Resolves and spawns npm/package binaries |

`fmt`, `lint`, and `upgrade` are currently recognized but not implemented.

## Argument Parsing

`src/cli.ts` makes the first non-flag token decide the command:

```text
cno run app.ts a b   -> cmd=run, positional=[app.ts, a, b]
cno app.ts a b       -> cmd=null, implicit run
cno task build       -> cmd=task
cno -e "code"        -> cmd=eval
```

After the script entry is found, remaining tokens are script args and are not
parsed as cno flags.

## Runtime argv

The parser builds an `Args` object used by `cno/src/utils/args.ts`. `src/main.ts`
sets this for every command so `Deno.args`, `process.argv`, and related values
are not limited to `run`.

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

Inspector flags are parsed in `src/commands/inspect.ts` and consumed by
`src/commands/run.ts`.

```sh
--inspect[=host:port]
--inspect-brk[=host:port]
--inspect-wait[=host:port]
```

The inspector must attach before `createRuntime()` so it can wrap module hooks
before CTS installs its own engine hook.

## Cache Command

`cno cache` without an entry collects specifiers from:

- `deno.json` or `deno.jsonc` imports
- `package.json` dependencies
- `package.json` devDependencies
- `package.json` optionalDependencies

`cno cache <file>` resolves the entry and also seeds package/config specifiers.

The command sets `persistLock: true`, so it is the normal path that writes
`cts.lock`.

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

Each test file runs in a real child process using a hidden sentinel flag. This
keeps process and signal behavior closer to normal runtime behavior than a
worker-only runner.
