import { strictEqual } from 'node:assert';
import { CliCommandError, CliExit, commandErrorInfo } from '../../src/command-error.ts';

Deno.test('cli command error preserves the original error and display context', () => {
    const original = new Error('entry failed');
    const error = new CliCommandError(original, '<eval>');

    strictEqual(error.original, original);
    strictEqual(error.context, '<eval>');
    const info = commandErrorInfo(error);
    strictEqual(info.error, original);
    strictEqual(info.context, '<eval>');
});

Deno.test('cli exit carries a previously reported command status', () => {
    const exit = new CliExit(17);

    strictEqual(exit.code, 17);
});
