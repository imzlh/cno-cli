import { os, fs, asyncfs, engine, console, uname, __use_fn } from '../../../cts/src/utils';
import { createRuntime } from '../../../cts/src/runtime';
import { loadConfigFile } from '../../../cts/src/config';
import { Transformer } from '../../../cts/src/transformer';
import { fatal } from '../../../cts/src/errors';
import { joinPaths } from '../../../cts/src/utils/path';
import type { ConfigOptions } from '../../../cts/src/types';
import { resolvePolyfillPath } from '../../bootstrap';
import { version } from '../../version';
import { CnoRepl } from './runner';

const signals = __use_fn('signals');

function homeDir(): string | null {
    try {
        const win = uname.sysname.includes('Windows');
        const v = os.getenv(win ? 'USERPROFILE' : 'HOME');
        if (!v) return null;
        return fs.realpath(v);
    } catch { return null; }
}

export async function runRepl(flags: Record<string, string | boolean>): Promise<void> {
    // 1. Load cno polyfill so Deno/Node APIs are available at the prompt.
    const cwd      = os.cwd as string;
    const fileCfg  = loadConfigFile(cwd);
    const polyfill = (typeof flags['polyfill'] === 'string' ? flags['polyfill'] as string : undefined)
                     ?? resolvePolyfillPath() ?? '';

    const cfg: Partial<ConfigOptions> = {
        ...fileCfg,
        polyfill,
        silent: flags['silent'] === true,
        noLock: true,
    };
    const runtime = createRuntime(cfg, cwd);
    if (runtime.config.polyfill) {
        try { await runtime.loadPolyfill(runtime.config.polyfill); }
        catch (e) { fatal(e, `loading polyfill ${runtime.config.polyfill}`); }
    }

    // 2. Prevent default unhandled-rejection crash so a bad expression doesn't
    //    take down the whole REPL.
    engine.onEvent((_e: unknown) => false);

    // 3. Build the TypeScript transformer. Use a stable virtual filename so
    //    source-map noise is predictable.
    const transformer = new Transformer(/* sourceMaps */ false);
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

    // 5. SIGINT handling — first ^C clears the line, second exits.
    signals.signal(signals.signals.SIGINT, () => {
        repl.handleCtrlC();
    });

    // 6. Run, then persist history.
    await repl.start();
    if (histPath) {
        try {
            fs.writeFile(histPath, engine.encodeString(repl.exportHistory().join('\n')), 0o600);
        } catch (e) {
            console.error(`cno: failed to write ${histPath}: ${(e as Error).message}`);
        }
    }
}
