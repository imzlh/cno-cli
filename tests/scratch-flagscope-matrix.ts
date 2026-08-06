// SCRATCH — agent verification of per-subcommand flag scoping. Delete after use.
// Imports src/cli.ts by path so the uncompiled edit is exercised directly.
import { parseArgv, unknownFlags, isMisscopedFlag } from '../src/cli.ts';

const SUBCOMMANDS = ['run', 'task', 'eval', 'cache', 'pack', 'repl', 'exec', 'test', 'setup'] as const;

// Every flag in KNOWN_FLAGS, in the form a user types it.
const FLAGS: Array<[string, string]> = [
    ['--cache-dir', '=/c'], ['--lock-dir', '=/l'], ['--no-lock', ''], ['--frozen', ''],
    ['--disable-cache', ''], ['--no-http', ''], ['--no-jsr', ''], ['--no-node', ''],
    ['--no-oxc', ''], ['--ignore-scripts', ''], ['--npm-mode', '=soft'], ['--polyfill', '=/p'],
    ['--ext', '=js'], ['--cwd', '=/tmp'], ['--reload', ''], ['--precache', ''],
    ['--env', '=/e'], ['--env-file', '=/e'], ['--preload', '=/m'],
    ['--out', '=o.jspack'], ['--concurrency', '=2'], ['--filter', '=t'],
    ['--fail-fast', ''], ['--permit-no-files', ''], ['--location', '=http://x/'],
    ['--silent', ''], ['--print', ''], ['--system-proxy', ''], ['--skip-cert-verify', ''],
    ['--memory-limit', '=64MB'], ['--max-stack-size', '=4MB'],
    ['--inspect', ''], ['--inspect-brk', ''], ['--inspect-wait', ''],
    ['--require', '=/r'], ['--import', '=/i'], ['--loader', '=/h'],
    ['--allow-all', ''], ['--conditions', '=dev'], ['--max-old-space-size', '=64'],
    ['--v8-flags', '=--jitless'], ['--config', '=/c.json'], ['--cached-only', ''],
];

// A positional is needed for commands that require one; put flags FIRST so they
// are parsed as cno flags and not swallowed as script/task args.
const POSITIONAL: Record<string, string[]> = {
    run: ['main.ts'], eval: ['1+1'], cache: ['main.ts'], pack: ['main.ts'],
    task: ['build'], exec: ['tool'], test: [], repl: [], setup: [],
};

const rows: string[] = [];
const header = 'flag'.padEnd(22) + SUBCOMMANDS.map((c) => c.padEnd(7)).join('');
rows.push(header);
rows.push('-'.repeat(header.length));

let acceptCount = 0;
let rejectCount = 0;
for (const [flag, value] of FLAGS) {
    const cells: string[] = [];
    for (const cmd of SUBCOMMANDS) {
        const argv = [cmd, flag + value, ...(POSITIONAL[cmd] ?? [])];
        const cli = parseArgv(argv);
        const unknown = unknownFlags(cli);
        const rejected = unknown.length > 0;
        if (rejected) rejectCount++; else acceptCount++;
        // Distinguish a mis-scoped real flag from an entirely unknown one.
        const mark = !rejected ? 'ok' : (isMisscopedFlag(flag, cli.cmd) ? 'SCOPE' : 'UNK');
        cells.push(mark.padEnd(7));
    }
    rows.push(flag.padEnd(22) + cells.join(''));
}

console.log('=== SUBCOMMAND x FLAG MATRIX (ok = accepted, SCOPE = rejected as mis-scoped) ===');
console.log(rows.join('\n'));
console.log(`\naccepted=${acceptCount} rejected=${rejectCount} cells=${acceptCount + rejectCount}`);

// ---- Contract assertions from the expected-red test, re-run here directly ----
const CASES: Array<[string[], string[]]> = [
    [['repl', '--filter=xyz'], ['--filter']],
    [['repl', '--concurrency=9'], ['--concurrency']],
    [['repl', '--fail-fast'], ['--fail-fast']],
    [['repl', '--permit-no-files'], ['--permit-no-files']],
    [['eval', '--filter=x', '1+1'], ['--filter']],
    [['repl', '--out=x.jspack'], ['--out']],
    [['run', '--out=x', 'main.ts'], ['--out']],
    [['test', '--cwd=/tmp'], ['--cwd']],
    [['test', '--filter=t', '--fail-fast'], []],
    [['pack', 'main.ts', '--out=o.jspack'], []],
    [['task', 'build', '--cwd=/tmp'], []],
];
console.log('\n=== expected-red contract cases ===');
let pass = 0, fail = 0;
for (const [argv, want] of CASES) {
    const got = unknownFlags(parseArgv(argv));
    const okCase = JSON.stringify(got) === JSON.stringify(want);
    if (okCase) pass++; else fail++;
    console.log(`${okCase ? 'PASS' : 'FAIL'}  cno ${argv.join(' ')}  ->  ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}

// ---- Awkward cases ----
console.log('\n=== awkward cases ===');
const AWKWARD: Array<[string, string[]]> = [
    ['-- passthrough keeps script flags out of scope', ['run', 'main.ts', '--', '--filter=x']],
    ['flags AFTER the script path are script args', ['run', 'main.ts', '--out=x']],
    ['implicit run, flag after path is a script arg', ['main.ts', '--filter=x']],
    ['-e code that itself starts with a dash', ['-e', '-1+2']],
    ['--eval=code starting with a dash', ['--eval=-1+2']],
    ['-p print is eval-scoped and routes to eval', ['-p', '1+1']],
    ['--print under run is rejected (eval-only)', ['run', '--print', 'main.ts']],
    ['combined short flags are NOT split', ['run', '-rq', 'main.ts']],
    ['--flag=value form', ['test', '--filter=abc']],
    ['--flag value form', ['test', '--filter', 'abc']],
    ['permission flags on run', ['run', '--allow-net', '--allow-read=/tmp', 'main.ts']],
    ['permission flags on test', ['test', '--allow-net', '-A']],
    ['permission flags on eval', ['eval', '--allow-net', '1+1']],
    ['permission flags on repl', ['repl', '--allow-net']],
    ['flag before the subcommand is scoped to it', ['--filter=x', 'test']],
    ['flag before subcommand, wrong command', ['--out=x', 'main.ts']],
    ['task-only --cwd before the task name', ['task', '--cwd=/tmp', 'build']],
    ['unknown flag is still UNK not SCOPE', ['run', '--frobnicate', 'main.ts']],
    ['-h short help on any command', ['pack', '-h']],
    ['setup only takes --cache-dir', ['setup', '--cache-dir=/c']],
    ['setup rejects --filter', ['setup', '--filter=x']],
    ['exec forwards its own bin flags', ['exec', 'tool', '--tool-flag']],
];
for (const [label, argv] of AWKWARD) {
    const cli = parseArgv(argv);
    const u = unknownFlags(cli);
    console.log(`${(u.length === 0 ? 'accept' : 'REJECT').padEnd(7)} cmd=${String(cli.cmd).padEnd(8)} ${label}`);
    console.log(`        argv=${JSON.stringify(argv)}`);
    console.log(`        flags=${JSON.stringify(cli.flags)} positional=${JSON.stringify(cli.positional)} unknown=${JSON.stringify(u)}`);
}

console.log(`\nCONTRACT: ${pass} pass / ${fail} fail`);
