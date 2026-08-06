/**
 * child_process: stdio configurations, encoding/buffering, Windows signal
 * reality, and argument/env quoting.
 *
 * Every expectation here was measured against real Node v24.18.0 on Windows 11
 * before being written down; where cno cannot match Node the test pins the
 * honest behaviour and says so.
 */
import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert';
import { spawn, spawnSync, execFile, fork } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { withTempDir } from '../_helpers/temp.ts';

const isWindows = Deno.build.os === 'windows';

/** Child that writes the 256 byte values 0x00..0xff to stdout. */
const BYTES256 = 'const b=Buffer.alloc(256);for(let i=0;i<256;i++)b[i]=i;require("fs").writeSync(1,b);';

function scriptIn(dir: string, name: string, body: string): string {
    const p = join(dir, name);
    fs.writeFileSync(p, body + '\n');
    return p;
}

// ── encoding ────────────────────────────────────────────────────────────────

// The encodings TextDecoder rejects. Routing decodeOutput through it made the
// exec/execFile callback throw inside the 'close' handler after collectOutput had
// already marked itself settled, so the callback was NEVER invoked: a permanent
// hang, not an error. Measured: no callback after 6s for each of these.
for (const encoding of ['binary', 'hex', 'base64', 'base64url'] as const) {
    Deno.test({ name: `child_process: execFile encoding '${encoding}' invokes its callback`, timeout: 20000 }, async () => {
        await withTempDir('cp-enc', async (dir) => {
            const script = scriptIn(dir, 'b.js', BYTES256);
            const result = await new Promise<{ type: string; len: number }>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`callback never fired for encoding '${encoding}'`)), 15000);
                execFile(process.execPath, [script], { encoding }, (err, stdout) => {
                    clearTimeout(timer);
                    if (err) { reject(err); return; }
                    resolve({ type: typeof stdout, len: (stdout as string).length });
                });
            });
            strictEqual(result.type, 'string');
            // Measured lengths on Node v24.18 for 256 input bytes.
            const expected: Record<string, number> = { binary: 256, hex: 512, base64: 344, base64url: 342 };
            strictEqual(result.len, expected[encoding]);
        });
    });
}

Deno.test({ name: 'child_process: execFile with an unknown encoding yields a Buffer, not a hang', timeout: 20000 }, async () => {
    await withTempDir('cp-enc', async (dir) => {
        const script = scriptIn(dir, 'b.js', BYTES256);
        // Node does not throw for an encoding Buffer cannot use here — it falls
        // back to the raw Buffer (measured on v24.18).
        const stdout = await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('callback never fired for unknown encoding')), 15000);
            execFile(process.execPath, [script], { encoding: 'bogus-enc' as BufferEncoding }, (err, out) => {
                clearTimeout(timer);
                if (err) { reject(err); return; }
                resolve(out);
            });
        });
        ok(Buffer.isBuffer(stdout), `expected a Buffer, got ${typeof stdout}`);
        strictEqual((stdout as Buffer).length, 256);
    });
});

Deno.test({ name: "child_process: encoding 'ascii' masks high bytes to 0x7f, not U+FFFD", timeout: 20000 }, async () => {
    await withTempDir('cp-enc', async (dir) => {
        const script = scriptIn(dir, 'b.js', BYTES256);
        const r = spawnSync(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'ascii' });
        strictEqual(typeof r.stdout, 'string');
        const s = r.stdout as string;
        strictEqual(s.length, 256);
        // Node's ascii is byte & 0x7f, so 0x80 -> 0, 0x81 -> 1 ... (measured).
        // Decoding through TextDecoder produced U+FFFD (65533) for every byte
        // >= 0x80 instead — silent corruption of half the byte range.
        const codes: number[] = [];
        for (let i = 0x80; i <= 0x8f; i++) codes.push(s.charCodeAt(i));
        deepStrictEqual(codes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    });
});

Deno.test({ name: "child_process: encoding 'latin1' is byte identity across 0x80-0xff", timeout: 20000 }, async () => {
    await withTempDir('cp-enc', async (dir) => {
        const script = scriptIn(dir, 'b.js', BYTES256);
        const r = spawnSync(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'latin1' });
        const s = r.stdout as string;
        strictEqual(s.length, 256);
        // latin1 must NOT be cp1252: TextDecoder('latin1') maps 0x93 to U+201C.
        for (let i = 0x80; i <= 0xff; i++) {
            strictEqual(s.charCodeAt(i), i, `latin1 byte 0x${i.toString(16)} decoded to U+${s.charCodeAt(i).toString(16)}`);
        }
    });
});

