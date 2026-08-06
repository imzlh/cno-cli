/**
 * REPL stdio redirection: all four {pipe,file} x {pipe,file} combinations.
 *
 * `streams` has no file-backed handle class, so the REPL used to treat
 * "not a tty" as "must be a pipe" and called `Pipe.open(fd)` unconditionally.
 * libuv rejects a regular-file handle in `uv_pipe_open()`, so redirecting
 * either end of the REPL to a plain file killed the process before the banner:
 *
 *   cno repl > out.txt   ->  rc=1  ENOTSOCK: socket operation on non-socket
 *   cno repl < in.txt    ->  rc=1  EINVAL: invalid argument
 *
 * `node --interactive` runs and exits 0 in all four combinations, which is the
 * contract pinned here. The wrong part was not just the crash: every REPL EOF
 * path returned a clean, plausible, wrong rc=1 whenever stdout was a file, so
 * anything measuring REPL exit codes with `> out.txt` got a false answer.
 *
 * Redirection is done by a generated script rather than by `Deno.Command`,
 * because this runtime has no way to hand a child a file-backed stdio slot:
 * `stdout` accepts only piped/inherit/null, and numeric-fd stdio is explicitly
 * refused (`node:child_process` assertRedirectableFd).
 */
import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

const SESSION = '1+1\n.exit\n';

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, '');
}

/** Collapse \r overwrites the way a terminal would, so text is assertable. */
function flattenCarriageReturns(value: string): string {
    return value.split('\n').map((line) => line.replace(/.*\r/, '')).join('\n');
}

function countEscapes(value: string): number {
    return (value.match(/\x1b\[/g) ?? []).length;
}

interface ReplRun {
    code: number;
    stdout: string;
    stderr: string;
    rawStdoutBytes: number;
}

/**
 * Run `cno repl` with stdin and stdout each either a pipe or a plain file.
 *
 * The generated script redirects only the slots that must be files; the rest
 * are inherited from the spawned shell, whose own slots are the pipes that
 * `Deno.Command` set up.
 */
async function runRepl(
    dir: string,
    stdinKind: 'pipe' | 'file',
    stdoutKind: 'pipe' | 'file',
): Promise<ReplRun> {
    const exe = Deno.execPath().replace(/ \(deleted\)$/, '');
    const inPath = join(dir, `in-${stdinKind}-${stdoutKind}.txt`);
    const outPath = join(dir, `out-${stdinKind}-${stdoutKind}.txt`);
    Deno.writeTextFileSync(inPath, SESSION);

    const redirIn = stdinKind === 'file' ? ` < "${inPath}"` : '';
    const redirOut = stdoutKind === 'file' ? ` > "${outPath}"` : '';
    const win = Deno.build.os === 'windows';

    let argv: string[];
    if (win) {
        const bat = join(dir, `run-${stdinKind}-${stdoutKind}.bat`);
        Deno.writeTextFileSync(bat, `@echo off\r\n"${exe}" repl${redirIn}${redirOut}\r\n`);
        argv = ['cmd.exe', '/d', '/s', '/c', bat];
    } else {
        const sh = join(dir, `run-${stdinKind}-${stdoutKind}.sh`);
        Deno.writeTextFileSync(sh, `#!/bin/sh\n"${exe}" repl${redirIn}${redirOut}\n`);
        argv = ['sh', sh];
    }

    const child = new Deno.Command(argv[0]!, {
        args: argv.slice(1),
        stdin: stdinKind === 'pipe' ? 'piped' : 'null',
        stdout: 'piped',
        stderr: 'piped',
        env: { CTS_SILENT: 'true' },
    }).spawn();

    if (stdinKind === 'pipe') {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(SESSION));
        await writer.close();
    }

    const output = await child.output();
    const piped = new TextDecoder().decode(output.stdout);
    const raw = stdoutKind === 'file' ? Deno.readTextFileSync(outPath) : piped;

    return {
        code: output.code,
        stdout: stripAnsi(flattenCarriageReturns(raw)),
        stderr: stripAnsi(flattenCarriageReturns(new TextDecoder().decode(output.stderr))),
        rawStdoutBytes: raw.length,
    };
}

const COMBOS: Array<{ stdin: 'pipe' | 'file'; stdout: 'pipe' | 'file' }> = [
    { stdin: 'pipe', stdout: 'pipe' },
    { stdin: 'pipe', stdout: 'file' },
    { stdin: 'file', stdout: 'pipe' },
    { stdin: 'file', stdout: 'file' },
];

for (const combo of COMBOS) {
    Deno.test({
        name: `repl stdio: stdin=${combo.stdin} stdout=${combo.stdout} evaluates and exits 0`,
        timeout: 30000,
    }, async () => {
        await withTempDir(`repl-stdio-${combo.stdin}-${combo.stdout}`, async (dir) => {
            const run = await runRepl(dir, combo.stdin, combo.stdout);
            const all = `${run.stdout}\n${run.stderr}`;

            // The two crashes this test exists for.
            ok(
                !all.includes('ENOTSOCK'),
                `stdout=${combo.stdout} regressed to Pipe.open on a file handle (ENOTSOCK): ${all.slice(0, 300)}`,
            );
            ok(
                !all.includes('EINVAL'),
                `stdin=${combo.stdin} regressed to Pipe.open on a file handle (EINVAL): ${all.slice(0, 300)}`,
            );
            ok(
                !all.includes('Uncaught'),
                `repl died before the prompt: ${all.slice(0, 300)}`,
            );

            strictEqual(run.code, 0, `expected rc=0 like node --interactive, got ${run.code}: ${all.slice(0, 300)}`);
            ok(run.stdout.includes('cno REPL'), `banner missing from stdout: ${JSON.stringify(run.stdout.slice(0, 200))}`);
            // `1+1` must actually have been read, evaluated and printed.
            ok(/(^|\W)2(\W|$)/.test(run.stdout), `evaluated result missing: ${JSON.stringify(run.stdout.slice(0, 200))}`);
        });
    });
}

/**
 * The non-TTY re-render guard in runner.ts `#update()` must stay in force for
 * every non-TTY combination, files included. Before that guard a piped 48-char
 * line emitted 3764 bytes / 506 escape sequences; the caps here sit far below
 * that and far above the ~75-400 bytes / 2-56 escapes a correct run produces,
 * so this catches a re-introduced echo storm without pinning an exact count.
 */
Deno.test({ name: 'repl stdio: no escape storm on any non-TTY combination', timeout: 60000 }, async () => {
    await withTempDir('repl-stdio-storm', async (dir) => {
        for (const combo of COMBOS) {
            const run = await runRepl(dir, combo.stdin, combo.stdout);
            const label = `stdin=${combo.stdin} stdout=${combo.stdout}`;
            // Without this the test passes vacuously: a REPL that dies before
            // the banner writes 0 bytes, which trivially satisfies any cap.
            strictEqual(run.code, 0, `${label}: repl did not run, so the byte budget proves nothing`);
            ok(run.stdout.includes('cno REPL'), `${label}: no banner, so the byte budget proves nothing`);
            ok(
                run.rawStdoutBytes < 1500,
                `${label}: ${run.rawStdoutBytes} bytes for a 2-line session — echo storm is back`,
            );
            const escapes = countEscapes(
                combo.stdout === 'file'
                    ? Deno.readTextFileSync(join(dir, `out-${combo.stdin}-${combo.stdout}.txt`))
                    : run.stdout,
            );
            ok(escapes < 150, `${label}: ${escapes} escape sequences — echo storm is back`);
        }
    });
});
