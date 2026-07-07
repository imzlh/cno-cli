import type { ConfigOptions } from '../../cts/src/api';

export function conditionsFromFlags(flags: Record<string, string | boolean>): string[] | undefined {
    const out: string[] = [];
    for (const key of ['conditions', 'C']) {
        const value = flags[key];
        if (typeof value !== 'string') continue;
        for (const part of value.split(',')) {
            const condition = part.trim();
            if (condition) out.push(condition);
        }
    }
    return out.length > 0 ? out : undefined;
}

export function applyNodeOptionConfig(cfg: Partial<ConfigOptions>, flags: Record<string, string | boolean>): void {
    const conditions = conditionsFromFlags(flags);
    if (conditions) cfg.conditions = conditions;
}
