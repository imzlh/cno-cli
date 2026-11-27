import { appendFileSync, readFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
    console.error('Usage: node scripts/ci/report-build-errors.mjs <build-log>');
    process.exitCode = 2;
} else {
    const log = readFileSync(input, 'utf8').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const lines = log.split(/\r?\n/).filter(Boolean);
    const matches = lines.filter(line =>
        /\berror(?:\[[A-Z]\d+\])?(?:\s+[A-Z]\d{3,})?\s*:/i.test(line)
        || /\bCMake Error\b|\bundefined symbols for architecture\b|\bunresolved external symbol\b|\bLNK\d{4}\b/i.test(line)
    );
    const diagnostics = [...new Set(matches.length ? matches : lines.slice(-20))]
        .slice(0, 20)
        .map(line => line.slice(-600));
    const message = diagnostics.length ? diagnostics.join('\n') : 'Build failed without diagnostic output.';
    const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

    console.log(`::error title=Native build diagnostics::${escaped}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            `### Native build diagnostics\n\n\`\`\`text\n${message}\n\`\`\`\n`);
    }
}
