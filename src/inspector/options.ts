export interface InspectOptions {
    port: number;
    host: string;
    breakOnStart: boolean;
    waitForClient: boolean;
}

/** Interpret normalized kernel options; command and script tokens never reach here. */
export function inspectOptions(flags: Record<string, string | boolean>): InspectOptions | null {
    const has = (name: string) => Object.hasOwn(flags, name) && flags[name] !== false;
    const breakOnStart = has('inspect-brk');
    const waitForClient = has('inspect-wait');
    if (!has('inspect') && !breakOnStart && !waitForClient) return null;
    const raw = breakOnStart ? flags['inspect-brk'] : waitForClient ? flags['inspect-wait'] : flags.inspect;
    return { ...inspectAddress(raw), breakOnStart, waitForClient };
}

function inspectAddress(raw: string | boolean | undefined): Pick<InspectOptions, 'host' | 'port'> {
    if (typeof raw !== 'string' || raw === 'true') return { host: '127.0.0.1', port: 9229 };
    const address = raw.trim();
    if (!address) throw new Error('Inspector address must not be empty');

    const parsePort = (value: string): number => {
        const port = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port > 65535) {
            throw new Error(`Invalid Inspector port: ${value}`);
        }
        return port;
    };
    if (/^\d+$/.test(address)) return { host: '127.0.0.1', port: parsePort(address) };

    const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(address);
    if (bracketed) return { host: bracketed[1]!, port: bracketed[2] === undefined ? 9229 : parsePort(bracketed[2]) };
    if (address.includes('[') || address.includes(']') || /\s/.test(address)) {
        throw new Error(`Invalid Inspector address: ${address}`);
    }
    const colon = address.indexOf(':');
    if (colon !== -1 && colon === address.lastIndexOf(':')) {
        return { host: address.slice(0, colon) || '127.0.0.1', port: parsePort(address.slice(colon + 1)) };
    }
    return { host: address, port: 9229 };
}
