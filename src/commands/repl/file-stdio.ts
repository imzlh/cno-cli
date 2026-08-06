/**
 * File-backed stdio handles for the REPL.
 *
 * `streams` exposes exactly three handle classes — TTY, Pipe and TCP — and no
 * file-backed one (circu.js/src/mod_streams.c:1682). The REPL therefore used to
 * treat "not a tty" as "must be a pipe" and called `Pipe.open(fd)`
 * unconditionally, which lands in `uv_pipe_open()`
 * (circu.js/src/mod_streams.c:tjs_pipe_open). libuv rejects a regular-file
 * handle there, so redirecting either end of the REPL to a plain file crashed
 * the process before the first prompt:
 *
 *   cno repl > out.txt   ->  ENOTSOCK: socket operation on non-socket  (fd 1)
 *   cno repl < in.txt    ->  EINVAL: invalid argument                  (fd 0)
 *
 * Two different errnos, one cause: libuv's Windows pipe layer diagnoses a
 * non-pipe write handle and a non-pipe read handle differently.
 *
 * `node --interactive` runs in all four {pipe,file} x {pipe,file} stdio
 * combinations and exits 0, so the contract is simply "work like a pipe".
 * These two classes provide the small slice of the `Stream` surface the REPL
 * actually consumes, implemented on the blocking sync-fs syscalls, which accept
 * a file fd happily:
 *
 *   stdout: write()
 *   stdin:  onread, startRead(), stopRead()
 *
 * Neither reports a window size, which is correct: `#refreshTermWidth()` and
 * `#update()` both early-return for a non-TTY, so the 80-column default and the
 * no-repaint guard stay in force and no escape storm is emitted.
 */

const os = import.meta.use('os');
const sfs = import.meta.use('fs');
const streams = import.meta.use('streams');

/** Read chunk size; matches libuv's default suggested pipe read size. */
const CHUNK_SIZE = 65536;

/** The only thing the REPL asks of stdout (`runner.ts` `#writeSync`). */
export interface ReplOutputHandle {
    write(buffer: Uint8Array): unknown;
}

/** onread's shape, per `CModuleStreams.Stream` (cno/types/streams.d.ts:26-38). */
export type ReplReadCallback = (
    result: Uint8Array | null | undefined,
    error: CModuleError.Error | undefined,
) => void;

/** The only things the REPL asks of stdin (`runner.ts` `#readInput`). */
export interface ReplInputHandle {
    onread: ReplReadCallback | undefined;
    startRead(): void;
    stopRead(): void;
}

/** stdout/stderr on a plain file: a blocking `write(2)` on the raw fd. */
export class FileOutput implements ReplOutputHandle {
    readonly #fd: number;

    constructor(fd: number) {
        this.#fd = fd;
    }

    get fd(): number {
        return this.#fd;
    }

    /**
     * `sfs.write` loops internally until the whole buffer is out
     * (circu.js/src/mod_fs.c tjs_syncfs_write), so there is no short-write case
     * to handle here. The REPL ignores the result; a number is returned rather
     * than a promise so a write failure surfaces as a synchronous throw at the
     * call site instead of an unhandled rejection.
     */
    write(buffer: Uint8Array): number {
        return sfs.write(this.#fd, buffer);
    }

    writeSync(buffer: Uint8Array): number {
        return sfs.write(this.#fd, buffer);
    }

    close(): void {
        /* fd 1 is owned by the process, not by this wrapper. */
    }
}

/**
 * stdin on a plain file, pumped to look like `uv_read_start`.
 *
 * `sfs.read` blocks, but on a regular file it returns immediately — including
 * at EOF, where it yields 0. The pump therefore reads a chunk, hands it to
 * `onread`, then yields to the microtask queue so the REPL's `#cmdQueue` can
 * evaluate what it just received before the next chunk arrives. Without that
 * yield a whole script would be dispatched in one burst ahead of any
 * evaluation.
 */
export class FileInput implements ReplInputHandle {
    onread: ReplReadCallback | undefined = undefined;

    readonly #fd: number;
    #buf = new Uint8Array(CHUNK_SIZE);
    #reading = false;
    #closed = false;
    /** Guards against two concurrent pumps across a stop/start cycle. */
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
        // libuv never invokes onread synchronously from uv_read_start, and the
        // REPL relies on that: `start()` calls `#readInput()` before it awaits
        // `#readLineLoop()`, so a synchronous first dispatch would arrive
        // before there is a readline resolver to satisfy.
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
            // Yield once before the first read, for the reason in startRead().
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
                // A stopRead() that landed during the read wins: drop the data
                // rather than deliver it to a REPL that has stopped listening.
                if (!this.#reading || this.#closed) return;
                if (n === null || n <= 0) {
                    this.#reading = false;
                    this.onread?.(null, undefined);  // EOF
                    return;
                }
                // runner.ts copies with .slice() before its async gap, so
                // handing out a view of the reused buffer is safe.
                this.onread?.(this.#buf.subarray(0, n), undefined);
                await Promise.resolve();
            }
        } finally {
            this.#pumping = false;
        }
    }
}

/**
 * Pick a write handle for `fd`. Only fds libuv can actually adopt as a pipe go
 * through `Pipe.open()`; everything else — a regular file, NUL/dev-null, an
 * fd libuv cannot classify — gets the fd shim.
 *
 * Precondition: `fd` is not a TTY. The caller checks that first and builds a
 * `streams.TTY` itself, because a TTY also needs raw-mode and window-size
 * handling that has nothing to do with choosing a handle class. Passing a TTY
 * fd here yields a `FileOutput`, which writes correctly but reports no window
 * size.
 *
 * The allowlist is deliberately positive rather than "try Pipe and fall back":
 * `new streams.Pipe()` initialises a libuv handle that holds a loop reference,
 * so a failed `open()` would leave a handle keeping the process alive. The
 * catch below closes it for exactly that reason.
 */
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

/** As `openReplOutput`, for the read end. */
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
