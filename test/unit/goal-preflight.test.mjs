import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGoalPreflight } from '../../lib/goal-preflight.js';
import { evaluateConstraint } from '../../lib/goal-constraints.js';

/**
 * Goal / Plan wording that only *mentions* an action — negated, discussed,
 * quoted, or referred to in Chinese. None of these is a request to perform the
 * action, so none may reject the Goal before the Agent starts.
 */
const INERT_GOAL_TEXTS = [
  // English negation / prohibition
  'Do not modify, delete, rename or write any file; only report findings.',
  'Never commit, tag or push; this is a read-only audit.',
  'Audit the repository without editing, patching or refactoring anything.',
  // English discussion
  'Explain how the write, delete and publish code paths work.',
  'Review the module that implements git push and npm publish.',
  'Assess the risks of deleting files outside the workspace.',
  // English quotation / reference
  'The error message says "write failed"; explain what it means.',
  'Summarize the `git push --force` warning text in the docs.',
  'What does the phrase "create a GitHub Release" mean in this README?',
  // Chinese negation / prohibition
  '不要修改任何文件，只做只读审计。',
  '禁止提交、推送或发布，仅输出分析报告。',
  '本次任务不写入文件，也不删除任何内容。',
  // Chinese discussion
  '检查处理删除与推送的分支逻辑，不要执行它们。',
  '说明 npm 发布流程的实现方式。',
  '评估 workspace 外写入的风险。',
  // Chinese quotation / reference
  '解释文档里的“修改文件”是什么意思。',
  'README 中「创建 GitHub Release」这一步指的是什么？',
];

test('free-text action words never reject a read-only Goal (EN + CN)', () => {
  for (const goal of INERT_GOAL_TEXTS) {
    const result = validateGoalPreflight({ goal, constraints: { read_only: true } });
    assert.equal(result.valid, true, goal);
    assert.deepEqual(result.conflicts, [], goal);
  }
});

test('regression: the goal-control dogfood minimal Goal wording starts normally', () => {
  const result = validateGoalPreflight({
    goal: '只等待 35 秒然后完成。禁止扫描 workspace。禁止修改文件。不要创建报告。',
    constraints: { allow_workspace_scan: false, max_changed_files: 0, read_only: true },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.conflicts, []);
});

test('Plan text is not intent either', () => {
  const result = validateGoalPreflight({
    goal: 'Audit the release process',
    plan: [
      '1. describe the npm publish and git push steps',
      '2. quote the "create a GitHub Release" instructions',
      '3. do not run any of them',
    ].join('\n'),
    constraints: { read_only: true, forbidden_actions: ['git.mutate', 'npm.publish', 'github.release'] },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.conflicts, []);
});

test('a structured constraint set with no contradiction passes', () => {
  const result = validateGoalPreflight({
    goal: 'Audit repository status, check git log and review package manifest',
    constraints: { read_only: true, forbidden_actions: ['git.mutate'] },
  });

  assert.equal(result.valid, true);
  assert.equal(result.conflicts.length, 0);
});

test('a class listed as both allowed and forbidden is a structural conflict', () => {
  const result = validateGoalPreflight({
    goal: 'anything at all',
    constraints: { allowed_actions: ['filesystem.read', 'git.mutate'], forbidden_actions: ['git.mutate'] },
  });
  assert.equal(result.valid, false);
  assert.ok(result.conflicts.some((c) => c.includes('git.mutate')));
  assert.ok(result.suggested_constraint_delta?.some((d) => d.includes('git.mutate')));
});

test('read_only with an explicit write grant is a structural conflict', () => {
  const result = validateGoalPreflight({
    goal: 'anything at all',
    constraints: { read_only: true, allowed_actions: ['filesystem.read', 'filesystem.write'] },
  });
  assert.equal(result.valid, false);
  assert.ok(result.conflicts.some((c) => c.includes('read_only') && c.includes('filesystem.write')));
});

test('allow_workspace_scan=false with an explicit scan grant is a structural conflict', () => {
  const result = validateGoalPreflight({
    goal: 'anything at all',
    constraints: { allow_workspace_scan: false, allowed_actions: ['filesystem.scan'] },
  });
  assert.equal(result.valid, false);
  assert.ok(result.conflicts.some((c) => c.includes('filesystem.scan')));
});

/**
 * The safety boundary moved to execution time: the same read-only constraints
 * that now let the Goal start still reject the real write tool calls.
 */
test('read_only still rejects real write tool calls at execution time', () => {
  const constraints = { read_only: true };
  const fileWrite = evaluateConstraint({ constraints, toolName: 'write' });
  assert.equal(fileWrite.allow, false);
  assert.equal(fileWrite.reason, 'read_only');

  const edit = evaluateConstraint({ constraints, toolName: 'edit' });
  assert.equal(edit.allow, false);
  assert.equal(edit.reason, 'read_only');

  const shellWrite = evaluateConstraint({ constraints, toolName: 'bash', command: 'rm -rf build' });
  assert.equal(shellWrite.allow, false);
  assert.equal(shellWrite.reason, 'read_only');

  const read = evaluateConstraint({ constraints, toolName: 'read' });
  assert.equal(read.allow, true);
});

test('forbidden_actions still rejects real matching tool calls at execution time', () => {
  const constraints = { forbidden_actions: ['git.mutate'] };
  const push = evaluateConstraint({ constraints, toolName: 'bash', command: 'git push origin main' });
  assert.equal(push.allow, false);
  assert.equal(push.reason, 'forbidden_action');

  const commit = evaluateConstraint({ constraints, toolName: 'bash', command: 'git commit -m x' });
  assert.equal(commit.allow, false);
  assert.equal(commit.reason, 'forbidden_action');
});