Deno.test({ name: 'child_process: spawnSync throws ERR_UNKNOWN_ENCODING for an unusable encoding', timeout: 20000 }, () => {
    // Measured on Node v24.18: spawnSync throws, it does not report through
    // result.error. Previously this returned a codeless error with stdout
    // undefined, so the output was simply lost with no usable code to branch on.
    throws(
        () => spawnSync(process.execPath, ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'bogus-enc' as BufferEncoding }),
        (err: NodeJS.ErrnoException) => err.code === 'ERR_UNKNOWN_ENCODING',
    );
});

for (const encoding of ['hex', 'base64'] as const) {
    Deno.test({ name: `child_process: spawnSync encoding '${encoding}' returns the encoded string`, timeout: 20000 }, () => {
        const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("O")'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding,
        });
        strictEqual(r.status, 0);
        strictEqual(r.stdout, encoding === 'hex' ? '4f' : 'Tw==');
    });
}

// ── binary fidelity ─────────────────────────────────────────────────────────

Deno.test({ name: 'child_process: all 256 byte values survive a stdout pipe', timeout: 20000 }, async () => {
    await withTempDir('cp-bin', async (dir) => {
        const script = scriptIn(dir, 'b.js', BYTES256);
        const got = await new Promise<Buffer>((resolve, reject) => {
            const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
            const chunks: Buffer[] = [];
            child.stdout?.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
            child.on('error', reject);
            child.on('close', () => resolve(Buffer.concat(chunks)));
        });
        strictEqual(got.length, 256);
        for (let i = 0; i < 256; i++) strictEqual(got[i], i, `byte ${i} came back as ${got[i]}`);
    });
});

Deno.test({ name: 'child_process: all 256 byte values survive a stdin pipe', timeout: 20000 }, async () => {
    await withTempDir('cp-bin', async (dir) => {
        const script = scriptIn(dir, 'echo.js',
            'const c=[];process.stdin.on("data",(d)=>c.push(d));'
            + 'process.stdin.on("end",()=>{process.stdout.write(Buffer.concat(c).toString("hex"));});');
        const input = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) input[i] = i;
        const hex = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'ignore'] });
            let out = '';
            child.stdout?.on('data', (d) => { out += String(d); });
            child.on('error', reject);
            child.on('close', () => resolve(out));
            child.stdin?.end(input);
        });
        strictEqual(hex, input.toString('hex'));
    });
});

Deno.test({ name: 'child_process: a multi-byte char split across reads is not corrupted', timeout: 20000 }, async () => {
    await withTempDir('cp-bin', async (dir) => {
        // Writes the 3 bytes of U+20AC one at a time with gaps, so the parent
        // necessarily reads a partial sequence.
        const script = scriptIn(dir, 'split.js',
            'const fs=require("fs");const e=Buffer.from("\\u20ac");'
            + 'fs.writeSync(1,e.subarray(0,1));'
            + 'setTimeout(()=>{fs.writeSync(1,e.subarray(1,2));'
            + 'setTimeout(()=>{fs.writeSync(1,e.subarray(2,3));},60);},60);');
        const joined = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
            child.stdout?.setEncoding('utf8');
            const parts: string[] = [];
            child.stdout?.on('data', (d) => parts.push(String(d)));
            child.on('error', reject);
            child.on('close', () => resolve(parts.join('')));
        });
        strictEqual(joined, '€');
    });
});

// ── maxBuffer ───────────────────────────────────────────────────────────────

Deno.test({ name: 'child_process: maxBuffer exceeded on stdout reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER', timeout: 20000 }, async () => {
    await withTempDir('cp-mb', async (dir) => {
        const script = scriptIn(dir, 'big.js', 'require("fs").writeSync(1,Buffer.alloc(100000,0x61));');
        const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
            execFile(process.execPath, [script], { maxBuffer: 100 }, (e) => resolve(e as NodeJS.ErrnoException));
        });
        ok(err, 'expected a maxBuffer error');
        strictEqual(err?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        ok(/maxBuffer length exceeded/.test(err?.message ?? ''), err?.message);
    });
});

