/** SQLite-backed REPL history: append each line immediately. */
const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

export const HISTORY_LIMIT = 1000;
export const HISTORY_DB_NAME = '.cno_history.sqlite';
/** Legacy plain-text history (pre-SQLite). */
export const HISTORY_TEXT_NAME = '.cno_history';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line TEXT NOT NULL,
    ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_id_desc ON history(id DESC);
`;

export interface HistoryStoreOptions {
    /** SQLite DB path; omit for memory-only. */
    path?: string | null;
    limit?: number;
}

export class HistoryStore {
    #lines: string[] = [];
    #index = 0;
    #draft = '';
    #limit: number;
    #path: string | null;
    #db: CModuleSQLite3.Sqlite3Handle | null = null;
    #insert: CModuleSQLite3.Sqlite3Stmt | null = null;
    #closed = false;

    constructor(opts: HistoryStoreOptions = {}) {
        this.#path = opts.path ?? null;
        const lim = opts.limit ?? HISTORY_LIMIT;
        this.#limit = lim > 0 ? Math.floor(lim) : HISTORY_LIMIT;
        this.#open();
    }

    get length(): number {
        return this.#lines.length;
    }

    get index(): number {
        return this.#index;
    }

    /** Snapshot of in-memory history (oldest → newest). */
    lines(): string[] {
        return this.#lines.slice();
    }

    /** Path of the SQLite file, or null if memory-only. */
    get path(): string | null {
        return this.#path;
    }

    #open(): void {
        if (!this.#path) return;
        try {
            this.#db = sqlite3.open(this.#path, sqlite3.O_CREATE | sqlite3.O_READWRITE);
            this.#db.exec('PRAGMA journal_mode = DELETE');
            // FULL so each append survives kill without waiting for close.
            this.#db.exec('PRAGMA synchronous = FULL');
            this.#db.exec('PRAGMA busy_timeout = 3000');
            this.#db.exec(SCHEMA);
            this.#insert = this.#db.prepare('INSERT INTO history(line, ts) VALUES(?, ?)');
            this.#loadFromDb();
        } catch {
            this.#closeDbQuietly();
            this.#db = null;
            this.#insert = null;
            // Keep whatever is already in memory; continue without disk.
        }
    }

    #loadFromDb(): void {
        if (!this.#db) return;
        try {
            const stmt = this.#db.prepare(
                'SELECT line FROM history ORDER BY id DESC LIMIT ?',
            );
            const rows = stmt.all([this.#limit]);
            stmt.finalize();
            // rows are newest-first; reverse to oldest → newest
            const lines: string[] = [];
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i];
                if (!row) continue;
                const line = row.line;
                if (typeof line === 'string' && line.length) lines.push(line);
            }
            this.#lines = lines;
            this.#index = this.#lines.length;
            this.#draft = '';
        } catch {
            this.#lines = [];
            this.#index = 0;
        }
    }

    /**
     * One-shot import of legacy `~/.cno_history` text if the DB is empty.
     * Does not remove the text file.
     */
    migrateFromTextFile(textPath: string): void {
        if (this.#lines.length > 0) return;
        let body: string;
        try {
            body = engine.decodeString(fs.readFile(textPath));
        } catch {
            return;
        }
        const raw = body.split('\n');
        for (const rawLine of raw) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (!line.length) continue;
            this.append(line);
        }
    }

    /** Seed from an external list (tests / explicit import). Does not write DB. */
    importLines(history: string[]): void {
        const cleaned: string[] = [];
        for (const line of history) {
            if (!line.length) continue;
            if (cleaned[cleaned.length - 1] === line) continue;
            cleaned.push(line);
        }
        this.#lines = cleaned.length > this.#limit
            ? cleaned.slice(-this.#limit)
            : cleaned;
        this.#index = this.#lines.length;
        this.#draft = '';
    }

    /**
     * Append one non-empty line and write it to SQLite immediately.
     * Consecutive duplicates are ignored.
     */
    append(line: string): boolean {
        if (!line.length) return false;
        if (this.#lines[this.#lines.length - 1] === line) return false;
        this.#lines.push(line);
        this.#writeRow(line);
        if (this.#lines.length > this.#limit) {
            this.#lines = this.#lines.slice(-this.#limit);
            this.#pruneDb();
        }
        this.#index = this.#lines.length;
        this.#draft = '';
        return true;
    }

    #writeRow(line: string): void {
        if (!this.#db || !this.#insert) return;
        try {
            this.#insert.run([line, Date.now()]);
        } catch {
            // best-effort
        }
    }

    #pruneDb(): void {
        if (!this.#db) return;
        try {
            // Nested SELECT required: SQLite rejects DELETE…ORDER BY LIMIT directly.
            this.#db.exec(
                `DELETE FROM history WHERE id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM history ORDER BY id DESC LIMIT ${this.#limit}
                    )
                )`,
            );
        } catch { /* best-effort */ }
    }

    resetCursor(): void {
        this.#index = this.#lines.length;
        this.#draft = '';
    }

    /** ↑ — previous entry. Returns the line to show, or null if none. */
    prev(current: string): string | null {
        if (this.#index <= 0) return null;
        if (this.#index === this.#lines.length) this.#draft = current;
        this.#index--;
        return this.#lines[this.#index] ?? '';
    }

    /** ↓ — next entry / draft. Returns the line to show, or null if none. */
    next(): string | null {
        if (this.#index >= this.#lines.length) return null;
        this.#index++;
        if (this.#index === this.#lines.length) return this.#draft;
        return this.#lines[this.#index] ?? '';
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#closeDbQuietly();
    }

    #closeDbQuietly(): void {
        try {
            this.#insert?.finalize();
        } catch {}
        this.#insert = null;
        try {
            this.#db?.close();
        } catch {}
        this.#db = null;
    }
}
