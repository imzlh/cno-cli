import { setCurlInitHook as setCnoCurlInitHook, setRawConnectionHook } from '../cno/src/utils/network-hooks';
import { createProxyConnector, type ProxyConfig, type ProxyType } from '../cno/src/utils/proxy';
import { log } from '../cts/src/api';
import { setCurlInitHook as setCtsCurlInitHook } from '../cts/src/utils/curl';
import { readEnv } from './env';

const curl  = import.meta.use('curl');
const win32 = import.meta.use('win32');

const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const;
const PROXY_PROTOCOL_SET = new Set<string>(PROXY_PROTOCOLS);

const REG_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Per-scheme proxy configuration. */
type ProxyConfigPair = { http: ProxyConfig | null; https: ProxyConfig | null };
type ProxyTarget = { protocol: string };

type EnvProxyConfigs = {
    configs: ProxyConfigPair;
    specified: { http: boolean; https: boolean };
};

const NO_PROXIES: ProxyConfigPair = { http: null, https: null };

let config:  ProxyConfig | null = null;
let rawConfigs: ProxyConfigPair = { http: null, https: null };
let watcher: CModuleWin32.RegWatch | null = null;
let skipCertVerify = false;

function isProxyType(value: string): value is ProxyType {
    return PROXY_PROTOCOL_SET.has(value);
}

function parseProxyUrl(raw: string, defaultType: ProxyType = 'http'): Omit<ProxyConfig, 'noProxy'> {
    let input = raw.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `${defaultType}://${input}`;
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
    return readEnv('no_proxy') ?? readEnv('NO_PROXY');
}

/**
 * Proxy configuration from the standard environment variables, or null when the
 * environment names no proxy at all. Never throws: a malformed value degrades to
 * "no env proxy" instead of taking down the whole setup.
 */
function readEnvConfigs(): EnvProxyConfigs | null {
    const noProxy = envNoProxy();
    const all = readEnv('all_proxy') ?? readEnv('ALL_PROXY');
    const http = readEnv('http_proxy') ?? readEnv('HTTP_PROXY') ?? all;
    const https = readEnv('https_proxy') ?? readEnv('HTTPS_PROXY') ?? all;
    const specified = { http: http !== null, https: https !== null };
    if (!specified.http && !specified.https) return null;
    const parse = (raw: string | null): ProxyConfig | null => {
        if (!raw) return null;
        try { return { ...parseProxyUrl(raw), noProxy }; } catch { return null; }
    };
    return {
        configs: {
            http: parse(http),
            https: parse(https),
        },
        specified,
    };
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
        try {
            values.set(name, { ...parseProxyUrl(value, defaultType), noProxy });
        } catch {
            // Windows permits several proxy entries in one value. Ignore only
            // the malformed entry so a valid scheme can still be used.
        }
    }
    const fallback = values.get('socks') ?? null;
    return {
        http: values.get('http') ?? fallback,
        https: values.get('https') ?? values.get('http') ?? fallback,
    };
}

/** Read registry proxy settings without replacing the environment fallback. */
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

/** Environment variables override Windows registry settings per scheme. */
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
        http:  fromEnv?.specified.http  ? fromEnv.configs.http  : withEnvBypass(fromRegistry?.http  ?? null),
        https: fromEnv?.specified.https ? fromEnv.configs.https : withEnvBypass(fromRegistry?.https ?? null),
    };
    config = rawConfigs.https ?? rawConfigs.http;
}

function rawProxyFor(url: ProxyTarget): ProxyConfig | null {
    if (url.protocol === 'https:' || url.protocol === 'wss:') return rawConfigs.https;
    if (url.protocol === 'http:' || url.protocol === 'ws:') return rawConfigs.http;
    return null;
}

function clearCurlProxy(handle: CModuleCURL.CURL): void {
    handle.setOpt(curl.CURLOPT_PROXY, null);
    handle.setOpt(curl.CURLOPT_PROXYTYPE, curl.CURLPROXY_HTTP);
    handle.setOpt(curl.CURLOPT_PROXYUSERNAME, null);
    handle.setOpt(curl.CURLOPT_PROXYPASSWORD, null);
    handle.setOpt(curl.CURLOPT_NOPROXY, null);
}

function applyNetwork(handle: CModuleCURL.CURL, url: ProxyTarget): void {
    const proxy = rawProxyFor(url);
    if (proxy) {
        handle.setProxy(proxy.url, proxy.type);
        handle.setOpt(curl.CURLOPT_PROXYUSERNAME, proxy.user ?? null);
        handle.setOpt(curl.CURLOPT_PROXYPASSWORD, proxy.pass ?? null);
        handle.setOpt(curl.CURLOPT_NOPROXY, proxy.noProxy ?? null);
    } else {
        clearCurlProxy(handle);
    }
    if (skipCertVerify) {
        handle.setOpt(curl.CURLOPT_SSL_VERIFYPEER, 0);
        handle.setOpt(curl.CURLOPT_SSL_VERIFYHOST, 0);
    }
}

function setNetworkCurlHooks(hook: typeof applyNetwork | null): void {
    setCnoCurlInitHook(hook);
    setCtsCurlInitHook(hook);
}

export function startProxy(): void {
    // Registry and environment settings must feed both curl and raw clients.
    const registry = win32?.HKCU !== undefined ? win32 : null;
    refreshConfig(registry);

    if (registry && watcher === null) {
        // A registry watch failure must not prevent hook installation.
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

    log.debug('http', () => config ? `successful setup proxy bypass: ${config.url}` : 'proxy not configured');
    setNetworkCurlHooks(applyNetwork);
    setRawConnectionHook(createProxyConnector(rawProxyFor));
}

export function disableCertVerify(): void {
    skipCertVerify = true;
    setNetworkCurlHooks(applyNetwork);
}

export function stopNetwork(): void {
    // RegWatch close/finalize blocks; retain the unreferenced process-lifetime handle.
    watcher?.unref();
    config = null;
    rawConfigs = { ...NO_PROXIES };
    setNetworkCurlHooks(null);
    setRawConnectionHook(null);
}

export function getProxyInfo(): ProxyConfig | null {
    return config;
}
