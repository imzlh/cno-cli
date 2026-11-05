// Shared spawn helpers for the cli-stage suites: every case boots the real
// cno binary, so the suites stay split by topic to respect the runner's
// per-file timeout budget.
import { decodeUtf8 } from './bytes.ts';

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
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const output = await child.output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

export const ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
