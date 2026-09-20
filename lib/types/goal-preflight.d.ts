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
import type { ExecutionMode, GoalConstraints } from './goal-constraints.js';
export interface PreflightResult {
    valid: boolean;
    conflicts: string[];
    suggested_constraint_delta?: string[];
}
/**
 * Validate the structured constraint set only.
 *
 * `goal` and `plan` are accepted for call-site compatibility and are
 * intentionally never inspected. `mode` is accepted for the same reason;
 * mode defaults are merged later by `mergeConstraints`, never here.
 */
export declare function validateGoalPreflight(input: {
    goal: string;
    plan?: string;
    constraints?: GoalConstraints;
    mode?: ExecutionMode;
}): PreflightResult;
