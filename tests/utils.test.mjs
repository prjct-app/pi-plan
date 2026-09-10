import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanStepText,
  extractTodoItems,
  extractVerification,
  isSafeCommand,
  markCompletedSteps,
  progressBar,
} from '../src/utils.ts';

test('extractTodoItems keeps imperative verbs and concrete file references', () => {
  const items = extractTodoItems('Plan:\n1. Delete the deprecated flag in src/config.ts\n2. Remove unused imports from index.ts');
  assert.deepEqual(items.map((i) => i.text), [
    'Delete the deprecated flag in src/config.ts',
    'Remove unused imports from index.ts',
  ]);
});

test('extractTodoItems accepts markdown variants and skips sub-bullets', () => {
  const items = extractTodoItems([
    '**Approach:** incremental',
    '',
    '## **Plan:**',
    '1. **Add parser** to src/utils.ts',
    '   - touches only the parser module',
    '2. Wire the parser into src/index.ts',
  ].join('\n'));
  assert.deepEqual(items.map((i) => i.text), ['Add parser to src/utils.ts', 'Wire the parser into src/index.ts']);
});

test('extractTodoItems stops at the end of the plan section', () => {
  const message = 'Plan:\n1. Inspect the code\n\n**Verify:**\n1. npm test\n2. npm run check';
  assert.deepEqual(extractTodoItems(message).map((i) => i.text), ['Inspect the code']);
});

test('extractTodoItems returns nothing without a Plan header', () => {
  assert.deepEqual(extractTodoItems('1. Not a plan\n2. Still not'), []);
});

test('extractVerification reads inline and multiline verify sections', () => {
  assert.equal(extractVerification('Plan:\n1. Do it\n\n**Verify:** npm test\n\n**Risks:** none'), 'npm test');
  assert.equal(extractVerification('Verify:\n- `npm run check`\n- npm test'), 'npm run check; npm test');
  assert.equal(extractVerification('Plan:\n1. Do it'), undefined);
});

test('cleanStepText strips markdown but never verbs', () => {
  assert.equal(cleanStepText('**Update** the `schema.ts` model'), 'Update the schema.ts model');
  assert.equal(cleanStepText('Delete   stale   fixtures'), 'Delete stale fixtures');
  assert.equal(cleanStepText('x'.repeat(120)).length, 100);
});

test('isSafeCommand allows read-only inspection and blocks mutations', () => {
  for (const command of ['git status', 'git log --oneline', 'cat package.json', 'rg pattern src', 'nl -ba src/index.ts']) {
    assert.equal(isSafeCommand(command), true, command);
  }
  for (const command of [
    'rm -rf dist',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} +',
    'sed -i.bak s/a/b/ file.ts',
    'perl -pi -e s/a/b/ file.ts',
    'git checkout main',
    'git restore .',
    'git clean -fd',
    'npm install',
    'echo hi > file.txt',
    'ls | xargs rm',
  ]) {
    assert.equal(isSafeCommand(command), false, command);
  }
});

test('markCompletedSteps marks only listed steps', () => {
  const items = [
    { step: 1, text: 'a', completed: false },
    { step: 2, text: 'b', completed: false },
  ];
  assert.equal(markCompletedSteps('done [DONE:1] and [DONE:9]', items), 2);
  assert.deepEqual(items.map((i) => i.completed), [true, false]);
});

test('progressBar renders partial and complete ratios', () => {
  assert.equal(progressBar(0, 4, 4), '░░░░');
  assert.equal(progressBar(2, 4, 4), '██░░');
  assert.equal(progressBar(4, 4, 4), '████');
});
