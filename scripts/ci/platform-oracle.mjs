import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createSocket } from 'node:dgram';
import { constants, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultHighWaterMark } from 'node:stream';
import { WriteStream } from 'node:tty';

function outcome(invoke) {
    try {
        return { value: invoke() };
    } catch (error) {
        return { code: error.code, errno: error.errno, syscall: error.syscall, message: error.message };
    }
}

const directory = fs.mkdtempSync(join(tmpdir(), 'cno-ci-node-oracle-'));
try {
    const file = join(directory, 'file');
    const subdirectory = join(directory, 'subdirectory');
    fs.writeFileSync(file, 'fixture');
    fs.mkdirSync(subdirectory);
    const signals = Object.fromEntries(['SIGEMT', 'SIGIOT', 'SIGABRT', 'SIGIO', 'SIGPOLL', 'SIGUNUSED', 'SIGSYS']
        .map(signal => [signal, {
            number: constants.signals[signal],
            kill: outcome(() => process.kill(0x7fffffff, signal)),
        }]));
    const filesystem = {
        readThroughFile: outcome(() => fs.readFileSync(join(file, 'missing'))),
        readDirectory: outcome(() => fs.readdirSync(file)),
        truncateDirectory: outcome(() => fs.truncateSync(subdirectory, 0)),
        unlinkDirectory: outcome(() => fs.unlinkSync(subdirectory)),
    };
    const colors = Object.fromEntries([
        ['empty', {}],
        ['noColor', { NO_COLOR: '1' }],
        ['disabled', { NODE_DISABLE_COLORS: '1' }],
        ['dumb', { TERM: 'dumb' }],
        ['emptyNoColor', { NO_COLOR: '', TERM: 'xterm-256color' }],
    ].map(([name, env]) => [name, {
        depth: WriteStream.prototype.getColorDepth(env),
        hasColors: WriteStream.prototype.hasColors(env),
    }]));
    const driveEnvironment = { before: process.env['=c:'], presentBefore: '=c:' in process.env };
    if (process.platform === 'win32') process.chdir(process.cwd());
    Object.assign(driveEnvironment, { after: process.env['=c:'], presentAfter: '=c:' in process.env });
    const childSource = [
        'console.log(JSON.stringify({',
        '    keys: Object.keys(process.env).sort(),',
        '    platform: process.platform,',
        '    brand: Object.prototype.toString.call(process),',
        '    A: process.env.A, B: process.env.B, C: process.env.C,',
        '}));',
    ].join('\n');
    const children = Object.fromEntries([
        ['empty', {}],
        ['nullish', { A: undefined, B: null, C: 'ok' }],
    ].map(([name, env]) => {
        const child = spawnSync(process.execPath, ['-e', childSource], { env, encoding: 'utf8', timeout: 10_000 });
        return [name, {
            status: child.status,
            signal: child.signal,
            error: child.error?.message,
            stdout: child.stdout,
            stderr: child.stderr,
        }];
    }));
    const socket = createSocket('udp4');
    let multicast;
    try {
        multicast = await new Promise(resolve => {
            socket.once('error', error => resolve({ error: error.message, code: error.code }));
            socket.bind(0, '127.0.0.1', () => resolve({
                normal: outcome(() => socket.setMulticastTTL(1)),
                negative: outcome(() => socket.setMulticastTTL(-1)),
            }));
        });
    } finally {
        try { socket.close(); } catch {}
    }
    console.log(JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        processBrand: Object.prototype.toString.call(process),
        release: release(),
        byteHighWaterMark: getDefaultHighWaterMark(false),
        signals,
        filesystem,
        colors,
        children,
        multicast,
        driveEnvironment,
    }, null, 2));
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
