export function isLoopbackPermissionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('EPERM') || message.includes('operation not permitted');
}