Deno.test({ name: 'child_process: maxBuffer exceeded on stderr reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER', timeout: 20000 }, async () => {
    await withTempDir('cp-mb', async (dir) => {
        const script = scriptIn(dir, 'bigerr.js', 'require("fs").writeSync(2,Buffer.alloc(100000,0x62));');
        const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
            execFile(process.execPath, [script], { maxBuffer: 100 }, (e) => resolve(e as NodeJS.ErrnoException));
        });
        ok(err, 'expected a maxBuffer error');
        strictEqual(err?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    });
});

Deno.test({ name: 'child_process: output exactly at maxBuffer is not an error', timeout: 20000 }, async () => {
    await withTempDir('cp-mb', async (dir) => {
        const script = scriptIn(dir, 'exact.js', 'require("fs").writeSync(1,Buffer.alloc(100,0x61));');
        const res = await new Promise<{ err: unknown; len: number }>((resolve) => {
            execFile(process.execPath, [script], { maxBuffer: 100 }, (err, stdout) => {
                resolve({ err, len: (stdout as string).length });
            });
        });
        strictEqual(res.err, null);
        strictEqual(res.len, 100);
    });
});

Deno.test({ name: 'child_process: a truncated maxBuffer capture never ends in a mangled character', timeout: 20000 }, async () => {
    await withTempDir('cp-mb', async (dir) => {
        // 6 bytes / 2 chars with maxBuffer 4. Node counts decoded units and keeps
        // both characters; cno counts bytes, so it keeps fewer — but it must never
        // emit U+FFFD from a cut made mid-sequence, which is what a raw byte
        // truncation produced.
        const script = scriptIn(dir, 'euro.js', 'require("fs").writeSync(1,Buffer.from("\\u20ac\\u20ac"));');
        const stdout = await new Promise<string>((resolve) => {
            execFile(process.execPath, [script], { maxBuffer: 4, encoding: 'utf8' }, (_e, out) => resolve(out as string));
        });
        ok(!stdout.includes('�'), `truncated capture contains U+FFFD: ${JSON.stringify(stdout)}`);
    });
});

Deno.test({ name: 'child_process: output well past the pipe buffer arrives whole', timeout: 30000 }, async () => {
    await withTempDir('cp-mb', async (dir) => {
        const N = 4 * 1024 * 1024;
        const script = scriptIn(dir, 'huge.js', `require("fs").writeSync(1,Buffer.alloc(${N},0x61));`);
        const out = await new Promise<Buffer>((resolve, reject) => {
            execFile(process.execPath, [script], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
                if (err) { reject(err); return; }
                resolve(stdout as unknown as Buffer);
            });
        });
        strictEqual(out.length, N);
        ok(out.every((b) => b === 0x61), 'payload was altered in transit');
    });
});

// ── stdio shapes ────────────────────────────────────────────────────────────

Deno.test({ name: 'child_process: an unrecognised stdio entry is rejected, not treated as inherit', timeout: 20000 }, () => {
    // Every unknown value used to fall through to 'inherit', so the child was
    // silently wired to the PARENT's console. Node throws ERR_INVALID_ARG_VALUE.
    for (const bad of [true, {}, 'nonsense'] as unknown[]) {
        throws(
            () => spawn(process.execPath, ['-e', '0'], { stdio: [bad, 'pipe', 'pipe'] as never }),
            (err: NodeJS.ErrnoException) => err.code === 'ERR_INVALID_ARG_VALUE',
            `stdio entry ${JSON.stringify(bad)} was accepted`,
        );
    }
    throws(
        () => spawn(process.execPath, ['-e', '0'], { stdio: 'nonsense' as never }),
        (err: NodeJS.ErrnoException) => err.code === 'ERR_INVALID_ARG_VALUE',
    );
});

Deno.test({ name: 'child_process: redirecting stdio 0/1/2 to another fd is refused, not silently misdirected', timeout: 20000 }, async () => {
    if (!isWindows) return;
    await withTempDir('cp-fd', async (dir) => {
        const logPath = join(dir, 'log.txt');
        const fd = fs.openSync(logPath, 'w');
        try {
            // The native SETUP_STDIO macro stringifies the value, so a number misses
            // the pipe/ignore comparisons and inherits the SLOT's default fd: the
            // measured result was that the child's output went to the parent's
            // console and this file stayed empty. Refusing is the honest behaviour
            // until the C side can take a real fd (reported).
            throws(
                () => spawn(process.execPath, ['-e', 'process.stdout.write("x")'], { stdio: ['ignore', fd, fd] }),
                (err: NodeJS.ErrnoException) => err.code === 'ERR_INVALID_ARG_VALUE',
            );
        } finally {
            fs.closeSync(fd);
        }
    });
});

