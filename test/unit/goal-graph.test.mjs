import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldGoalFacts } from '../../lib/goal-facts.js';
import { reconcileTodos } from '../../lib/goal-reconcile.js';
import { buildGoalGraph, describeBlocked, detectDeferredKinds, inferBlockedKind } from '../../lib/goal-graph.js';
import { mapWaitGoal } from '../../lib/goal.js';

const ev = (type, data, seq) => ({ type, seq, time: seq, data });
const toolCall = (seq, callId, command) =>
  ev('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) }, seq);
const toolResult = (seq, callId, { isError = false, content = 'ok', code } = {}) =>
  ev('tool/result', {
    turn: 1,
    step: 1,
    message: { source: { callId }, content: [{ type: 'tool', isError, content }] },
    ...(code === undefined ? {} : { error: { name: 'ToolError', code } }),
  }, seq);

function releaseBlockedEvents() {
  return [
    ev('todo/write', {
      todos: [
        { content: 'C12 push release commit', status: 'completed' },
        { content: 'C13 创建并 push annotated tag', status: 'completed' },
        { content: 'npm publish', status: 'pending' },
        { content: 'GitHub Release', status: 'pending' },
      ],
    }, 1),
    toolCall(2, 'c1', 'git push origin main'),
    toolResult(3, 'c1'),
    toolCall(4, 'c2', 'git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0'),
    toolResult(5, 'c2'),
    toolCall(6, 'c3', 'npm publish'),
    toolResult(7, 'c3', { isError: true, content: 'npm ERR! EOTP this operation requires a one-time password', code: 'EOTP' }),
    ev('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 8),
  ];
}

test('Test D — npm blocked does not freeze GitHub Release', () => {
  const events = releaseBlockedEvents();
  const facts = foldGoalFacts(events);
  const todos = reconcileTodos({ facts, waitingKinds: ['npm_publish'], holdInProgress: true });
  const blockedKind = inferBlockedKind(facts, 'blocked');
  assert.equal(blockedKind, 'npm_publish');
  const graph = buildGoalGraph({ todos, facts, blockedKind });
  assert.ok(graph.blocked_steps.some((step) => /npm publish/i.test(step)));
  assert.ok(graph.remaining_runnable_steps.some((step) => /GitHub Release/i.test(step)));
  const blocked = describeBlocked({ status: 'blocked', facts, graph });
  assert.equal(blocked.reason, 'npm_2fa_required');
  assert.equal(blocked.scope, 'step');
  assert.equal(blocked.independent_steps_available, true);

  const waited = mapWaitGoal({
    sessionId: 's1',
    status: 'blocked',
    waitedMs: 10,
    waitSeconds: 25,
    todos,
    changedFiles: [],
    assistantSummary: 'npm needs OTP',
    blocked,
    blockedSteps: graph.blocked_steps,
    remainingRunnableSteps: graph.remaining_runnable_steps,
  });
  assert.equal(waited.terminal, false);
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.status, 'blocked');
  assert.ok(waited.remaining_runnable_steps.some((step) => /GitHub Release/i.test(step)));
});

test('blocked without remaining steps stays terminal', () => {
  const out = mapWaitGoal({
    sessionId: 's1',
    status: 'blocked',
    waitedMs: 1,
    waitSeconds: 25,
    changedFiles: [],
    assistantSummary: 'stopped',
  });
  assert.equal(out.terminal, true);
});

test('detectDeferredKinds reads the explicit [deferred] Plan marker', () => {
  const kinds = detectDeferredKinds('- GitHub Release\n- [deferred] npm publish');
  assert.deepEqual(kinds, ['npm_publish']);
});

test('detectDeferredKinds ignores deferral wording in free text', () => {
  // A resume instruction, a discussion, a prohibition and a negation must all
  // stay inert: deferral is a structured request, not a word in the Goal text.
  assert.deepEqual(detectDeferredKinds(), []);
  assert.deepEqual(detectDeferredKinds('1. echo step A\n2. npm publish\n3. GitHub Release'), []);
  for (const text of [
    'Resume the deferred npm step as a no-op. Do not run npm publish.',
    'We discussed whether to defer the npm publish in the retro.',
    'Do not defer npm publish; ship it now.',
    '无需延迟 npm publish，直接发布。',
    'defer npm publish, continue GitHub Release',
  ]) {
    assert.deepEqual(detectDeferredKinds(text), [], text);
  }
});

test('Test 7 — tag completed + npm blocked leaves GitHub Release runnable', () => {
  const events = releaseBlockedEvents();
  const facts = foldGoalFacts(events);
  const todos = reconcileTodos({ facts, waitingKinds: ['npm_publish'], holdInProgress: true });
  const graph = buildGoalGraph({ todos, facts, blockedKind: 'npm_publish' });
  const tag = graph.steps.find((step) => step.kind === 'git_tag');
  const npm = graph.steps.find((step) => step.kind === 'npm_publish');
  const release = graph.steps.find((step) => step.kind === 'github_release');
  assert.equal(tag?.id, 'git_tag');
  assert.equal(npm?.id, 'npm_publish');
  assert.equal(release?.id, 'github_release');
  assert.equal(tag?.status, 'completed');
  assert.ok(npm?.status === 'blocked' || npm?.status === 'in_progress');
  assert.ok(graph.remaining_runnable_steps.some((step) => /GitHub Release/i.test(step)));
});

test('Test 8 — defer marks npm deferred, not failed', () => {
  const facts = foldGoalFacts(releaseBlockedEvents());
  const todos = reconcileTodos({ facts, waitingKinds: ['npm_publish'], holdInProgress: true });
  const graph = buildGoalGraph({
    todos,
    facts,
    deferredKinds: ['npm_publish'],
  });
  const npm = graph.steps.find((step) => step.kind === 'npm_publish');
  assert.equal(npm?.status, 'deferred');
  assert.notEqual(npm?.status, 'failed');
  assert.ok(graph.deferred_steps.some((step) => /npm publish/i.test(step)));
  assert.ok(graph.remaining_runnable_steps.some((step) => /GitHub Release/i.test(step)));
});

test('deferred npm is removed from runnable steps', () => {
  const facts = foldGoalFacts(releaseBlockedEvents());
  const todos = reconcileTodos({ facts, waitingKinds: ['npm_publish'], holdInProgress: true });
  const graph = buildGoalGraph({
    todos,
    facts,
    blockedKind: 'npm_publish',
    deferredKinds: ['npm_publish'],
  });
  assert.ok(graph.deferred_steps.some((step) => /npm publish/i.test(step)));
  assert.ok(graph.remaining_runnable_steps.some((step) => /GitHub Release/i.test(step)));
  assert.equal(graph.blocked_steps.length, 0);
});
