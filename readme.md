# cno-cli

[![CI](https://github.com/imzlh/cno-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/imzlh/cno-cli/actions/workflows/ci.yml)

`cno` is a standalone runtime for TypeScript and JavaScript. It provides a
Deno-style command line, browser-friendly Web APIs, and practical compatibility
with Deno and Node.js code.

Use it to run a script without a separate build step, start a small server, run
tests and project tasks, or work with dependencies from npm, JSR, and remote
URLs.

> [!NOTE]
> cno is under active development. Compatibility is intentionally practical
> rather than complete, so code that depends on every detail of Deno or Node.js
> may still need changes. Bug reports and real-world examples are welcome.

## Highlights

- Runs TypeScript, TSX, JavaScript, JSX, ESM, and CommonJS.
- Resolves local files plus `npm:`, `jsr:`, `http:`, `https:`, `node:`, and
  `data:` imports.
- Includes familiar Web APIs such as `fetch`, streams, WebSocket, WebCrypto,
  workers, and `Deno.serve`.
- Provides many Deno APIs and Node.js built-in modules.
- Includes commands for tests, tasks, dependency caching, a REPL, debugging,
  servers, and portable `.jspack` bundles.
- Ships as a native executable; a Node.js or Deno installation is not required
  to run it.

## Install

Download the archive for your operating system and CPU from
[GitHub Releases](https://github.com/imzlh/cno-cli/releases/latest), then extract
the whole archive.

Keep the included `ext/` directory, and `lib/` when present, next to the `cno`
executable. Some release variants use files from those directories at runtime.
Add the extracted directory to `PATH` if you want to call `cno` from anywhere.

Check the installation and prepare the Node.js compatibility files:

```sh
cno --version
cno setup
```

On Windows, use `cno.exe` if the extracted directory is not yet on `PATH`.

## Quick Start

Create `hello.ts`:

```ts
const name: string = Deno.args[0] ?? "world";
console.log(`Hello, ${name}!`);
```

Run it directly:

```sh
cno hello.ts cno
# Hello, cno!
```

`run` is optional when the first argument is a file path:

```sh
cno run hello.ts cno
cno hello.ts cno
```

Evaluate a short expression or open the interactive REPL:

```sh
cno eval 'console.log(6 * 7)'
cno repl
```

## Imports And Dependencies

Imports can use familiar Deno- and Node-style specifiers:

```ts
import { join } from "node:path";
import packageJson from "./package.json" with { type: "json" };

console.log(join(packageJson.name, "cache"));
```

npm and JSR packages can be imported without manually creating a
`node_modules` directory:

```ts
import leftPad from "npm:left-pad@1.3.0";
import { Hono } from "jsr:@hono/hono@4.12.27";
```

Prepare dependencies ahead of time and write the resolution cache with:

```sh
cno cache app.ts
```

Running `cno cache` without a file reads dependencies from `deno.json` and
`package.json`. If a tool requires a physical `node_modules` tree, use
`--npm-mode=soft` or `--npm-mode=hard` with the cache command.

## Run A Server

A module whose default export contains a `fetch` function can be served
directly:

```ts
export default {
  fetch(request: Request): Response {
    return new Response(`Hello from ${new URL(request.url).pathname}`);
  },
};
```

```sh
cno serve --port=8000 server.ts
```

## Tests And Tasks

cno runs tests declared with `Deno.test` and discovers files such as
`example.test.ts` and `example_test.ts`:

```ts
import { strictEqual } from "node:assert";

Deno.test("addition", () => {
  strictEqual(20 + 22, 42);
});
```

```sh
cno test
cno test tests/
cno test --filter=addition
```

Tasks can come from `deno.json`, `deno.jsonc`, or `package.json`:

```sh
cno task
cno task dev
```

## Command Overview

| Command | Purpose |
| --- | --- |
| `cno <file> [args...]` | Run a TypeScript or JavaScript file |
| `cno run <file> [args...]` | Run a file explicitly |
| `cno serve <file>` | Serve a module's default `fetch` export |
| `cno eval <code>` | Evaluate inline code |
| `cno repl` | Start an interactive TypeScript REPL |
| `cno test [paths...]` | Run test files |
| `cno task [name]` | Run a project task |
| `cno cache [file]` | Prepare dependencies and update `cts.lock` |
| `cno exec <bin> [args...]` | Run an npm package binary, similar to `pnpx` |
| `cno pack <file>` | Package an entry and its dependencies as `.jspack` |
| `cno setup` | Install or refresh Node.js compatibility files |

Useful options include:

| Option | Purpose |
| --- | --- |
| `--reload` / `--precache` | Prepare the dependency graph before running |
| `--cached-only` | Refuse network downloads |
| `--frozen` | Fail when an import is missing from `cts.lock` |
| `--no-http`, `--no-jsr`, `--no-node` | Disable selected import sources |
| `--cache-dir=<path>` | Choose another cache directory |
| `--inspect`, `--inspect-brk` | Start the Chrome DevTools debugger; place before the command |
| `--memory-limit=<size>` | Set a runtime memory limit; place before the command |

Run `cno --help` for the complete command and option reference.

## Compatibility And Security

cno aims to run useful Deno, Node.js, and Web-platform code, but it is not a
complete replacement for any of those runtimes. In particular:

- Some APIs and Node.js built-in modules are only partially implemented.
- npm packages that rely on native addons, an exact `node_modules` layout, or
  subtle Node.js behavior may not work yet.
- Optional native features can vary by release and platform.

> [!WARNING]
> cno does not currently provide Deno's permission sandbox. Permission flags
> such as `--allow-read` and `--deny-net` are accepted for command-line
> compatibility but are not enforced. Do not use them as a security boundary,
> and do not run untrusted code.

See [Compatibility](docs/compatibility.md) for current support boundaries and
[CLI](docs/cli.md) for detailed command behavior.

## Build From Source

Most users should use a release archive. To build cno yourself, first install a
C/C++ toolchain, CMake, pnpm, and the platform libraries listed in the
[build guide](docs/build-test.md). Rust is optional and enables the faster OXC
TypeScript transformer.

Clone the repository with its submodules and install the JavaScript
dependencies:

```sh
git clone --recurse-submodules https://github.com/imzlh/cno-cli.git
cd cno-cli
pnpm install --frozen-lockfile
pnpm --dir cno install --frozen-lockfile
pnpm --dir cts install --frozen-lockfile
```

Build on Linux or macOS:

```sh
./build.sh
```

Build on Windows from PowerShell:

```powershell
.\build.ps1
```

The assembled files are written to `dist/exe/`. For platform-specific setup,
manual CMake commands, and validation steps, read
[Building and testing](docs/build-test.md).

## Contributing

Issues and pull requests are welcome. When reporting a runtime problem, include
`cno --version`, your operating system and CPU architecture, and a small
reproduction when possible.

Development documentation is collected in the
[documentation index](docs/README.md).

## License

MIT
