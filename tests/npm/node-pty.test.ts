import { ok, strictEqual } from 'node:assert';

function apiFrom(mod: Record<string, any>): Record<string, any> {
    return mod.default && typeof mod.default.spawn === 'function' ? mod.default : mod;
}

function packageDir(spec: string): string {
    const pkg = require.resolve(`${spec}/package.json`);
    return pkg.slice(0, pkg.lastIndexOf('/'));
}

Deno.test({ name: 'node-pty: runs shell when native addon exists or reports missing build output', timeout: 30000 }, async () => {
    let api: Record<string, any>;
    try {
        api = apiFrom(await import('npm:node-pty'));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const root = packageDir('node-pty');
        ok(message.includes('Failed to load native module: pty.node'), message);
        ok(message.includes(`${root}/lib/utils.js`), message);
        ok(message.includes('build/Release'), message);
        ok(message.includes('prebuilds/'), message);
        return;
    }

    ok(typeof api.spawn === 'function', 'node-pty should export spawn');

    const shell = Deno.build.os === 'windows' ? 'cmd.exe' : 'sh';
    const args = Deno.build.os === 'windows'
        ? ['/d', '/s', '/c', 'echo cno-node-pty']
        : ['-lc', 'printf cno-node-pty'];

    const child = api.spawn(shell, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: Deno.cwd(),
        env: {},
    });

    let output = '';
    child.onData((data: string) => {
        output += data;
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`node-pty timed out; output=${JSON.stringify(output)}`)), 5000);
        child.onExit(() => {
            clearTimeout(timer);
            resolve();
        });
    });

    strictEqual(output.replace(/\r?\n/g, ''), 'cno-node-pty');
});

Deno.test({ name: 'node-pty: writes interactive input through the pseudo terminal', timeout: 30000 }, async () => {
    let api: Record<string, any>;
    try {
        api = apiFrom(await import('npm:node-pty'));
    } catch {
        return;
    }

    const shell = Deno.build.os === 'windows' ? 'cmd.exe' : 'sh';
    const args = Deno.build.os === 'windows'
        ? ['/d', '/s', '/c', 'set /p line=&call echo got:%line%']
        : ['-lc', 'IFS= read line; printf "got:%s" "$line"'];

    const child = api.spawn(shell, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: Deno.cwd(),
        env: {},
    });

    let output = '';
    child.onData((data: string) => {
        output += data;
    });
    child.write('hello-pty\r');

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`node-pty interactive timed out; output=${JSON.stringify(output)}`)), 5000);
        child.onExit(() => {
            clearTimeout(timer);
            resolve();
        });
    });

    ok(output.includes('got:hello-pty'), output);
});
