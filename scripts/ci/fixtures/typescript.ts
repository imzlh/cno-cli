interface Result {
    answer: number;
}

enum Value {
    Six = 6,
    Seven = 7,
}

const result = { answer: Value.Six * Value.Seven } satisfies Result;
const answer: number = await Promise.resolve(result.answer);
if (answer !== 42) throw new Error('TypeScript execution failed');
console.log('CNO_CI_TYPESCRIPT_OK');

export {};