Deno.test({ name: 'child_process: stdio [0,1,2] still means inherit the parent fds', timeout: 20000 }, async () => {
    // A number equal to its own slot index is the one numeric form that is
    // genuinely correct, so it must keep working.
    const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: [0, 1, 2] });
        strictEqual(child.stdout, null);
        strictEqual(child.stderr, null);
        child.on('error', reject);
        child.on('close', (c) => resolve(c));
    });
    strictEqual(code, 0);
});

Deno.test({ name: 'child_process: short and empty stdio arrays default the missing slots to pipe', timeout: 20000 }, async () => {
    for (const stdio of [[], ['pipe'], ['pipe', 'pipe'], [null, null, null], [undefined, undefined, undefined]] as never[]) {
        const out = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', 'process.stdout.write("O")'], { stdio });
            ok(child.stdout, `stdout missing for stdio ${JSON.stringify(stdio)}`);
            let acc = '';
            child.stdout?.on('data', (d) => { acc += String(d); });
            child.on('error', reject);
            child.on('close', () => resolve(acc));
        });
        strictEqual(out, 'O', `stdio ${JSON.stringify(stdio)}`);
    }
});

Deno.test({ name: 'child_process: extra fds beyond stderr are exposed by fd index and carry data', timeout: 20000 }, async () => {
    await withTempDir('cp-fd3', async (dir) => {
        const script = scriptIn(dir, 'fd3.js',
            'const fs=require("fs");fs.writeSync(3,"FROM3");fs.writeSync(4,"FROM4");process.stdout.write("done");');
        const res = await new Promise<{ out: string; got3: string; got4: string; len: number }>((resolve, reject) => {
            const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore', 'pipe', 'pipe'] });
            let out = '';
            let got3 = '';
            let got4 = '';
            child.stdout?.on('data', (d) => { out += String(d); });
            child.stdio[3]?.on('data', (d: unknown) => { got3 += String(d); });
            child.stdio[4]?.on('data', (d: unknown) => { got4 += String(d); });
            child.on('error', reject);
            child.on('close', () => resolve({ out, got3, got4, len: child.stdio.length }));
        });
        strictEqual(res.len, 5);
        strictEqual(res.out, 'done');
        strictEqual(res.got3, 'FROM3');
        strictEqual(res.got4, 'FROM4');
    });
});

Deno.test({ name: "child_process: 'overlapped' behaves as a pipe", timeout: 20000 }, async () => {
    const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', 'process.stdout.write("O")'], { stdio: 'overlapped' });
        ok(child.stdout, 'overlapped produced no stdout stream');
        let acc = '';
        child.stdout?.on('data', (d) => { acc += String(d); });
        child.on('error', reject);
        child.on('close', () => resolve(acc));
    });
    strictEqual(out, 'O');
});

Deno.test({ name: "child_process: 'ignore' gives null streams and 'inherit' gives null streams", timeout: 20000 }, () => {
    const ignored = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    strictEqual(ignored.stdin, null);
    strictEqual(ignored.stdout, null);
    strictEqual(ignored.stderr, null);
    ignored.kill('SIGKILL');

    const inherited = spawn(process.execPath, ['-e', '0'], { stdio: 'inherit' });
    strictEqual(inherited.stdin, null);
    strictEqual(inherited.stdout, null);
    strictEqual(inherited.stderr, null);
    inherited.kill('SIGKILL');
});

// ── signals / lifetime ──────────────────────────────────────────────────────

