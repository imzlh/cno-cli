import { appendFileSync, readFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
    console.error('Usage: node scripts/ci/report-test-errors.mjs <runtime-test-log>');
    process.exitCode = 2;
} else {
    const log = readFileSync(input, 'utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const failures = new Map();
    let current = null;
    let readingFailures = false;
    for (const line of log.split(/\r?\n/)) {
        if (line === 'Failed tests:') {
            readingFailures = true;
            current = null;
            continue;
        }
        if (/^(?:=== shard |[✔✖] \d+\/\d+)/.test(line)) {
            readingFailures = false;
            current = null;
        }
        if (!readingFailures) continue;
        const header = /^ {2}(tests\/\S+\.[cm]?[jt]sx?) {2}(.+)$/.exec(line);
        if (header) {
            const file = header[1];
            const cases = failures.get(file) ?? [];
            current = { name: header[2], details: [] };
            cases.push(current);
            failures.set(file, cases);
        } else if (current && current.details.length < 12 && line.trim() && !/^\s+at /.test(line)) {
            current.details.push(line.trim());
        }
    }

    const escape = text => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    for (const [file, cases] of failures) {
        const message = cases.map(item => `${item.name}: ${item.details.join('\n')}`).join('\n').slice(0, 3000);
        console.log(`::error file=${file},title=Runtime test failure::${escape(message)}`);
    }
    const message = failures.size
        ? [...failures].map(([file, cases]) => `- \`${file}\`: ${cases.length} failed ${cases.length === 1 ? 'case' : 'cases'}`).join('\n')
        : 'Runtime tests failed before a per-file failure report. See the runtime log.';
    if (!failures.size) console.log(`::error title=Runtime test failure::${escape(message)}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Runtime test failures\n\n${message}\n`);
    }
}
