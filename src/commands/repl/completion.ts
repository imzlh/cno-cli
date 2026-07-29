/** Property-path Tab completion against live objects. */
export interface CompletionResult {
    completions: string[];
    position: number;
    context: unknown;
}

export class CompletionEngine {
    getCompletions(line: string, pos: number): CompletionResult {
        const word = this.#getContextWord(line, pos);
        try {
            const ctxObj = this.#getContextObject(line, pos - word.length);
            const completions = this.#enumerateProperties(ctxObj, word);
            return { completions, position: word.length, context: ctxObj };
        } catch {
            // Completion must never make the input queue unusable when a
            // proxy trap or accessor throws while resolving a property path.
            return { completions: [], position: word.length, context: undefined };
        }
    }

    #getContextWord(line: string, pos: number): string {
        let s = '';
        while (pos > 0 && this.#isWordChar(line[pos - 1] ?? '')) s = line[--pos] + s;
        return s;
    }

    #getContextObject(line: string, pos: number): unknown {
        const prev = line[pos - 1];
        if (pos <= 0 || prev === undefined || ' ~!%^&*(-+={[|:;,<>?/'.includes(prev)) return globalThis;
        if (line[pos - 1] !== '.') return undefined;

        pos--;
        const c = line[pos - 1];
        switch (c) {
            case undefined: return '';
            case "'": case '"': return 'a';
            case ']': return [];
            case '}': return {};
            case '/': return / /;
            default:
                if (this.#isWordChar(c)) {
                    const base = this.#getContextWord(line, pos);
                    switch (base) {
                        case 'true': return true;
                        case 'false': return false;
                        case 'null': return null;
                        case 'this': return globalThis;
                        case 'undefined': return undefined;
                        case 'NaN': return NaN;
                        case 'Infinity': return Infinity;
                        default: break;
                    }
                    if (!Number.isNaN(+base)) return +base;
                    // Check for regex flags
                    if (pos - base.length >= 2 && line[pos - base.length - 1] === '/') {
                        return new RegExp('', base);
                    }
                    const obj = this.#getContextObject(line, pos - base.length);
                    if (obj == null) return obj;
                    return Reflect.get(Object(obj), base);
                }
                return {};
        }
    }

    #enumerateProperties(obj: unknown, prefix: string): string[] {
        const seen = new Set<string>();
        const results: string[] = [];

        for (let i = 0, curr = obj; i < 10 && curr != null; i++, curr = Object.getPrototypeOf(curr)) {
            for (const key of Object.getOwnPropertyNames(curr)) {
                if (typeof key === 'string' && !/^\d+$/.test(key) && key.startsWith(prefix) && !seen.has(key)) {
                    seen.add(key);
                    results.push(key);
                }
            }
        }

        return results.sort((a, b) => {
            if (a[0] === '_' && b[0] !== '_') return 1;
            if (b[0] === '_' && a[0] !== '_') return -1;
            return a.localeCompare(b);
        });
    }

    #isWordChar(c: string) { return /[a-zA-Z0-9_$]/.test(c); }
}
