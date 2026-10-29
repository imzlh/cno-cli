import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

Deno.test('sqlite: prepare options configure each statement', () => {
    const db = new DatabaseSync(':memory:');
    try {
        const statement = db.prepare(
            'SELECT 9007199254740993 AS value, :name AS name',
            {
                readBigInts: true,
                returnArrays: true,
                allowBareNamedParameters: false,
                allowUnknownNamedParameters: true,
            },
        );

        deepStrictEqual(statement.get({ ':name': 'cno', ':ignored': 1 }), [9007199254740993n, 'cno']);
        const strictNames = db.prepare('SELECT :name AS name', {
            allowBareNamedParameters: false,
        });
        throws(() => strictNames.get({ name: 'cno' }), ReferenceError);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: prepare options inherit database defaults and can override them', () => {
    const db = new DatabaseSync(':memory:', {
        readBigInts: true,
        returnArrays: true,
        allowBareNamedParameters: false,
        allowUnknownNamedParameters: true,
    });
    try {
        deepStrictEqual(
            db.prepare('SELECT 9007199254740993 AS value, :name AS name')
                .get({ ':name': 'inherited', ':ignored': 1 }),
            [9007199254740993n, 'inherited'],
        );

        const overridden = db.prepare('SELECT 7 AS value, :name AS name', {
            readBigInts: false,
            returnArrays: false,
            allowBareNamedParameters: true,
            allowUnknownNamedParameters: false,
        }).get({ name: 'overridden' }) as { value: number; name: string };
        strictEqual(overridden.value, 7);
        strictEqual(overridden.name, 'overridden');

        db.exec('CREATE TABLE changes_test(value INTEGER)');
        deepStrictEqual(
            db.prepare('INSERT INTO changes_test VALUES (1)').run(),
            { changes: 1n, lastInsertRowid: 1n },
        );

        deepStrictEqual(
            db.prepare('SELECT 1 AS value', { allowUnknownNamedParameters: true }).get({ ignored: 1 }),
            [1n],
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: database and prepare boolean options are validated', () => {
    for (const name of [
        'readBigInts',
        'returnArrays',
        'allowBareNamedParameters',
        'allowUnknownNamedParameters',
    ]) {
        throws(
            () => new DatabaseSync(':memory:', { [name]: 1 } as never),
            (error: Error & { code?: string }) => {
                strictEqual(error.code, 'ERR_INVALID_ARG_TYPE');
                return true;
            },
        );

        const db = new DatabaseSync(':memory:');
        try {
            throws(
                () => db.prepare('SELECT 1', { [name]: 1 } as never),
                (error: Error & { code?: string }) => {
                    strictEqual(error.code, 'ERR_INVALID_ARG_TYPE');
                    return true;
                },
            );
        } finally {
            db.close();
        }
    }
});
