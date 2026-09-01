const engine = import.meta.use('engine');
const streams = import.meta.use('streams');

const NEWLINE = 0x0a;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

export interface TestChildMessage {
    passed?: boolean;
    error?: unknown;
    failedTests?: unknown;
}

export type TestResultPipeOutcome =
    | { kind: 'result'; message: TestChildMessage }
    | { kind: 'closed' }
    | { kind: 'error'; error: unknown };

export interface TestResultPipeReader {
    readonly outcome: Promise<TestResultPipeOutcome>;
    readonly message: TestChildMessage | undefined;
    close(): void;
}

function isMessage(value: unknown): value is TestChildMessage {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findNewline(bytes: Uint8Array): number {
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === NEWLINE) return i;
    }
    return -1;
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
    const frame = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        frame.set(chunk, offset);
        offset += chunk.length;
    }
    return frame;
}

function stopAndClose(pipe: CModuleStreams.Pipe): void {
    pipe.stopRead();
    pipe.close();
}

// fd 3 carries one one-way JSON result frame, not a Node IPC channel.
export function readTestChildResult(pipe: CModuleStreams.Pipe): TestResultPipeReader {
    let done = false;
    let resolveOutcome!: (outcome: TestResultPipeOutcome) => void;
    const outcome = new Promise<TestResultPipeOutcome>((resolve) => {
        resolveOutcome = resolve;
    });
    const chunks: Uint8Array[] = [];
    let length = 0;
    let message: TestChildMessage | undefined;

    const finish = (value: TestResultPipeOutcome): void => {
        if (done) return;
        done = true;
        resolveOutcome(value);
    };

    pipe.onread = (data: Uint8Array | null | undefined, error?: CModuleError.Error) => {
        if (done) return;
        if (error) {
            finish({ kind: 'error', error });
            return;
        }
        if (data === null || data === undefined) {
            finish(message === undefined ? { kind: 'closed' } : { kind: 'result', message });
            return;
        }

        const chunk = new Uint8Array(data);
        if (message !== undefined) {
            if (chunk.length > 0) {
                finish({ kind: 'error', error: new Error('test worker wrote more than one result frame') });
            }
            return;
        }
        const delimiter = findNewline(chunk);
        const part = delimiter < 0 ? chunk : chunk.subarray(0, delimiter);
        if (length + part.length > MAX_RESULT_BYTES) {
            finish({ kind: 'error', error: new RangeError('test worker result exceeds 64 MiB') });
            return;
        }
        chunks.push(part);
        length += part.length;
        if (delimiter < 0) return;

        try {
            const value: unknown = JSON.parse(engine.decodeString(joinChunks(chunks, length)));
            if (!isMessage(value)) throw new TypeError('test worker result must be a JSON object');
            if (delimiter + 1 !== chunk.length) {
                throw new TypeError('test worker wrote more than one result frame');
            }
            message = value;
        } catch (error) {
            finish({ kind: 'error', error: new Error(`invalid test worker result: ${String(error)}`) });
        }
    };

    try {
        pipe.startRead();
    } catch (error) {
        finish({ kind: 'error', error });
    }

    return {
        outcome,
        get message(): TestChildMessage | undefined {
            return message;
        },
        close(): void {
            finish({ kind: 'closed' });
            stopAndClose(pipe);
        },
    };
}

export async function writeTestChildResult(message: TestChildMessage): Promise<void> {
    const json = JSON.stringify(message);
    if (json === undefined) throw new TypeError('test worker result could not be serialized');

    const pipe = new streams.Pipe();
    try {
        pipe.open(3);
        await pipe.write(engine.encodeString(json + '\n'));
        await pipe.shutdown();
    } finally {
        pipe.close();
    }
}
