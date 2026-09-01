import { createRuntime, loadConfigFile, Transformer, joinPaths, cwd, uname } from '../../../cts/src/api';
import { installEventReceiver, PRIORITY_FALLBACK, EV } from '../../../cts/src/runtime/event-mux';
import { version } from '../../version';
import { CnoRepl } from './runner';
import { HISTORY_DB_NAME, HISTORY_TEXT_NAME } from './history';
import { Inspector } from '../../inspector';
import { installInspectorBridge, uninstallInspectorBridge } from '../../inspector/bridge';
import { flagsToConfig, publishWorkerRuntimeConfig } from '../config-flags';
import { parseInspectFlags } from '../inspect';

const os = import.meta.use('os');
const fs = import.meta.use('fs');

function getEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}

function homeDir(): string | null {
    try {
        const win = uname.sysname.includes('Windows');
        const v = getEnv(win ? 'USERPROFILE' : 'HOME');
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

export async function runRepl(flags: Record<string, string | boolean>): Promise<void> {
    let dbg: Inspector | null = null;
    let runtime: ReturnType<typeof createRuntime> | null = null;
    let repl: CnoRepl | null = null;
    let removeReplReceiver: (() => void) | null = null;
    let bridgeInstalled = false;

    try {
        dbg = await startInspector(flags);
        const cwdPath = cwd();
        const cliCfg = flagsToConfig(flags);
        cliCfg.ignoreScripts = true;
        runtime = createRuntime({ ...loadConfigFile(cwdPath), ...cliCfg }, cwdPath);
        publishWorkerRuntimeConfig(runtime.config);
        installInspectorBridge({
            entryFile: 'repl',
            addInitHook: (hook) => runtime!.addInitHook(hook),
            getCurrentInspector: () => dbg,
            setCurrentInspector: (inspector) => { dbg = inspector; },
        });
        bridgeInstalled = true;

        if (dbg?.scriptInitHook) runtime.addInitHook(dbg.scriptInitHook);

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
            try {
                await dbg?.detach();
            } finally {
                if (bridgeInstalled) uninstallInspectorBridge();
                runtime?.cleanup();
            }
        }
    }
}

async function startInspector(flags: Record<string, string | boolean>): Promise<Inspector | null> {
    const inspect = parseInspectFlags(flags, true);
    if (!inspect) return null;

    // In REPL mode, --inspect-brk degrades to --inspect-wait:
    // there is no "first line" to break on in an interactive session.
    const dbg = new Inspector({ port: inspect.port, host: inspect.host, waitForClient: inspect.waitForClient, entryFile: 'repl' });
    await dbg.attach();
    return dbg;
}
