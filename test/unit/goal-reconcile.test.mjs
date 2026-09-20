import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldGoalFacts } from '../../lib/goal-facts.js';
import { classifyTodoKind, reconcileTodos } from '../../lib/goal-reconcile.js';

const ev = (type, data, seq = 0) => ({ type, seq, time: seq, data });
const toolCall = (seq, callId, command) =>
  ev('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) }, seq);
const toolResult = (seq, callId, { isError = false, content = 'ok', code } = {}) =>
  ev('tool/result', {
    turn: 1,
    step: 1,
    message: { source: { callId }, content: [{ type: 'tool', isError, content }] },
    ...(code === undefined ? {} : { error: { name: 'ToolError', code } }),
  }, seq);

test('classifyTodoKind: release-commit push is git_push not github_release', () => {
  assert.equal(classifyTodoKind('C12 push release commit'), 'git_push');
  assert.equal(classifyTodoKind('C13 创建并 push annotated tag'), 'git_tag');
  assert.equal(classifyTodoKind('npm publish'), 'npm_publish');
  assert.equal(classifyTodoKind('GitHub Release'), 'github_release');
});

test('classifyTodoKind ignores negated, discussed and quoted wording', () => {
  // Negation / prohibition (EN)
  for (const text of [
    'Do not push yet',
    "Don't create a tag",
    'never run npm publish',
    'Audit without pushing or tagging',
    'avoid publishing to npm',
  ]) {
    assert.equal(classifyTodoKind(text), undefined, text);
  }
  // Discussion / reference (EN)
  for (const text of [
    'The docs describe how git push works',
    'Discuss the npm publish policy',
    'Explain the GitHub Release checklist',
    'Reference: tag naming convention',
  ]) {
    assert.equal(classifyTodoKind(text), undefined, text);
  }
  // Quotation (EN + CN)
  for (const text of [
    'The error message says "git push failed"',
    'quote `npm publish` from the README',
    '解释「创建 GitHub Release」这句话',
    '说明“npm 发布”是什么意思',
  ]) {
    assert.equal(classifyTodoKind(text), undefined, text);
  }
  // Prohibition / discussion (CN)
  for (const text of [
    '不要推送',
    '禁止打标签',
    '无需发布 npm 包',
    '讨论 npm publish 的流程',
  ]) {
    assert.equal(classifyTodoKind(text), undefined, text);
  }
  // Positive wording still classifies.
  assert.equal(classifyTodoKind('push the branch'), 'git_push');
  assert.equal(classifyTodoKind('创建并推送 tag v1.0.0'), 'git_tag');
});

test('a negated todo is never promoted to completed by a matching fact', () => {
  const events = [
    ev('todo/write', { todos: [{ content: 'Do not push yet', status: 'pending' }] }, 1),
    toolCall(2, 'c1', 'git push origin main'),
    toolResult(3, 'c1'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ];
  const todos = reconcileTodos({ facts: foldGoalFacts(events) });
  assert.deepEqual(todos, [{ content: 'Do not push yet', status: 'pending' }]);
});

test('Test A — successful git push fact completes a pending push todo', () => {
  const events = [
    ev('todo/write', { todos: [{ content: 'C12 push release commit', status: 'pending' }] }, 1),
    ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'push succeeded' }] } }, 2),
    toolCall(3, 'c1', 'git push origin main'),
    toolResult(4, 'c1'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  ];
  const facts = foldGoalFacts(events);
  const todos = reconcileTodos({ facts });
  assert.deepEqual(todos, [{ content: 'C12 push release commit', status: 'completed' }]);
});

test('assistant summary "push succeeded" does not complete a todo without a tool fact', () => {
  const events = [
    ev('todo/write', { todos: [{ content: 'C12 push release commit', status: 'pending' }] }, 1),
    ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'push succeeded' }] } }, 2),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ];
  const todos = reconcileTodos({ facts: foldGoalFacts(events) });
  assert.deepEqual(todos, [{ content: 'C12 push release commit', status: 'pending' }]);
});

test('Test B — waiting npm publish stays in_progress and is not marked completed', () => {
  const events = [
    ev('todo/write', {
      todos: [
        { content: 'tag', status: 'completed' },
        { content: 'npm publish', status: 'pending' },
      ],
    }, 1),
    toolCall(2, 'c1', 'npm publish'),
    toolResult(3, 'c1', { isError: true, content: 'npm ERR! EOTP Authenticate your account', code: 'EOTP' }),
  ];
  const facts = foldGoalFacts(events);
  const todos = reconcileTodos({ facts, waitingKinds: ['npm_publish'], holdInProgress: true });
  assert.equal(todos.find((todo) => todo.content === 'npm publish').status, 'in_progress');
  assert.notEqual(todos.find((todo) => todo.content === 'npm publish').status, 'completed');
});

test('agent-authored completed is never rolled back', () => {
  const events = [
    ev('todo/write', { todos: [{ content: 'C12 push release commit', status: 'completed' }] }, 1),
  ];
  const todos = reconcileTodos({ facts: foldGoalFacts(events) });
  assert.equal(todos[0].status, 'completed');
});
