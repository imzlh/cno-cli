/** Error propagated so the CLI entry point can report it after cleanup. */
export class CliCommandError extends Error {
    constructor(
        readonly original: unknown,
        readonly context?: string,
    ) {
        super('CLI command failed');
        this.name = 'CliCommandError';
    }
}

/** A command already reported its diagnostic and only needs a clean exit. */
export class CliExit extends Error {
    constructor(readonly code: number) {
        super(`CLI exited with code ${code}`);
        this.name = 'CliExit';
    }
}

export function commandErrorInfo(error: unknown): { error: unknown; context?: string } {
    if (error instanceof CliCommandError) {
        return { error: error.original, context: error.context };
    }
    return { error };
}
