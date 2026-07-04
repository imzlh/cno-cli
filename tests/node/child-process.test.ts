import { strictEqual, ok } from 'node:assert';
import { spawn, exec, execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = join(tmpdir(), `cno-cp-target-${process.pid}.js`);

Deno.test({ name: 'child_process: spawn captures stdout and exit code', timeout: 10000 }, async () => {
    fs.writeFileSync(SCRIPT, 'process.stdout.write("out"); process.exit(0);\n');
    try {
        const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] });
            let out = '';
            child.stdout?.on('data', (d) => (out += d.toString()));
            child.on('error', reject);
            child.on('exit', (code) => resolve({ code, out }));
        });
        strictEqual(result.code, 0);
        strictEqual(result.out, 'out');
    } finally {
        fs.rmSync(SCRIPT, { force: true });
    }
});

Deno.test({ name: 'child_process: spawn non-zero exit code surfaces in callback', timeout: 10000 }, async () => {
    fs.writeFileSync(SCRIPT, 'process.exit(42);\n');
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [SCRIPT]);
            child.on('error', reject);
            child.on('exit', (c) => resolve(c));
        });
        strictEqual(code, 42);
    } finally {
        fs.rmSync(SCRIPT, { force: true });
    }
});

Deno.test({ name: 'child_process: spawn with stdio inherit returns null streams', timeout: 10000 }, () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'inherit' });
    strictEqual(child.stdout, null);
    strictEqual(child.stderr, null);
    child.kill('SIGKILL');
});

Deno.test({ name: 'child_process: child.pid is a positive number', timeout: 10000 }, () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000);']);
    ok(typeof child.pid === 'number' && child.pid > 0);
    child.kill('SIGKILL');
});

Deno.test({ name: 'child_process: exec returns stdout/stderr to callback', timeout: 10000 }, async () => {
    const r = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        exec(`${process.execPath} -e "console.log('hello'); console.error('err');"`, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        });
    });
    strictEqual(r.stdout, 'hello');
    strictEqual(r.stderr, 'err');
});

Deno.test({ name: 'child_process: execFile runs a file with args', timeout: 10000 }, async () => {
    fs.writeFileSync(SCRIPT, 'process.stdout.write(process.argv.slice(1).join(","));\n');
    try {
        const r = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, [SCRIPT, 'a', 'b', 'c'], (err, stdout) => {
                if (err) reject(err); else resolve(stdout);
            });
        });
        strictEqual(r, 'a,b,c');
    } finally {
        fs.rmSync(SCRIPT, { force: true });
    }
});

Deno.test({ name: 'child_process: spawnSync returns status and stdout', timeout: 10000 }, () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("sync-out"); process.exit(3);']);
    strictEqual(r.status, 3);
    strictEqual(r.stdout.toString(), 'sync-out');
    strictEqual(r.signal, null);
});

Deno.test({ name: 'child_process: spawnSync on missing command errors', timeout: 10000 }, () => {
    const r = spawnSync('/this/path/definitely/does/not/exist');
    ok(r.error instanceof Error, 'spawnSync of missing command must populate error');
});

Deno.test({ name: 'child_process: child.kill sends signal and resolves exit', timeout: 10000 }, async () => {
    fs.writeFileSync(SCRIPT, 'setInterval(()=>{}, 1000);\n');
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [SCRIPT]);
            child.on('error', reject);
            child.on('exit', (c) => resolve(c));
            setTimeout(() => child.kill('SIGTERM'), 100);
        });
        // SIGTERM default action is termination; code may be null with signal set.
        ok(code !== 0, 'killed child must exit non-zero or via signal');
    } finally {
        fs.rmSync(SCRIPT, { force: true });
    }
});

Deno.test({ name: 'child_process: child.on("error") emits on spawn failure', timeout: 10000 }, async () => {
    const saw = await new Promise<boolean>((resolve) => {
        const child = spawn('/nonexistent/binary/xyz');
        child.on('error', () => resolve(true));
        child.on('exit', () => resolve(false));
    });
    ok(saw, 'spawn of missing binary must emit error');
});
