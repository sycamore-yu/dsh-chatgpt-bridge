/**
 * Goal, Plan, and Constraints Preflight Validator.
 *
 * Control-plane invariant: permission, danger, lock, approval and blocking
 * decisions are never derived from free text. The natural-language `goal` and
 * `plan` strings are deliberately NOT parsed for "intent": a Goal that merely
 * mentions write / delete / commit / publish words — negated ("do not modify
 * any file"), discussed ("audit the code that handles deletes"), quoted
 * ("the error says \"write failed\""), or referenced in Chinese
 * ("禁止修改文件") — must never be rejected before the Agent starts.
 *
 * Action intent is decided at execution time from real tool calls and
 * structured action facts:
 *   - `evaluateConstraint` / `rejectConstraint` (goal-constraints.ts) enforce
 *     read_only, allowed/forbidden actions and max_changed_files per call.
 *   - `evaluateApproval` (approval-policy.ts) derives risk tier from tool name
 *     plus tool-call arguments.
 *   - workspace locks and drift detection use workspace state, not Goal text.
 *
 * This module therefore validates only the structured constraint set the
 * caller actually sent, for self-contradictions that are decidable without
 * reading a single word of the Goal.
 */
import type { ExecutionMode, GoalConstraints, ActionClass } from './goal-constraints.js';

export interface PreflightResult {
  valid: boolean;
  conflicts: string[];
  suggested_constraint_delta?: string[];
}

/** Action classes `evaluateConstraint` actually rejects while read_only is set. */
const READ_ONLY_WRITE_CLASSES: readonly ActionClass[] = ['filesystem.write'];

/**
 * Validate the structured constraint set only.
 *
 * `goal` and `plan` are accepted for call-site compatibility and are
 * intentionally never inspected. `mode` is accepted for the same reason;
 * mode defaults are merged later by `mergeConstraints`, never here.
 */
export function validateGoalPreflight(input: {
  goal: string;
  plan?: string;
  constraints?: GoalConstraints;
  mode?: ExecutionMode;
}): PreflightResult {
  const constraints = input.constraints ?? {};
  const conflicts: string[] = [];
  const suggestedDeltas: string[] = [];

  const forbidden = new Set<ActionClass>(constraints.forbidden_actions ?? []);
  const allowed = constraints.allowed_actions;
  const allowedSet = allowed === undefined ? undefined : new Set<ActionClass>(allowed);

  // 1. The same structured action class cannot be both allowed and forbidden.
  if (allowedSet !== undefined) {
    for (const action of constraints.forbidden_actions ?? []) {
      if (!allowedSet.has(action)) continue;
      conflicts.push(`Action class "${action}" is listed in both allowed_actions and forbidden_actions.`);
      suggestedDeltas.push(`Remove "${action}" from either allowed_actions or forbidden_actions`);
    }
  }

  // 2. read_only forbids filesystem writes, so an allow-list cannot grant one.
  if (constraints.read_only === true && allowedSet !== undefined) {
    for (const action of READ_ONLY_WRITE_CLASSES) {
      if (!allowedSet.has(action)) continue;
      conflicts.push(`constraints.read_only is true, but allowed_actions explicitly grants "${action}".`);
      suggestedDeltas.push(`Remove "${action}" from allowed_actions or set constraints.read_only=false`);
    }
  }

  // 3. A forbidden workspace scan cannot also be explicitly allowed.
  if (constraints.allow_workspace_scan === false && allowedSet?.has('filesystem.scan') === true) {
    conflicts.push('constraints.allow_workspace_scan is false, but allowed_actions explicitly grants "filesystem.scan".');
    suggestedDeltas.push('Remove "filesystem.scan" from allowed_actions or set constraints.allow_workspace_scan=true');
  }

  return {
    valid: conflicts.length === 0,
    conflicts,
    ...(suggestedDeltas.length === 0 ? {} : { suggested_constraint_delta: suggestedDeltas }),
  };
}
