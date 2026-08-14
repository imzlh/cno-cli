import type { Args } from '../../cno/src/utils/args';
import { runFile } from './run';

const console = import.meta.use('console');

type ServeExport = Record<string, unknown>;

const MISSING_FETCH_ERROR = 'cno serve requires export default { fetch } in the main module';

function servePort(flags: Record<string, string | boolean>): number {
    const raw = flags.port;
    if (raw === undefined) return 8000;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        throw new TypeError(`invalid value for --port: ${String(raw)}`);
    }
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port > 65535) {
        throw new RangeError(`invalid value for --port: ${raw}`);
    }
    return port;
}

function serveHost(flags: Record<string, string | boolean>): string {
    const raw = flags.host;
    if (raw === undefined) return '0.0.0.0';
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new TypeError(`invalid value for --host: ${String(raw)}`);
    }
    return raw;
}

function formatListenUrl(addr: Deno.NetAddr): string {
    // URL syntax requires IPv6 literals to be enclosed in brackets.
    const hostname = addr.hostname.includes(':') && !addr.hostname.startsWith('[')
        ? `[${addr.hostname}]`
        : addr.hostname;
    return `http://${hostname}:${addr.port}/`;
}

function startServe(
    namespace: Record<string, unknown>,
    flags: Record<string, string | boolean>,
): void {
    const exported = namespace.default;
    if (typeof exported !== 'object' || exported === null) {
        throw new TypeError(MISSING_FETCH_ERROR);
    }

    const serverExport = exported as ServeExport;
    if (!Reflect.has(serverExport, 'fetch')) {
        throw new TypeError(MISSING_FETCH_ERROR);
    }
    const fetch = Reflect.get(serverExport, 'fetch');
    if (typeof fetch !== 'function') throw new TypeError('default export fetch must be a function');

    const onListen = Reflect.get(serverExport, 'onListen');
    if (onListen !== undefined && typeof onListen !== 'function') {
        throw new TypeError('default export onListen must be a function');
    }

    const handler: Deno.ServeHandler<Deno.NetAddr> = (request, info) =>
        Reflect.apply(fetch, serverExport, [request, info]) as Response | Promise<Response>;
    const listen = typeof onListen === 'function'
        ? (addr: Deno.NetAddr) => { Reflect.apply(onListen, serverExport, [addr]); }
        : (addr: Deno.NetAddr) => console.log(`Listening on ${formatListenUrl(addr)}`);

    const server = Deno.serve({
        hostname: serveHost(flags),
        port: servePort(flags),
        handler,
        onListen: listen,
    });

    let shuttingDown = false;
    let shutdown: () => void;
    const removeSignalListeners = () => {
        try { Deno.removeSignalListener('SIGINT', shutdown); } catch { /* unavailable */ }
        try { Deno.removeSignalListener('SIGTERM', shutdown); } catch { /* unavailable */ }
    };
    shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        removeSignalListeners();
        void server.shutdown().catch(() => {});
    };
    void server.finished.then(removeSignalListeners, removeSignalListeners);
    try {
        Deno.addSignalListener('SIGINT', shutdown);
        Deno.addSignalListener('SIGTERM', shutdown);
    } catch {
        // Signal support can be unavailable in a restricted host.
    }
}

export function runServe(
    file: string,
    args: string[],
    flags: Record<string, string | boolean>,
    rawArgs: Args,
): Promise<void> {
    return runFile({
        file,
        args,
        flags,
        rawArgs,
        onEvaluated: (namespace) => startServe(namespace, flags),
    });
}
