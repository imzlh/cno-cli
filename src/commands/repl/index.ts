import { loadConfigFile, Transformer, joinPaths, cwd, uname } from '../../../cts/src/api';
import { installEventReceiver, PRIORITY_FALLBACK, EV } from '../../../cts/src/runtime/event-mux';
import { version } from '../../version';
import { CnoRepl } from './runner';
import { HISTORY_DB_NAME, HISTORY_TEXT_NAME } from './history';
import { flagsToConfig } from '../../config';
import type { Args } from '../../../cno/src/utils/args';
import { applyLocationFlag, effectiveRuntimeFlags, openKernelRuntime, type KernelContext, type KernelRuntime } from '../../kernel';
import { readEnv } from '../../env';

const fs = import.meta.use('fs');

function homeDir(): string | null {
    try {
        const win = uname.sysname.includes('Windows');
        const v = readEnv(win ? 'USERPROFILE' : 'HOME');
        if (!v) return null;
        try {
            return fs.realpath(v);
        } catch {
            // HOME may not resolve (sandbox, missing dir); keep the raw path.
            return v;
        }
    } catch { return null; }
}
function exists(path: string): boolean {
    try {
        return fs.exists(path);
    } catch {
        return false;
    }
}

export async function runRepl(
    commandFlags: Record<string, string | boolean>,
    kernel: KernelContext,
    rawArgs: Args,
): Promise<void> {
    const flags = effectiveRuntimeFlags(kernel, commandFlags);
    let session: KernelRuntime | undefined;
    let repl: CnoRepl | null = null;
    let removeReplReceiver: (() => void) | null = null;

    try {
        applyLocationFlag(flags);
        const cwdPath = cwd();
        const cliCfg = flagsToConfig(flags);
        cliCfg.ignoreScripts = true;
        session = await openKernelRuntime(kernel, 'repl', { ...loadConfigFile(cwdPath), ...kernel.config, ...cliCfg }, cwdPath, { repl: true });
        await session.initialize(rawArgs);

        removeReplReceiver = installEventReceiver(
            'repl',
            (name) => name === EV.JOB_EXCEPTION,
            PRIORITY_FALLBACK,
        );

        const transformer = new Transformer({ sourceMaps: false });
        const home = homeDir();
        const histPath = home ? joinPaths(home, HISTORY_DB_NAME) : undefined;
        const legacyText = home ? joinPaths(home, HISTORY_TEXT_NAME) : null;
        repl = new CnoRepl({
            transform: (code) => transformer.transform(code, '<repl>.ts'),
            banner: `cno REPL v${version}. ".help" for help, ".q" to quit.\n`,
            historyPath: histPath,
        });

        if (legacyText && exists(legacyText)) {
            try {
                repl.historyStore.migrateFromTextFile(legacyText);
            } catch { /* best-effort */ }
        }
        await repl.start();
    } finally {
        try {
            repl?.cleanup();
        } finally {
            removeReplReceiver?.();
            await session?.close();
        }
    }
}
