import { os, console } from '../cts/src/utils';
import { version } from './version';

const isTTY = os.guessHandle(os.STDIN_FILENO) == 'tty';

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
  ${C.cyan('run')}    ${C.cyan('<file>')} [args…]   Run a TypeScript/JavaScript file
  ${C.cyan('task')}   [name] [args…]      Run a task from ${C.cyan('deno.json')}
  ${C.cyan('eval')}   ${C.cyan('<code>')}            Evaluate inline code
  ${C.cyan('cache')}  ${C.cyan('<file>')}            Pre-download deps and write lock
  ${C.cyan('repl')}                       Start an interactive TypeScript REPL
  ${C.cyan('fmt')}    [paths…]            Format source files            ${C.dim('(not yet)')}
  ${C.cyan('lint')}   [paths…]            Lint source files              ${C.dim('(not yet)')}
  ${C.cyan('test')}   [paths…]            Run test files matching ${C.cyan('[._]test.[jt]sx?')}
  ${C.cyan('upgrade')}                    Update extensions / self       ${C.dim('(not yet)')}

  ${C.dim(`If the first argument is a file path, ${C.cyan('cno run')} is implied.`)}

${C.bold('COMMON OPTIONS')}
  ${C.cyan('--cache-dir')} <path>       Cache directory ${C.dim('(default: ~/.cts)')}
  ${C.cyan('--no-lock')}                Disable lock file
  ${C.cyan('--frozen')}                 Fail if any import is missing from lock
  ${C.cyan('--reload')}, ${C.cyan('-r')}             Bypass module cache
  ${C.cyan('--no-http')}                Disable http/https imports
  ${C.cyan('--no-jsr')}                 Disable jsr: imports
  ${C.cyan('--no-node')}                Disable Node.js compatibility
  ${C.cyan('--silent')}, ${C.cyan('-q')}             Suppress download progress
  ${C.cyan('--memory-limit')} <size>    e.g. ${C.cyan('256MB')}, ${C.cyan('1GB')}
  ${C.cyan('--max-stack-size')} <n>     e.g. ${C.cyan('4MB')}
  ${C.cyan('--version')}, ${C.cyan('-v')}            Print version
  ${C.cyan('--help')}, ${C.cyan('-h')}               Print this message

${C.bold('ENVIRONMENT')}
  ${C.cyan('CNO_POLYFILL')}             Path to a cno polyfill bundle (overrides built-in)
  ${C.cyan('CNO_EXT_PATH')}             Directory of native extensions (default: <cno-dir>/ext)
  ${C.cyan('CTS_CACHE_DIR')}            Override cache directory
  ${C.cyan('CTS_SILENT')}               Suppress output ${C.dim('(true/false)')}
  ${C.cyan('DEBUG')}                    Debug categories: ${C.cyan('resolver, npm, jsr, lock, cjs, loader, config, stack, http, http.conn, http.fetch, *')}
    `.trim());
}