// Windows supports only SIGQUIT/SIGTERM/SIGKILL/SIGINT in libuv's uv__kill;
// everything else returns UV_ENOSYS. Node hides that by falling back to an
// unconditional terminate, so these all kill the child and report true
// (measured on Node v24.18/Windows). Without the fallback they returned false
// and left the child running — a leaked process on any kill('SIGHUP') path.
for (const signal of ['SIGHUP', 'SIGABRT', 'SIGBREAK', 'SIGWINCH', 1] as const) {
    Deno.test({ name: `child_process: kill(${JSON.stringify(signal)}) terminates the child on Windows`, timeout: 20000 }, async () => {
        if (!isWindows) return;
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
        await new Promise((r) => setTimeout(r, 350));
        const ret = child.kill(signal);
        const closed = await new Promise<{ code: number | null; sig: string | null }>((resolve) => {
            const timer = setTimeout(() => resolve({ code: -1, sig: 'TIMEOUT' }), 8000);
            child.on('close', (code, sig) => { clearTimeout(timer); resolve({ code, sig: sig as string | null }); });
        });
        strictEqual(ret, true, `kill(${String(signal)}) returned false`);
        ok(closed.sig !== 'TIMEOUT', `child survived kill(${String(signal)})`);
    });
}

Deno.test({ name: 'child_process: kill() with an unknown signal name throws ERR_UNKNOWN_SIGNAL', timeout: 20000 }, () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
        throws(
            () => child.kill('NOTASIGNAL'),
            (err: NodeJS.ErrnoException) => err.code === 'ERR_UNKNOWN_SIGNAL',
        );
    } finally {
        child.kill('SIGKILL');
    }
});

Deno.test({ name: 'child_process: kill() accepts a lowercase signal name like Node', timeout: 20000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise((r) => setTimeout(r, 300));
    // Node uppercases before lookup, so kill('sigterm') works (measured).
    const ret = child.kill('sigterm');
    const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000);
        child.on('close', () => { clearTimeout(timer); resolve(true); });
    });
    strictEqual(ret, true);
    ok(settled, 'child survived kill("sigterm")');
});

Deno.test({ name: 'child_process: kill() on an already-exited child returns false and leaves killed false', timeout: 20000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    await new Promise((r) => setTimeout(r, 120));
    // Capture BEFORE any further calls so a later kill cannot rewrite the result.
    const firstRet = child.kill();
    const killedAfterFirst = child.killed;
    const secondRet = child.kill();
    strictEqual(firstRet, false);
    strictEqual(killedAfterFirst, false);
    strictEqual(secondRet, false);
    strictEqual(child.exitCode, 3);
});

Deno.test({ name: 'child_process: kill(0) is a liveness probe that does not kill the child', timeout: 20000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},9000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise((r) => setTimeout(r, 350));
    const ret = child.kill(0);
    const killedFlag = child.killed;
    await new Promise((r) => setTimeout(r, 400));
    const stillAlive = child.exitCode === null && child.signalCode === null;
    child.kill('SIGKILL');
    strictEqual(ret, true);
    // Node DOES set `killed` for kill(0) — measured on v24.18: ret true,
    // killed true, and the child still alive. Only the "already killed" guard
    // must stay disarmed so a later real kill still goes through.
    strictEqual(killedFlag, true);
    ok(stillAlive, 'kill(0) terminated the child');
});

Deno.test({ name: 'child_process: kill(0) does not disarm a later real kill', timeout: 20000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise((r) => setTimeout(r, 350));
    child.kill(0);
    const realRet = child.kill('SIGTERM');
    const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000);
        child.on('close', () => { clearTimeout(timer); resolve(true); });
    });
    strictEqual(realRet, true);
    ok(settled, 'a real kill after kill(0) did not terminate the child');
});

Deno.test({ name: 'child_process: exitCode/signalCode reflect the exit shape', timeout: 30000 }, async () => {
    const clean = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise<void>((r) => clean.on('close', () => r()));
    strictEqual(clean.exitCode, 0);
    strictEqual(clean.signalCode, null);

    const failed = spawn(process.execPath, ['-e', 'process.exit(42)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise<void>((r) => failed.on('close', () => r()));
    strictEqual(failed.exitCode, 42);
    strictEqual(failed.signalCode, null);

    const signalled = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise((r) => setTimeout(r, 350));
    signalled.kill('SIGTERM');
    await new Promise<void>((r) => signalled.on('close', () => r()));
    // A signalled child has a null exit code and the signal name.
    strictEqual(signalled.exitCode, null);
    strictEqual(signalled.signalCode, 'SIGTERM');
});

Deno.test({ name: 'child_process: timeout + killSignal terminates the child', timeout: 30000 }, async () => {
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 700,
        killSignal: 'SIGKILL',
    });
    const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 12000);
        child.on('close', () => { clearTimeout(timer); resolve(true); });
    });
    const elapsed = Date.now() - started;
    ok(settled, 'timeout did not kill the child');
    ok(elapsed < 11000, `timeout took ${elapsed}ms`);
});

