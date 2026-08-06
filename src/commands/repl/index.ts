import { createRuntime, loadConfigFile, Transformer, joinPaths, cwd, uname } from '../../../cts/src/api';
import { installEventReceiver, PRIORITY_FALLBACK, EV } from '../../../cts/src/runtime/event-mux';
import { version } from '../../version';
import { CnoRepl } from './runner';
import { HISTORY_DB_NAME, HISTORY_TEXT_NAME } from './history';
import { Inspector } from '../../inspector';
import { installInspectorBridge, uninstallInspectorBridge } from '../../inspector/bridge';
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
    // ---- CDP inspector ----
    let dbg = await startInspector(flags);

    // 1. Initialize cts runtime (this sets up module loader, resolver, etc.)
    const cwdPath = cwd();
    const cfg = loadConfigFile(cwdPath);
    const runtime = createRuntime(cfg, cwdPath);
    installInspectorBridge({
        entryFile: 'repl',
        addInitHook: (hook) => runtime.addInitHook(hook),
        getCurrentInspector: () => dbg,
        setCurrentInspector: (inspector) => { dbg = inspector; },
    });

    // Wire up CDP scriptParsed hook
    if (dbg?.scriptInitHook) {
        runtime.addInitHook(dbg.scriptInitHook);
    }

    // Polyfill is bundled into the cno binary itself (src/main.ts imports it),
    // so it has already run by the time we reach here.

    // 2. Prevent default unhandled-rejection crash so a bad expression doesn't
    //    take down the whole REPL.
    //
    // This was a raw `engine.onEvent((_e) => false)`. Two defects:
    //
    //  a) onEvent is a single-slot setter that frees the previous receiver
    //     (circu.js/src/mod_engine.c:871), so it displaced the multiplexer that
    //     createRuntime() had just installed one call earlier — and the mux
    //     cannot detect this, because the native layer exposes no getter. Inside
    //     the REPL, 'unhandledrejection'/'load'/'unload' were dead again and the
    //     cts diagnostics receiver was silenced, so async errors vanished
    //     without a trace.
    //
    //  b) the flat `false` was wrong for EV_JOB_EXCEPTION. The native polarity
    //     is not uniform: utils.c:180 treats `false` as "fatal" and calls
    //     TJS_Stop. So a throw from a timer or a stray callback would have torn
    //     down the REPL — the opposite of this receiver's stated purpose.
    //
    // PRIORITY_FALLBACK puts this last in dispatch order, and the last explicit
    // boolean wins, so the REPL's non-fatal guarantee overrides any other
    // receiver while still letting webapi dispatch and diagnostics print first.
    installEventReceiver('repl', (name) => {
        // false = "handled, do not abort" for a rejection (vm.c:242 aborts on
        // any non-false); true = "continue" for a job exception (utils.c:180
        // calls TJS_Stop on false). Same intent, opposite constants.
        if (name === EV.JOB_EXCEPTION) return true;
        return false;
    }, PRIORITY_FALLBACK);

    // 3. Build the TypeScript transformer. Use a stable virtual filename so
    //    source-map noise is predictable.
    const transformer = new Transformer(/* sourceMaps */ {
        "sourceMaps": false
    });
    const transform = (code: string): string =>
        transformer.transform(code, '<repl>.ts');

    // 4. History — SQLite under HOME; migrate legacy text if DB is empty.
    const home = homeDir();
    const histPath = home ? joinPaths(home, HISTORY_DB_NAME) : undefined;
    const legacyText = home ? joinPaths(home, HISTORY_TEXT_NAME) : null;

    const repl = new CnoRepl({
        transform,
        banner: `cno REPL v${version}. ".help" for help, ".q" to quit.\n`,
        historyPath: histPath,
    });

    if (legacyText && exists(legacyText)) {
        try {
            repl.historyStore.migrateFromTextFile(legacyText);
        } catch { /* best-effort */ }
    }

    // 5. Run; cleanup closes the history DB.
    await repl.start();
    repl.cleanup();
    await dbg?.detach();
    uninstallInspectorBridge();
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
