import { strictEqual, throws } from 'node:assert';

Deno.test('deno cron: rejects invalid names schedules and handlers', () => {
    throws(
        () => Deno.cron(undefined as unknown as string, '* * * * *', () => {}),
        /name must be a non-empty string/,
    );
    throws(
        () => Deno.cron('missing-schedule', undefined as unknown as string, () => {}),
        /schedule must be a cron string or object/,
    );
    throws(
        () => Deno.cron('', '* * * * *', () => {}),
        /name must be a non-empty string/,
    );
    throws(
        () => Deno.cron('abc[]', '* * * * *', () => {}),
        /invalid name/,
    );
    throws(
        () => Deno.cron('a'.repeat(65), '* * * * *', () => {}),
        /cannot exceed 64 characters/,
    );
    throws(
        () => Deno.cron('bad-fields', '* * * *', () => {}),
        /expected 5 cron fields/,
    );
    throws(
        () => Deno.cron('bad-minute', '60 * * * *', () => {}),
        /minute value 60 is out of range/,
    );
    throws(
        () => Deno.cron('bad-handler', '* * * * *', {}),
        /handler must be a function/,
    );
    throws(
        () => Deno.cron('bad-schedule-type', null as unknown as string, () => {}),
        /schedule must be a cron string or object/,
    );
    throws(
        () => Deno.cron('bad-month-name', '* * * nope *', () => {}),
        /invalid month value "nope"/,
    );
    throws(
        () => Deno.cron('bad-step-zero', '*/0 * * * *', () => {}),
        /invalid minute step/,
    );
    throws(
        () => Deno.cron('two-handlers', '* * * * *', () => {}, () => {}),
        /single handler is required: two handlers were specified/,
    );
});

Deno.test('deno cron: validates object schedules and backoff options before scheduling', () => {
    throws(
        () => Deno.cron('bad-exact', { minute: { exact: [] } }, () => {}),
        /minute\.exact cannot be empty/,
    );
    throws(
        () => Deno.cron('bad-range', { hour: { start: 12, end: 2 } }, () => {}),
        /hour range start 12 must be <= end 2/,
    );
    throws(
        () => Deno.cron('bad-backoff', '* * * * *', { backoffSchedule: [1.5] }, () => {}),
        /backoffSchedule values must be non-negative integers/,
    );
    throws(
        () => Deno.cron('bad-backoff-shape', '* * * * *', { backoffSchedule: 'x' as unknown as number[] }, () => {}),
        /backoffSchedule must be an array/,
    );
    throws(
        () => Deno.cron('bad-backoff-max', '* * * * *', { backoffSchedule: [60 * 60 * 1000 + 1] }, () => {}),
        /backoffSchedule values must be <= 3600000/,
    );
    throws(
        () => Deno.cron('too-many-backoffs', '* * * * *', { backoffSchedule: [1, 2, 3, 4, 5, 6] }, () => {}),
        /backoffSchedule can contain at most 5 entries/,
    );
    throws(
        () => Deno.cron('bad-every-object', { minute: { every: 0 } }, () => {}),
        /minute step must be a positive integer/,
    );
    throws(
        () => Deno.cron('bad-day-name-object', { dayOfWeek: { exact: [8] } }, () => {}),
        /dayOfWeek value 8 is out of range/,
    );
});

Deno.test('deno cron: pre-aborted signal accepts valid schedules without running handler', async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));

    await Deno.cron('aborted-string', '*/5 1-3 * jan mon', { signal: controller.signal }, () => {
        called = true;
    });
    await Deno.cron('aborted-object', {
        minute: { start: 0, end: 30, every: 15 },
        hour: { exact: [1, 2] },
        dayOfWeek: { exact: [0, 7] },
    }, { signal: controller.signal }, () => {
        called = true;
    });

    strictEqual(called, false);
});

Deno.test('deno cron: active jobs reject duplicate names and resolve when aborted', async () => {
    const controller = new AbortController();
    let settled = false;
    const job = Deno.cron('unique-active-cron', '* * * * *', { signal: controller.signal }, () => {});
    job.then(() => {
        settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    strictEqual(settled, false);
    throws(
        () => Deno.cron('unique-active-cron', '* * * * *', () => {}),
        /already exists/,
    );

    controller.abort(new DOMException('stop', 'AbortError'));
    await job;
    strictEqual(settled, true);

    const next = new AbortController();
    const reused = Deno.cron('unique-active-cron', '* * * * *', { signal: next.signal }, () => {});
    next.abort();
    await reused;
});

Deno.test('deno cron: rejects once the active cron job limit is reached', async () => {
    const controller = new AbortController();
    const jobs: Promise<void>[] = [];
    try {
        for (let i = 0; i < 100; i++) {
            jobs.push(Deno.cron(`limit-cron-${i}`, '* * * * *', { signal: controller.signal }, () => {}));
        }
        throws(
            () => Deno.cron('limit-cron-next', '* * * * *', { signal: controller.signal }, () => {}),
            /too many cron jobs/,
        );
    } finally {
        controller.abort();
        await Promise.allSettled(jobs);
    }
});
