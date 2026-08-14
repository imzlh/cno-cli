import { version } from './version';

const os = import.meta.use('os');
const console = import.meta.use('console');

// Colour decision must follow the stream we write to (stdout), not stdin —
// `cno --help > file` used to embed ANSI escapes.
const isTTY = os.guessHandle(os.STDOUT_FILENO) == 'tty';

const C = {
    bold:  (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
    cyan:  (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
    dim:   (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
    green: (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
    warn:  (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
    red:   (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
};

export { C, isTTY };

export function showVersion(): void {
    console.log(`cno ${version}`);
}

export function showHelp(): void {
    console.log(`
${C.bold('cno')} v${version} — Deno-compatible TypeScript runtime on circu.js

${C.bold('USAGE')}
  ${C.cyan('cno')} [command] [options] [args…]

${C.bold('COMMANDS')}
  ${C.cyan('run')}    ${C.cyan('<file|task>')} [args…]     Run a TypeScript/JavaScript file or package script
  ${C.cyan('serve')}  ${C.cyan('<file>')} [args…]           Serve the entrypoint's default.fetch export
  ${C.cyan('task')}   [name] [args…]          Run a task from ${C.cyan('deno.json')} or ${C.cyan('package.json')}
  ${C.cyan('exec')}   ${C.cyan('<command>')} [args…]       Run an npm package binary, same as pnpx
  ${C.cyan('eval')}   ${C.cyan('<code>')}                  Evaluate inline code
  ${C.cyan('cache')}  ${C.cyan('<file>')}                  Pre-download deps and write lock
  ${C.cyan('pack')}   ${C.cyan('<file>')} [-o ${C.dim('<out.jspack>')}]     Pack an entry and its deps into a portable ${C.cyan('.jspack')} container
  ${C.cyan('repl')}                           Start an interactive TypeScript REPL
  ${C.cyan('setup')}                          Install NodeJS modules. Please run in cno repo dir
  ${C.cyan('test')}   [paths…]                Run test files matching ${C.cyan('[._]test.[jt]sx?')}

  ${C.dim(`If the first argument is a file path, ${C.cyan('cno run')} is implied.`)}

${C.bold('COMMON OPTIONS')}
  ${C.cyan('--cache-dir')}=${C.dim('<path>')}             Cache directory ${C.dim('(default: ~/.cts)')}
  ${C.cyan('--lock-dir')}=${C.dim('<path>')}              Override the ${C.cyan('cts.lock')} directory
  ${C.cyan('--no-lock')}                      Disable lock file
  ${C.cyan('--frozen')}                       Fail if any import is missing from lock
  ${C.cyan('--reload')}, ${C.cyan('-r')}                   Pre-cache the dependency graph ${C.dim('(alias of --precache; does NOT invalidate the cache)')}
  ${C.cyan('--precache')}                     Pre-cache the entry's dependency graph first
  ${C.cyan('--disable-cache')}                Disable compiled-bytecode caching ${C.dim('(fetched sources are still cached)')}
  ${C.cyan('--cached-only')}                  Refuse network downloads
  ${C.cyan('--no-http')}                      Disable http/https imports
  ${C.cyan('--no-jsr')}                       Disable jsr: imports
  ${C.cyan('--no-node')}                      Disable Node.js compatibility
  ${C.cyan('--no-oxc')}                       Disable OXC native acceleration
  ${C.cyan('--silent')}, ${C.cyan('-q')}                   Suppress download progress
  ${C.cyan('--memory-limit')}=${C.dim('<size>')}          e.g. ${C.cyan('256MB')}, ${C.cyan('1GB')}
  ${C.cyan('--max-stack-size')}=${C.dim('<n>')}           e.g. ${C.cyan('4MB')}
  ${C.cyan('--polyfill')}=${C.dim('<path>')}              Custom polyfill bundle
  ${C.cyan('--npm-mode')}=${C.dim('<normal|soft|hard>')}  Materialize node_modules on ${C.cyan('cno cache')} ${C.dim('(soft: top-level links, hard: full tree, default: normal)')}
  ${C.cyan('--ignore-scripts')}               Skip npm lifecycle scripts on ${C.cyan('cno cache')}

${C.bold('RUN OPTIONS')}
  ${C.cyan('--ext')}=${C.dim('<lang>')}                   Language for an extensionless entry or ${C.cyan('-')} ${C.dim('(default: ts)')}
  ${C.cyan('--env')}, ${C.cyan('--env-file')}=${C.dim('<path>')}       Load an env file before the entry ${C.dim('(repeatable)')}
  ${C.cyan('--preload')}=${C.dim('<module>')}             Evaluate a module before the entry ${C.dim('(repeatable)')}
  ${C.cyan('--require')}, ${C.cyan('--import')}=${C.dim('<module>')}   Node-style preload ${C.dim('(also read from')} ${C.cyan('NODE_OPTIONS')}${C.dim(')')}
  ${C.cyan('--location')}=${C.dim('<url>')}               Value for ${C.cyan('globalThis.location')}
  ${C.cyan('--conditions')}=${C.dim('<list>')}, ${C.cyan('-C')} ${C.dim('<list>')}  Extra package.json export conditions
  ${C.dim(`Use ${C.cyan('-')} as the entry to read the program from stdin.`)}

${C.bold('SERVE OPTIONS')}
  ${C.cyan('--port')}=${C.dim('<n>')}                  Listening port ${C.dim('(default: 8000)')}
  ${C.cyan('--host')}=${C.dim('<hostname>')}           Listening hostname ${C.dim('(default: 0.0.0.0)')}

${C.bold('EVAL OPTIONS')}
  ${C.cyan('--eval')}, ${C.cyan('-e')} ${C.dim('<code>')}              Evaluate inline code
  ${C.cyan('--print')}, ${C.cyan('-p')} ${C.dim('<expr>')}             Evaluate and print the result

${C.bold('TEST OPTIONS')}
  ${C.cyan('--filter')}=${C.dim('<substr>')}              Only run tests whose name matches
  ${C.cyan('--concurrency')}=${C.dim('<n>')}              Test files in parallel ${C.dim('(default: 4)')}
  ${C.cyan('--fail-fast')}                    Stop at the first failure ${C.dim('(forces serial)')}
  ${C.cyan('--permit-no-files')}              Exit 0 when no test file matches
  ${C.dim(`Everything after ${C.cyan('--')} reaches the test files as ${C.cyan('Deno.args')}.`)}

${C.bold('TASK OPTIONS')}
  ${C.cyan('--cwd')}=${C.dim('<path>')}                   Directory to run the task in ${C.dim('(task only; ignored elsewhere)')}

${C.bold('PACK OPTIONS')}
  ${C.cyan('--out')}, ${C.cyan('-o')} ${C.dim('<file.jspack>')}        Container output path ${C.dim('(see')} ${C.cyan('cno pack --help')}${C.dim(')')}

${C.bold('DENO COMPATIBILITY')}
  ${C.cyan('--allow-*')}, ${C.cyan('--deny-*')}, ${C.cyan('-A')}        Accepted and ignored — cno grants everything
  ${C.cyan('--unstable-*')}, ${C.cyan('--check')}, ${C.cyan('--config')} Accepted and ignored ${C.dim('(cts uses its own config)')}

${C.bold('NETWORK')}
  ${C.cyan('--system-proxy')}                 Use a configured proxy for fetch, WebSocket and EventSource
  ${C.dim('                                 Env vars win over the Windows registry, per scheme:')}
  ${C.dim(`                                 ${C.cyan('HTTP_PROXY')}, ${C.cyan('HTTPS_PROXY')}, ${C.cyan('ALL_PROXY')}, ${C.cyan('NO_PROXY')} (lowercase too)`)}
  ${C.cyan('--skip-cert-verify')}             Disable TLS certificate verification

${C.bold('DEBUGGER OPTIONS')}
  ${C.cyan('--inspect')}${C.dim('[=host:port]')}          Start CDP inspector (default port: 9229)
  ${C.cyan('--inspect-brk')}${C.dim('[=host:port]')}      Start CDP inspector and break on first line
  ${C.cyan('--inspect-wait')}${C.dim('[=host:port]')}     Start CDP inspector and wait for DevTools to connect

${C.bold('META')}
  ${C.cyan('--version')}, ${C.cyan('-v')}                  Print version
  ${C.cyan('--help')}, ${C.cyan('-h')}                     Print this message

${C.bold('ENVIRONMENT')}
  ${C.cyan('CTS_EXT_PATH')}                   Directory of native extensions (default: <cno-dir>/ext)
  ${C.cyan('CTS_CACHE_DIR')}                  Override cache directory
  ${C.cyan('CTS_LOCK_DIR')}                   Override the ${C.cyan('cts.lock')} directory
  ${C.cyan('CTS_SILENT')}                     Suppress output ${C.dim('(true/false)')}
  ${C.cyan('CTS_DISABLE_CACHE')}              Disable module caching ${C.dim('(true/false)')}
  ${C.cyan('CTS_ENABLE_HTTP')}/${C.cyan('_JSR')}/${C.cyan('_NODE')}      Toggle each protocol ${C.dim('(true/false)')}
  ${C.cyan('CTS_NO_OXC')}                     Disable OXC acceleration ${C.dim('(true/false)')}
  ${C.cyan('CTS_MEMORY_LIMIT')}               e.g. ${C.cyan('1GB')}
  ${C.cyan('CTS_MAX_STACK_SIZE')}             e.g. ${C.cyan('4MB')}
  ${C.cyan('CTS_WORKERS')}                    Precompile worker count ${C.dim('(0 = inline)')}
  ${C.cyan('NODE_OPTIONS')}                   Node preload flags, applied before CLI ones
  ${C.cyan('NPM_CONFIG_REGISTRY')}, ${C.cyan('NPM_TOKEN')}   npm registry URL and auth token
  ${C.cyan('DEBUG')}                          Debug categories: ${C.cyan('resolver, npm, jsr, lock, cjs, loader, config, stack, http, http.conn, http.fetch, debug, *')}
    `.trim());
}
