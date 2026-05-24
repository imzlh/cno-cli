// cno-cli entry point.
//
// In an embedded binary this file is what cjsc evaluates first.
// In dev, run as: cts src/main.ts <args>

import { os, worker, console } from '../cts/src/utils';
import { isCompilerWorker, runCompilerWorker } from '../cts/src/precompile';
import { fatal } from '../cts/src/errors';
import { log } from '../cts/src/utils/log';

import { parseArgv, readArgv } from './cli';
import { showHelp, showVersion, C } from './help';
import { registerExtensions } from './bootstrap';
import { runFile } from './commands/run';
import { runEval } from './commands/eval';
import { runCache } from './commands/cache';
import { runTask } from './commands/task';
import { runRepl } from './commands/repl';
import { runTest } from './commands/test';

// import polyfill
import '../cno/src/main'

// Register native .so extensions before anything tries to use them.
registerExtensions();

function notImplemented(name: string): never {
    console.error(`${C.warn('!')} ${C.cyan('cno ' + name)} is not implemented yet.`);
    os.exit(2);
    throw new Error('unreachable');
}

async function dispatch(): Promise<void> {
    const cli = parseArgv(readArgv());

    if (cli.cmd === 'help') return showHelp();
    if (cli.cmd === 'version') return showVersion();

    if (cli.cmd === 'eval') {
        const code = cli.positional[0];
        if (!code) {
            console.error(`Usage: ${C.cyan('cno eval')} ${C.cyan('"<code>"')}`);
            os.exit(1);
        }
        return runEval({ code, flags: cli.flags });
    }

    if (cli.cmd === 'cache') {
        return runCache(cli.positional[0]!, cli.flags);
    }

    if (cli.cmd === 'task') {
        return runTask(cli.positional);
    }

    if (cli.cmd === 'repl') {
        return runRepl(cli.flags);
    }

    if (cli.cmd === 'test') {
        return runTest(cli.positional, cli.flags);
    }

    if (cli.cmd === 'fmt' || cli.cmd === 'lint' || cli.cmd === 'upgrade') {
        notImplemented(cli.cmd);
    }

    // `cno run <file>` or `cno <file>` (implicit run)
    if (cli.cmd === 'run' || cli.cmd === null) {
        const [file, ...args] = cli.positional;
        if (!file) {
            showHelp();
            os.exit(1);
        }
        return runFile({ file: file!, args, flags: cli.flags });
    }

    showHelp();
    os.exit(1);
}

async function workerEntry(): Promise<void> {
    // cts spawns workers for precompile and for nested task runs.
    // The precompile-worker path is special; defer to cts.
    if (isCompilerWorker()) {
        return runCompilerWorker();
    }
    // Other worker uses (e.g. `cts task` re-entry) — currently unsupported
    // in cno-cli; fall through to dispatch on argv.
    log.debug('cno', () => 'worker: unknown role, dispatching on argv');
    return dispatch();
}

{
    const boot = worker.isWorker ? workerEntry() : dispatch();
    boot.catch(e => fatal(e));
}
