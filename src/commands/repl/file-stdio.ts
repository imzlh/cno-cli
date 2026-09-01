/** File-backed stdin/stdout adapters for redirected REPL streams. */

const os = import.meta.use('os');
const sfs = import.meta.use('fs');
const streams = import.meta.use('streams');

const CHUNK_SIZE = 65536;

export interface ReplOutputHandle {
    write(buffer: Uint8Array): unknown;
}

export type ReplReadCallback = (
    result: Uint8Array | null | undefined,
    error: CModuleError.Error | undefined,
) => void;

export interface ReplInputHandle {
    onread: ReplReadCallback | undefined;
    startRead(): void;
    stopRead(): void;
}

export class FileOutput implements ReplOutputHandle {
    readonly #fd: number;

    constructor(fd: number) {
        this.#fd = fd;
    }

    get fd(): number {
        return this.#fd;
    }

    write(buffer: Uint8Array): number {
        return sfs.write(this.#fd, buffer);
    }

    close(): void {
        // The process owns the file descriptor.
    }
}

/** stdin on a plain file, pumped with the stream read callback shape. */
export class FileInput implements ReplInputHandle {
    onread: ReplReadCallback | undefined = undefined;

    readonly #fd: number;
    #buf = new Uint8Array(CHUNK_SIZE);
    #reading = false;
    #closed = false;
    #pumping = false;

    constructor(fd: number) {
        this.#fd = fd;
    }

    get fd(): number {
        return this.#fd;
    }

    startRead(): void {
        if (this.#reading || this.#closed) return;
        this.#reading = true;
        if (this.#pumping) return;
        this.#pumping = true;
        // Preserve stream-like asynchronous delivery.
        void this.#pump();
    }

    stopRead(): void {
        this.#reading = false;
    }

    cancelRead(): void {
        this.#reading = false;
    }

    close(): void {
        this.#closed = true;
        this.#reading = false;
    }

    async #pump(): Promise<void> {
        try {
            await Promise.resolve();
            while (this.#reading && !this.#closed) {
                let n: number | null;
                try {
                    n = sfs.read(this.#fd, this.#buf);
                } catch (err) {
                    this.#reading = false;
                    this.onread?.(undefined, err as CModuleError.Error);
                    return;
                }
                if (!this.#reading || this.#closed) return;
                if (n === null || n <= 0) {
                    this.#reading = false;
                    this.onread?.(null, undefined);  // EOF
                    return;
                }
                this.onread?.(this.#buf.subarray(0, n), undefined);
                await Promise.resolve();
            }
        } finally {
            this.#pumping = false;
        }
    }
}

/** Use a native pipe when possible; otherwise write directly to the fd. */
export function openReplOutput(fd: number): ReplOutputHandle {
    const kind = guessKind(fd);
    if (kind === 'pipe' || kind === 'tcp') {
        const pipe = new streams.Pipe();
        try {
            pipe.open(fd);
            return pipe;
        } catch {
            try { pipe.close(); } catch { /* nothing left to do */ }
        }
    }
    return new FileOutput(fd);
}

export function openReplInput(fd: number): ReplInputHandle {
    const kind = guessKind(fd);
    if (kind === 'pipe' || kind === 'tcp') {
        const pipe = new streams.Pipe();
        try {
            pipe.open(fd);
            return pipe as unknown as ReplInputHandle;
        } catch {
            try { pipe.close(); } catch { /* nothing left to do */ }
        }
    }
    return new FileInput(fd);
}

function guessKind(fd: number): string {
    try {
        return String(os.guessHandle(fd));
    } catch {
        return 'unknown';
    }
}
