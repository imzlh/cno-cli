// Shared spawn helpers for the cli-stage suites: every case boots the real
// cno binary, so the suites stay split by topic to respect the runner's
// per-file timeout budget.
import { decodeUtf8 } from './bytes.ts';
import { concatChunks } from '../../cno/src/utils/bytes';

export async function runCno(args: string[], cwd?: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
        env: {
            CTS_SILENT: 'true',
            ...env,
        },
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

export async function runCnoWithInput(args: string[], input: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const child = new Deno.Command(execPath, {
        args,
        cwd,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
        env: {
            CTS_SILENT: 'true',
        },
    }).spawn();
    // Drain stdout/stderr while stdin is still being written: a child that
    // echoes more than the pipe buffer back before reading its stdin would
    // otherwise deadlock this harness (write blocks on a full pipe).
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>, sink: Uint8Array[]): Promise<void> => {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            sink.push(value);
        }
    };
    const stdoutReader = child.stdout.getReader();
    const stderrReader = child.stderr.getReader();
    const drainingOut = drain(stdoutReader, stdoutChunks);
    const drainingErr = drain(stderrReader, stderrChunks);
    const writer = child.stdin.getWriter();
    const inputWork = (async () => {
        await writer.write(new TextEncoder().encode(input));
        await writer.close();
    })();
    const statusTask = child.status;
    let ioFinished = false;
    let eofTimer: number | undefined;
    const eofGuard = statusTask.then(() => new Promise<never>((_resolve, reject) => {
        if (ioFinished) return;
        eofTimer = setTimeout(() => reject(new Error('child exited but stdio did not finish')), 1000);
    }));
    try {
        // Promise.all observes every rejection immediately while still failing
        // fast. If an uncontrolled descendant inherits an output pipe, the EOF
        // guard cancels our readers so the harness itself does not hang; this
        // helper owns and can terminate only the direct child.
        const [status] = await Promise.race([
            Promise.all([statusTask, inputWork, drainingOut, drainingErr]),
            eofGuard,
        ]);
        return {
            code: status.code,
            stdout: decodeUtf8(concatChunks(stdoutChunks)),
            stderr: decodeUtf8(concatChunks(stderrChunks)),
        };
    } catch (failure) {
        try { child.kill('SIGKILL'); } catch { /* child may already have exited */ }
        const cleanup = Promise.allSettled([
            statusTask,
            inputWork,
            drainingOut,
            drainingErr,
            Promise.resolve().then(() => stdoutReader.cancel(failure)),
            Promise.resolve().then(() => stderrReader.cancel(failure)),
            Promise.resolve().then(() => writer.abort(failure)),
        ]);
        let cleanupTimer: number | undefined;
        try {
            await Promise.race([
                cleanup,
                new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1000); }),
            ]);
        } finally {
            if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        }
        throw failure;
    } finally {
        ioFinished = true;
        if (eofTimer !== undefined) clearTimeout(eofTimer);
        stdoutReader.releaseLock();
        stderrReader.releaseLock();
        writer.releaseLock();
    }
}

export const ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
