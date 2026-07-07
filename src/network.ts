/**
 * Global network settings — applied to every CURL handle via CurlInitHook.
 *
 * Proxy: Windows registry (watched for live changes) / env vars.
 * TLS:   --skip-cert-verify disables certificate verification.
 */

import { setCurlInitHook } from '../cno/src/utils/network-hooks';
import { log } from '../cts/src/api';

const os    = import.meta.use('os');
const curl  = import.meta.use('curl');
const win32 = import.meta.use('win32');

const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const;
type ProxyType = typeof PROXY_PROTOCOLS[number];
const PROXY_PROTOCOL_SET = new Set<string>(PROXY_PROTOCOLS);

const REG_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

interface ProxyConfig {
    url:     string;
    type:    ProxyType;
    user:    string | null;
    pass:    string | null;
    noProxy: string | null;
}

let config:  ProxyConfig | null = null;
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

function parseProxyUrl(raw: string): Omit<ProxyConfig, 'noProxy'> {
    let input = raw.trim();
    if (!/^(https?|socks[45][ah]?):\/\//i.test(input)) input = 'http://' + input;
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
    const raw = env('HTTPS_PROXY') ?? env('HTTP_PROXY') ?? env('ALL_PROXY');
    config = raw ? { ...parseProxyUrl(raw), noProxy: env('NO_PROXY') } : null;
}

function readRegistry(registry: NonNullable<typeof win32>): void {
    try {
        if (!registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyEnable')) {
            config = null;
            return;
        }
        const server = registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyServer');
        if (typeof server !== 'string' || !server) {
            config = null;
            return;
        }

        let noProxy: string | null = null;
        try {
            const bypass = registry.readRegistry(registry.HKCU, REG_KEY, 'ProxyOverride');
            if (typeof bypass === 'string') {
                noProxy = bypass.replace(/;/g, ',').replace(/<local>/g, 'localhost,127.0.0.1');
            }
        } catch { /* ProxyOverride not present */ }

        config = { ...parseProxyUrl(server), noProxy };
    } catch { config = null; }
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
        watcher = registry.watchRegistry(registry.HKCU, REG_KEY, () => readRegistry(registry));
    } else {
        readEnv();
    }
    log.debug('http', () => config ? `successful setup proxy bypass: ${config.url}` : 'proxy not configured')
    setCurlInitHook(applyNetwork);
}

export function disableCertVerify(): void {
    skipCertVerify = true;
    setCurlInitHook(applyNetwork);
}

export function stopNetwork(): void {
    watcher?.close();
    watcher = null;
    config = null;
    setCurlInitHook(null);
}

export function getProxyInfo(): ProxyConfig | null {
    return config;
}
