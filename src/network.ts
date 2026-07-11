import { setCurlInitHook, setRawConnectionHook } from '../cno/src/utils/network-hooks';
import { createProxyConnector, type ProxyConfig, type ProxyType } from '../cno/src/utils/proxy';
import { log } from '../cts/src/api';

const os    = import.meta.use('os');
const curl  = import.meta.use('curl');
const win32 = import.meta.use('win32');

const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const;
const PROXY_PROTOCOL_SET = new Set<string>(PROXY_PROTOCOLS);

const REG_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let config:  ProxyConfig | null = null;
let rawConfigs: { http: ProxyConfig | null; https: ProxyConfig | null } = { http: null, https: null };
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

function readEnv(): void {
    const noProxy = env('NO_PROXY') ?? env('no_proxy');
    const all = env('ALL_PROXY') ?? env('all_proxy');
    const http = env('HTTP_PROXY') ?? env('http_proxy') ?? all;
    const https = env('HTTPS_PROXY') ?? env('https_proxy') ?? all ?? http;
    rawConfigs = {
        http: http ? { ...parseProxyUrl(http), noProxy } : null,
        https: https ? { ...parseProxyUrl(https), noProxy } : null,
    };
    config = rawConfigs.https ?? rawConfigs.http;
}

function parseRegistryProxies(server: string, noProxy: string | null): { http: ProxyConfig | null; https: ProxyConfig | null } {
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

function readRegistry(registry: NonNullable<typeof win32>): void {
    try {
        if (!registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyEnable')) {
            config = null;
            rawConfigs = { http: null, https: null };
            return;
        }
        const server = registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyServer');
        if (typeof server !== 'string' || !server) {
            config = null;
            rawConfigs = { http: null, https: null };
            return;
        }

        let noProxy: string | null = null;
        try {
            const bypass = registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyOverride');
            if (typeof bypass === 'string') {
                noProxy = bypass.replace(/;/g, ',').replace(/<local>/gi, '<local>,localhost,127.0.0.1,::1');
            }
        } catch { /* ProxyOverride not present */ }

        rawConfigs = parseRegistryProxies(server, noProxy);
        config = rawConfigs.https ?? rawConfigs.http;
    } catch { config = null; rawConfigs = { http: null, https: null }; }
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
    if (win32?.HKCU !== undefined) {
        const registry = win32;
        readRegistry(registry);
        watcher = registry.watchRegistry(registry.HKCU, REG_KEY, () => {
            readRegistry(registry);
        });
    } else {
        readEnv();
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
    watcher?.close();
    watcher = null;
    config = null;
    rawConfigs = { http: null, https: null };
    setCurlInitHook(null);
    setRawConnectionHook(null);
}

export function getProxyInfo(): ProxyConfig | null {
    return config;
}