// ── fork / IPC ──────────────────────────────────────────────────────────────

Deno.test({ name: 'child_process: fork exposes child.channel with ref/unref', timeout: 20000 }, async () => {
    await withTempDir('cp-ipc', async (dir) => {
        const script = scriptIn(dir, 'echo.js', 'process.on("message",(m)=>process.send({echo:m}));process.send({ready:true});');
        const child = fork(script, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no ready message')), 9000);
                child.once('message', () => { clearTimeout(timer); resolve(); });
            });
            // child.channel.unref() is the documented way to stop the IPC channel
            // holding the parent open; libraries call it unguarded, and it was
            // missing entirely.
            const channel = Reflect.get(child, 'channel') as { ref?: unknown; unref?: unknown } | null;
            ok(channel, 'child.channel is missing');
            strictEqual(typeof channel?.ref, 'function');
            strictEqual(typeof channel?.unref, 'function');
        } finally {
            child.kill('SIGKILL');
        }
    });
});

Deno.test({ name: 'child_process: send() refuses a handle instead of silently dropping it', timeout: 20000 }, async () => {
    await withTempDir('cp-ipc', async (dir) => {
        const script = scriptIn(dir, 'echo.js', 'process.on("message",(m)=>process.send({echo:m}));process.send({ready:true});');
        const child = fork(script, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no ready message')), 9000);
                child.once('message', () => { clearTimeout(timer); resolve(); });
            });
            // Handle passing is not implemented. It used to return true while the
            // child's listener received `undefined` for the handle — silent loss.
            // Node's own code for a handle it cannot serialise is
            // ERR_INVALID_HANDLE_TYPE, thrown synchronously (measured).
            throws(
                () => (child as unknown as { send(m: unknown, h: unknown): boolean }).send({ x: 1 }, { notAHandle: true }),
                (err: NodeJS.ErrnoException) => err.code === 'ERR_INVALID_HANDLE_TYPE',
            );
            // A plain message still works.
            const echoed = await new Promise<unknown>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no echo')), 9000);
                child.once('message', (m) => { clearTimeout(timer); resolve(m); });
                child.send({ hello: 'world' });
            });
            deepStrictEqual(echoed, { echo: { hello: 'world' } });
        } finally {
            child.kill('SIGKILL');
        }
    });
});

Deno.test({ name: 'child_process: fork without ipc in stdio reports ERR_CHILD_PROCESS_IPC_REQUIRED', timeout: 20000 }, async () => {
    await withTempDir('cp-ipc', async (dir) => {
        const script = scriptIn(dir, 'noop.js', 'process.exit(0);');
        throws(
            () => fork(script, [], { stdio: ['pipe', 'pipe', 'pipe'] }),
            (err: NodeJS.ErrnoException) => err.code === 'ERR_CHILD_PROCESS_IPC_REQUIRED',
        );
    });
});

// ── argument and env quoting ────────────────────────────────────────────────

