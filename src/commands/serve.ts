import type { Args } from '../../cno/src/utils/args';
import type { KernelContext } from '../kernel';
import { runFile } from './run';

const console = import.meta.use('console');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

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

function serveUnixPath(flags: Record<string, string | boolean>): string | undefined {
    const raw = flags['unix'];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new TypeError(`invalid value for --unix: ${String(raw)}`);
    }
    return raw;
}

function readPemFile(flag: string, value: string | boolean | undefined): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`invalid value for --${flag}: ${String(value)}`);
    }
    try {
        return engine.decodeString(fs.readFile(value));
    } catch {
        throw new TypeError(`--${flag}: cannot read file: ${value}`);
    }
}

function serveTlsOptions(flags: Record<string, string | boolean>): { cert: string; key: string } | undefined {
    const cert = flags.cert;
    const key = flags.key;
    if (cert === undefined && key === undefined) return undefined;
    // Half a TLS pair would only fail deep inside the server; fail here instead.
    if (cert === undefined || key === undefined) {
        throw new TypeError('--cert and --key must be supplied together');
    }
    return { cert: readPemFile('cert', cert), key: readPemFile('key', key) };
}

function formatListenUrl(addr: Deno.Addr, secure: boolean): string {
    if (addr.transport === 'unix' || addr.transport === 'unixpacket') return `unix:${addr.path}`;
    if (addr.transport === 'vsock') return `vsock:${addr.cid}:${addr.port}`;
    // The @types/bun ambient Deno namespace keeps UnixAddr in the remaining
    // union, so the TCP shape is narrowed explicitly instead of by transport.
    const tcp = addr as Deno.NetAddr;
    // URL syntax requires IPv6 literals to be enclosed in brackets.
    const hostname = tcp.hostname.includes(':') && !tcp.hostname.startsWith('[')
        ? `[${tcp.hostname}]`
        : tcp.hostname;
    return `${secure ? 'https' : 'http'}://${hostname}:${tcp.port}/`;
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

    const handler: Deno.ServeHandler<Deno.Addr> = (request, info) =>
        Reflect.apply(fetch, serverExport, [request, info]) as Response | Promise<Response>;
    const unixPath = serveUnixPath(flags);
    if (unixPath !== undefined && (flags.cert !== undefined || flags.key !== undefined)) {
        throw new TypeError('--unix cannot be combined with --cert/--key');
    }
    const tls = serveTlsOptions(flags);
    const listen = (addr: Deno.Addr): void => {
        if (typeof onListen === 'function') {
            Reflect.apply(onListen, serverExport, [addr]);
            return;
        }
        console.log(`cno serve: Listening on ${formatListenUrl(addr, tls !== undefined)}`);
    };

    // Each branch matches a declared Deno.serve overload; in the unix mode the
    // runtime ignores hostname/port.
    const server = unixPath !== undefined
        ? Deno.serve({ path: unixPath, onListen: listen }, handler)
        : tls
          ? Deno.serve({ hostname: serveHost(flags), port: servePort(flags), ...tls, onListen: listen }, handler)
          : Deno.serve({ hostname: serveHost(flags), port: servePort(flags), onListen: listen }, handler);

    let shuttingDown = false;
    const installedSignals = new Set<Deno.Signal>();
    const removeSignalListeners = () => {
        for (const signal of installedSignals) {
            try { Deno.removeSignalListener(signal, shutdown); } catch { /* unavailable */ }
        }
        installedSignals.clear();
    };
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        removeSignalListeners();
        void server.shutdown().catch(() => {});
    };
    void server.finished.then(removeSignalListeners, removeSignalListeners);
    try {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
            Deno.addSignalListener(signal, shutdown);
            installedSignals.add(signal);
        }
    } catch {
        // Signal support may be unavailable on a restricted host; roll back any
        // listener installed before a registration failed.
        removeSignalListeners();
    }
}

export function runServe(
    file: string,
    args: string[],
    flags: Record<string, string | boolean>,
    rawArgs: Args,
    kernel: KernelContext,
): Promise<void> {
    return runFile({
        file,
        args,
        flags,
        rawArgs,
        kernel,
        onEvaluated: (namespace) => startServe(namespace, flags),
    });
}
