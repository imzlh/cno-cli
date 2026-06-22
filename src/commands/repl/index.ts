import { createRuntime } from '../../../cts/src/runtime';
import { loadConfigFile } from '../../../cts/src/config';
import { Transformer } from '../../../cts/src/transformer';
import { joinPaths } from '../../../cts/src/utils/path';
import { version } from '../../version';
import { CnoRepl } from './runner';
import { uname } from '../../../cts/src/utils';
import { Inspector } from '../../inspector';
import { parseInspectFlags } from '../inspect';

const os = import.meta.use('os');
const console = import.meta.use('console');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const asyncfs = import.meta.use('asyncfs');

function homeDir(): string | null {
    try {
        const win = uname.sysname.includes('Windows');
        const v = os.getenv(win ? 'USERPROFILE' : 'HOME');
        if (!v) return null;
        return fs.realpath(v);
    } catch { return null; }
}

export async function runRepl(flags: Record<string, string | boolean>): Promise<void> {
    // ---- CDP inspector ----
    const dbg = await startInspector(flags);

    // 1. Initialize cts runtime (this sets up module loader, resolver, etc.)
    const cwd = String(os.cwd).replace(/\\/g, '/');
    const cfg = loadConfigFile(cwd);
    const runtime = createRuntime(cfg, cwd);

    // Wire up CDP scriptParsed hook
    if (dbg?.scriptInitHook) {
        runtime.addInitHook(dbg.scriptInitHook);
    }

    // Polyfill is bundled into the cno binary itself (src/main.ts imports it),
    // so it has already run by the time we reach here.

    // 2. Prevent default unhandled-rejection crash so a bad expression doesn't
    //    take down the whole REPL.
    engine.onEvent((_e: unknown) => false);

    // 3. Build the TypeScript transformer. Use a stable virtual filename so
    //    source-map noise is predictable.
    const transformer = new Transformer(/* sourceMaps */ {
        "sourceMaps": false
    });
    const transform = (code: string): string =>
        transformer.transform(code, '<repl>.ts');

    // 4. History.
    const home = homeDir();
    const histPath = home ? joinPaths(home, '.cno_history') : null;

    const repl = new CnoRepl({
        transform,
        banner: `cno REPL v${version}. ".help" for help, ".q" to quit.\n`,
    });

    if (histPath) {
        try {
            const buf   = await asyncfs.readFile(histPath);
            const lines = engine.decodeString(buf).split('\n').filter((l: string) => l.length);
            repl.importHistory(lines);
        } catch { /* no history yet */ }
    }

    // 5. Run, then persist history.
    await repl.start();
    repl.cleanup();
    await dbg?.detach();
    if (histPath) {
        try {
            fs.writeFile(histPath, engine.encodeString(repl.exportHistory().join('\n')), 0o600);
        } catch (e) {
            console.error(`cno: failed to write ${histPath}: ${(e as Error).message}`);
        }
    }
}

async function startInspector(flags: Record<string, string | boolean>): Promise<any | null> {
    const inspect = parseInspectFlags(flags, true);
    if (!inspect) return null;

    // In REPL mode, --inspect-brk degrades to --inspect-wait:
    // there is no "first line" to break on in an interactive session.
    const dbg = new Inspector({ port: inspect.port, waitForClient: inspect.waitForClient, entryFile: 'repl' });
    await dbg.attach();
    return dbg;
}