Deno.test({ name: 'child_process: hostile argument shapes reach the child verbatim', timeout: 60000 }, async () => {
    await withTempDir('cp-args', async (dir) => {
        const script = scriptIn(dir, 'args.js', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
        // Every one of these was verified byte-identical against Node v24.18 on
        // Windows; the backslash and quote forms are the classic quote_cmd_arg traps.
        const cases: string[][] = [
            ['a b'], ['a"b'], ['"'], ['a"b"c'], ['a\\b'], ['a\\'], ['a\\\\'], ['a\\\\\\'],
            ['a\\"b'], ['a b\\'], ['"a b"'], ['%PATH%'], ['%CNO_NOT_SET%'], ['a^b'], ['a&b'],
            ['a|b'], ['a>b<c'], ['a\nb'], ['a\r\nb'], ['a\tb'], [''], ['', 'z'], ['   '],
            ['café 日本 €'], ['a=b'], ['a;b'], ['*.txt'], ['--flag=va lue'],
            ["a'b"], ['a{b}c'], ['x'.repeat(256)], ['a"b\\c d\\\\"e%PATH%f'],
        ];
        for (const args of cases) {
            const r = spawnSync(process.execPath, [script, ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                encoding: 'utf8',
            });
            strictEqual(r.status, 0, `status for ${JSON.stringify(args)}: ${r.stderr}`);
            deepStrictEqual(JSON.parse(r.stdout as string), args, `argv mismatch for ${JSON.stringify(args)}`);
        }
    });
});

Deno.test({ name: 'child_process: env keys differing only in case are deduplicated on Windows', timeout: 20000 }, async () => {
    if (!isWindows) return;
    await withTempDir('cp-env', async (dir) => {
        const script = scriptIn(dir, 'envkeys.js',
            'const f=Object.keys(process.env).filter((k)=>k.toUpperCase().startsWith("CNOCASE"));'
            + 'const o={};for(const k of f)o[k]=process.env[k];process.stdout.write(JSON.stringify(o));');
        // Windows env lookup is case-insensitive, so a block holding both CNOCASE
        // and cnocase is malformed. Node sorts the keys and keeps the first of each
        // case-insensitive group, so the result is CNOCASE=upper whatever the
        // insertion order (measured). Passing all three through left the child
        // seeing three keys with an insertion-order-dependent value.
        for (const env of [
            { CNOCASE: 'upper', cnocase: 'lower', CnoCase: 'mixed' },
            { CnoCase: 'mixed', cnocase: 'lower', CNOCASE: 'upper' },
        ]) {
            const r = spawnSync(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env });
            strictEqual(r.status, 0);
            deepStrictEqual(JSON.parse(r.stdout as string), { CNOCASE: 'upper' }, `for env ${JSON.stringify(env)}`);
        }
    });
});

Deno.test({ name: 'child_process: spawnSync with an explicit env still gives the child PATH and SYSTEMROOT', timeout: 20000 }, async () => {
    if (!isWindows) return;
    await withTempDir('cp-env', async (dir) => {
        const script = scriptIn(dir, 'env.js',
            'const k=["PATH","SYSTEMROOT","TEMP","WINDIR"];const o={};'
            + 'for(const n of k)o[n]=Object.keys(process.env).some((e)=>e.toUpperCase()===n);'
            + 'process.stdout.write(JSON.stringify(o));');
        // libuv merges these from the parent on every spawn with an explicit env
        // (win/process.c required_vars). uv_spawn does it for the async path, but
        // the sync native entry point bypasses uv_spawn, so the child used to get
        // no PATH at all and a bare command name stopped resolving.
        for (const env of [{}, { OTHER: '1' }]) {
            const r = spawnSync(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env });
            strictEqual(r.status, 0, `status ${r.status} err=${r.error?.message ?? ''}`);
            const got = JSON.parse(r.stdout as string) as Record<string, boolean>;
            strictEqual(got.PATH, true, `PATH missing for env ${JSON.stringify(env)}`);
            strictEqual(got.SYSTEMROOT, true, `SYSTEMROOT missing for env ${JSON.stringify(env)}`);
        }
    });
});

Deno.test({ name: 'child_process: env null becomes the string "null" and undefined is dropped', timeout: 20000 }, async () => {
    await withTempDir('cp-env', async (dir) => {
        const script = scriptIn(dir, 'env2.js',
            'process.stdout.write(`${"A" in process.env}:${"B" in process.env}:${process.env.B}:${process.env.C}`);');
        // Measured on Node v24.18: A (undefined) is absent, B (null) is PRESENT as
        // the literal "null", C passes through.
        const r = spawnSync(process.execPath, [script], {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            env: { A: undefined, B: null, C: 'ok' } as never,
        });
        strictEqual(r.status, 0);
        strictEqual(r.stdout, 'false:true:null:ok');
    });
});

Deno.test({ name: 'child_process: argv0 is honoured by the async spawn', timeout: 20000 }, async () => {
    await withTempDir('cp-argv0', async (dir) => {
        const script = scriptIn(dir, 'argv0.js', 'process.stdout.write(String(process.argv0));');
        // The native async spawn reads "argv0" but the option was never forwarded,
        // so the child always reported the real exePath.
        const out = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], argv0: 'MYARGV0' });
            let acc = '';
            child.stdout?.on('data', (d) => { acc += String(d); });
            child.on('error', reject);
            child.on('close', () => resolve(acc));
        });
        strictEqual(out, 'MYARGV0');
    });
});
