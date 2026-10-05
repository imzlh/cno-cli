import { hasSchemeId, resolvePath } from '../cts/src/api';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

/** Read an environment variable without turning an unset value into an exception. */
export function readEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}
export type EnvWarn = (message: string) => void;

function resolveEnvFilePath(path: string): string {
    if (hasSchemeId(path) && !path.startsWith('/')) return path;
    return resolvePath(os.cwd, path);
}

function expand(value: string, vars: Record<string, string>): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) =>
        vars[name] ?? readEnv(name) ?? '',
    );
}

function closingDoubleQuote(value: string): number {
    let escaped = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i]!;
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === '"') {
            return i;
        }
    }
    return -1;
}

function parseEnvFile(
    text: string,
    path: string,
    base: Record<string, string>,
    warn?: EnvWarn,
): Record<string, string> | null {
    const vars = { ...base };
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;

        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
        if (!match) {
            warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
            return null;
        }

        let value = match[2] ?? '';
        if (value.startsWith('"')) {
            value = value.slice(1);
            while (closingDoubleQuote(value) === -1) {
                const next = lines[++i];
                if (next === undefined) {
                    warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
                    return null;
                }
                value += `\n${next}`;
            }
            const end = closingDoubleQuote(value);
            const rest = value.slice(end + 1).trim();
            if (rest !== '' && !rest.startsWith('#')) {
                warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
                return null;
            }
            value = value.slice(0, end)
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        } else {
            const comment = value.search(/\s#/);
            if (comment !== -1) value = value.slice(0, comment);
            value = value.trim();
            if (/\\(?![\\#$"'nrt])/u.test(value)) {
                warn?.(`Failed to parse env file "${path}" at line ${i + 1}`);
                return null;
            }
        }

        vars[match[1]!] = expand(value, vars);
    }
    return vars;
}

export function loadEnvFiles(paths: string[], warn?: EnvWarn): void {
    let vars: Record<string, string> = {};
    for (const path of paths) {
        try {
            const parsed = parseEnvFile(engine.decodeString(fs.readFile(resolveEnvFilePath(path))), path, vars, warn);
            if (parsed !== null) {
                vars = parsed;
                for (const [name, value] of Object.entries(vars)) os.setenv(name, value);
            }
        } catch (error) {
            warn?.(`Failed to load env file "${path}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
