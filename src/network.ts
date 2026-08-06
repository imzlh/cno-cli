import { setCurlInitHook, setRawConnectionHook } from '../cno/src/utils/network-hooks';
import { createProxyConnector, type ProxyConfig, type ProxyType } from '../cno/src/utils/proxy';
import { log } from '../cts/src/api';

const os    = import.meta.use('os');
const curl  = import.meta.use('curl');
const win32 = import.meta.use('win32');

const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const;
const PROXY_PROTOCOL_SET = new Set<string>(PROXY_PROTOCOLS);

const REG_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Per-scheme proxy configuration. */
type ProxyConfigPair = { http: ProxyConfig | null; https: ProxyConfig | null };

const NO_PROXIES: ProxyConfigPair = { http: null, https: null };

let config:  ProxyConfig | null = null;
let rawConfigs: ProxyConfigPair = { http: null, https: null };
let watcher: CModuleWin32.RegWatch | null = null;
let skipCertVerify = false;

function env(k: string): string | null {
    try {
        return os.getenv(k) ?? null;
    } catch {
        return null;
    }
}

function isProxyType(value: string): value is ProxyType {
    return PROXY_PROTOCOL_SET.has(value);
}

function parseProxyUrl(raw: string, defaultType: ProxyType = 'http'): Omit<ProxyConfig, 'noProxy'> {
    let input = raw.trim();
    if (!/^(https?|socks[45][ah]?):\/\//i.test(input)) input = `${defaultType}://${input}`;
    const u = new URL(input);
    const proto = u.protocol.slice(0, -1);
    if (!isProxyType(proto)) throw new TypeError(`Unsupported proxy protocol: ${proto}`);
    const user = u.username ? decodeURIComponent(u.username) : null;
    const pass = u.password ? decodeURIComponent(u.password) : null;
    u.username = '';
    u.password = '';
    return { url: u.href, type: proto, user, pass };
}

/**
 * `NO_PROXY` from the environment. Applies to whichever proxy ends up in effect,
 * including one that came from the Windows registry — that is how curl behaves.
 *
 * Lowercase is read first: curl documents `http_proxy` (lowercase only) as the
 * canonical spelling, and prefers the lowercase form for the rest where both
 * exist. On Windows the two spellings alias a single variable, so the ordering
 * is a no-op there rather than a double read.
 */
function envNoProxy(): string | null {
    return env('no_proxy') ?? env('NO_PROXY');
}

/**
 * Proxy configuration from the standard environment variables, or null when the
 * environment names no proxy at all. Never throws: a malformed value degrades to
 * "no env proxy" instead of taking down the whole setup.
 */
function readEnvConfigs(): ProxyConfigPair | null {
    const noProxy = envNoProxy();
    const all = env('all_proxy') ?? env('ALL_PROXY');
    const http = env('http_proxy') ?? env('HTTP_PROXY') ?? all;
    // An env-named http proxy also covers https targets: over-proxying is the
    // safe direction for a confidentiality control, under-proxying is not.
    const https = env('https_proxy') ?? env('HTTPS_PROXY') ?? all ?? http;
    if (!http && !https) return null;
    const parse = (raw: string | null): ProxyConfig | null => {
        if (!raw) return null;
        // A malformed value degrades to "no env proxy for this scheme" rather
        // than throwing out of startProxy and leaving no hooks installed.
        try { return { ...parseProxyUrl(raw), noProxy }; } catch { return null; }
    };
    const parsed = { http: parse(http), https: parse(https) };
    return parsed.http || parsed.https ? parsed : null;
}

function parseRegistryProxies(server: string, noProxy: string | null): ProxyConfigPair {
    if (!server.includes('=')) {
        const proxy = { ...parseProxyUrl(server), noProxy };
        return { http: proxy, https: proxy };
    }
    const values = new Map<string, ProxyConfig>();
    for (const entry of server.split(';')) {
        const separator = entry.indexOf('=');
        if (separator <= 0) continue;
        const name = entry.slice(0, separator).trim().toLowerCase();
        const value = entry.slice(separator + 1).trim();
        if (!value) continue;
        const defaultType: ProxyType = name === 'socks' ? 'socks5' : 'http';
        values.set(name, { ...parseProxyUrl(value, defaultType), noProxy });
    }
    const fallback = values.get('socks') ?? null;
    return {
        http: values.get('http') ?? fallback,
        https: values.get('https') ?? values.get('http') ?? fallback,
    };
}

/**
 * Proxy configuration from the Windows registry, or null when the registry names
 * no usable proxy — which includes `ProxyEnable=0`, an absent value (reading a
 * missing value throws `InternalError: Win32 error 0`), and a malformed
 * `ProxyServer`. Returning null rather than clearing shared state is what lets
 * the environment fallback survive; the previous version assigned to `config`
 * and `rawConfigs` directly, so any registry outcome — including a throw —
 * overwrote the environment.
 */
function readRegistryConfigs(registry: NonNullable<typeof win32>): ProxyConfigPair | null {
    try {
        if (!registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyEnable')) return null;
        const server = registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyServer');
        if (typeof server !== 'string' || !server) return null;

        let noProxy: string | null = null;
        try {
            const bypass = registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyOverride');
            if (typeof bypass === 'string') {
                noProxy = bypass.replace(/;/g, ',').replace(/<local>/gi, '<local>,localhost,127.0.0.1,::1');
            }
        } catch { /* ProxyOverride not present */ }

        const parsed = parseRegistryProxies(server, noProxy);
        return parsed.http || parsed.https ? parsed : null;
    } catch {
        // Registry unreadable (missing value, permissions, policy). Not fatal —
        // the caller still consults the environment.
        return null;
    }
}

/**
 * Recompute the effective proxy from both sources.
 *
 * Precedence: **environment variables win over the Windows registry**, per
 * scheme. Measured on this box with curl 8.21.0 and a loopback counting sink:
 * curl ignores the registry entirely (`ProxyEnable=1`,
 * `ProxyServer=127.0.0.1:7897` present, no env → 0 proxy hits, rc=6
 * "couldn't resolve host") and honours only the env vars. npm resolves its
 * `proxy`/`https-proxy` config from the same env names and likewise never reads
 * the registry. So an explicit env var is the more specific, more recent signal;
 * letting a stale machine-wide registry setting override it would be surprising
 * and would also make `NO_PROXY` unenforceable.
 *
 * The merge is per scheme, not all-or-nothing: `HTTPS_PROXY` alone overrides the
 * registry for https while http keeps using the registry proxy. `NO_PROXY` from
 * the environment applies to whichever proxy wins, registry included.
 */
function refreshConfig(registry: NonNullable<typeof win32> | null): void {
    const fromRegistry = registry ? readRegistryConfigs(registry) : null;
    const fromEnv = readEnvConfigs();

    if (!fromRegistry && !fromEnv) {
        rawConfigs = { ...NO_PROXIES };
        config = null;
        return;
    }

    const envBypass = envNoProxy();
    const withEnvBypass = (entry: ProxyConfig | null): ProxyConfig | null =>
        entry && envBypass ? { ...entry, noProxy: envBypass } : entry;

    rawConfigs = {
        http:  fromEnv?.http  ?? withEnvBypass(fromRegistry?.http  ?? null),
        https: fromEnv?.https ?? withEnvBypass(fromRegistry?.https ?? null),
    };
    config = rawConfigs.https ?? rawConfigs.http;
}

function rawProxyFor(url: URL): ProxyConfig | null {
    return url.protocol === 'https:' || url.protocol === 'wss:' ? rawConfigs.https : rawConfigs.http;
}

function applyNetwork(handle: CModuleCURL.CURL): void {
    if (config) {
        handle.setProxy(config.url, config.type);
        if (config.user) handle.setOpt(curl.CURLOPT_PROXYUSERNAME, config.user);
        if (config.pass) handle.setOpt(curl.CURLOPT_PROXYPASSWORD, config.pass);
        if (config.noProxy) handle.setOpt(curl.CURLOPT_NOPROXY, config.noProxy);
    }
    if (skipCertVerify) {
        handle.setOpt(curl.CURLOPT_SSL_VERIFYPEER, 0);
        handle.setOpt(curl.CURLOPT_SSL_VERIFYHOST, 0);
    }
}

export function startProxy(): void {
    // Consult the registry AND the environment on every platform. The previous
    // version branched: on Windows `win32?.HKCU` is always defined, so the
    // environment path was unreachable dead code on the one platform this tree
    // ships for. Worse, a registry throw left `rawConfigs` null while libcurl
    // went on honouring HTTP_PROXY natively — so fetch was proxied and the raw
    // clients (WebSocket, EventSource) silently went direct.
    const registry = win32?.HKCU !== undefined ? win32 : null;
    refreshConfig(registry);

    if (registry && watcher === null) {
        // Created at most once per process, and never released. A watch failure
        // must not prevent the hooks below from being installed: an uninstalled
        // raw-connection hook is exactly the bypass this fixes.
        try {
            watcher = registry.watchRegistry(registry.HKCU, REG_KEY, () => {
                refreshConfig(registry);
            });
            // An un-unref'd RegWatch holds the event loop open, so
            // `cno run --system-proxy` would never exit.
            watcher.unref();
        } catch {
            watcher = null;
        }
    }

    log.debug('http', () => config ? `successful setup proxy bypass: ${config.url}` : 'proxy not configured')
    setCurlInitHook(applyNetwork);
    setRawConnectionHook(createProxyConnector(rawProxyFor));
}

export function disableCertVerify(): void {
    skipCertVerify = true;
    setCurlInitHook(applyNetwork);
}

export function stopNetwork(): void {
    // Deliberately neither watcher.close() nor watcher = null. Measured on the
    // 10:12 build: close() blocks inside itself and never returns, and because
    // QuickJS is reference-counted, dropping the last reference runs the native
    // RegWatch finalizer synchronously — which blocks the same way. unref() is
    // the only teardown that returns, so the handle is kept referenced for the
    // life of the process on purpose. See the RegWatch defect in the report.
    watcher?.unref();
    config = null;
    rawConfigs = { ...NO_PROXIES };
    setCurlInitHook(null);
    setRawConnectionHook(null);
}

export function getProxyInfo(): ProxyConfig | null {
    return config;
}
