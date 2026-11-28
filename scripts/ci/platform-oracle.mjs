import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
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
    const child = spawnSync(process.execPath, ['-e', [
        'console.log(JSON.stringify({',
        '    keys: Object.keys(process.env).sort(),',
        '    platform: process.platform,',
        '    brand: Object.prototype.toString.call(process),',
        '}));',
    ].join('\n')], { env: {}, encoding: 'utf8', timeout: 10_000 });
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
        emptyEnvironmentChild: {
            status: child.status,
            signal: child.signal,
            error: child.error?.message,
            stdout: child.stdout,
            stderr: child.stderr,
        },
    }, null, 2));
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
