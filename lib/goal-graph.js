import { factLooksLikeNpm2fa } from './goal-facts.js';
import { classifyTodoKind } from './goal-reconcile.js';
export function parsePlanLines(plan) {
    return plan
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
        .filter((line) => line !== '');
}
/**
 * Kinds the user asked to defer, taken only from structured signals:
 * a `[deferred]` marker on an explicit Plan line, or the structured
 * `defer_steps` refs resolved by the caller.
 *
 * Free text is never scanned for "defer ..." wording. Natural language that
 * merely mentions deferral must not silently withhold a step — a resume
 * message like "Resume the deferred npm step" or a discussion like
 * "we discussed whether to defer npm publish" or a prohibition like
 * "do not defer npm publish" is not a deferral request.
 */
export function detectDeferredKinds(plan) {
    const kinds = new Set();
    for (const line of parsePlanLines(plan ?? '')) {
        if (!/\[deferred\]/i.test(line))
            continue;
        const kind = classifyTodoKind(line.replace(/\[deferred\]/ig, ''));
        if (kind !== undefined)
            kinds.add(kind);
    }
    return [...kinds];
}
function stepsFrom(todos, plan) {
    if (todos !== undefined && todos.length > 0) {
        return todos.map((todo) => {
            const kind = classifyTodoKind(todo.content);
            const status = todo.status === 'completed' || todo.status === 'in_progress' || todo.status === 'pending'
                ? todo.status
                : 'pending';
            return { content: todo.content, status, ...(kind === undefined ? {} : { kind }) };
        });
    }
    if (plan === undefined || plan.trim() === '')
        return [];
    return parsePlanLines(plan).map((content) => {
        const kind = classifyTodoKind(content);
        return { content, status: 'pending', ...(kind === undefined ? {} : { kind }) };
    });
}
const RELEASE_KINDS = ['git_push', 'git_tag', 'npm_publish', 'github_release'];
function applyReleaseTemplate(steps) {
    const byKind = new Map();
    for (const step of steps) {
        if (step.kind === undefined || byKind.has(step.kind))
            continue;
        if (RELEASE_KINDS.includes(step.kind))
            byKind.set(step.kind, step);
    }
    if (byKind.size === 0)
        return;
    const push = byKind.get('git_push');
    const tag = byKind.get('git_tag');
    const npm = byKind.get('npm_publish');
    const release = byKind.get('github_release');
    if (tag !== undefined && push !== undefined)
        tag.dependsOn = unique([...tag.dependsOn, push.id]);
    const afterTag = tag ?? push;
    if (npm !== undefined && afterTag !== undefined)
        npm.dependsOn = unique([...npm.dependsOn, afterTag.id]);
    if (release !== undefined && afterTag !== undefined)
        release.dependsOn = unique([...release.dependsOn, afterTag.id]);
}
function unique(values) {
    return [...new Set(values)];
}
function applyLinearFallback(steps) {
    if (steps.some((step) => step.kind !== undefined && RELEASE_KINDS.includes(step.kind)))
        return;
    for (let i = 1; i < steps.length; i++) {
        const prev = steps[i - 1];
        const step = steps[i];
        if (prev === undefined || step === undefined)
            continue;
        step.dependsOn = unique([...step.dependsOn, prev.id]);
    }
}
export function inferBlockedKind(facts, status) {
    if (status !== 'blocked' && status !== 'waiting_for_user' && status !== 'waiting_for_approval') {
        return undefined;
    }
    const failed = [...facts.tools].reverse().find((fact) => !fact.ok && fact.kinds.some((kind) => kind !== 'unknown'));
    if (failed !== undefined)
        return failed.kinds.find((kind) => kind !== 'unknown');
    const last = [...facts.tools].reverse().find((fact) => fact.kinds.some((kind) => kind !== 'unknown'));
    return last?.kinds.find((kind) => kind !== 'unknown');
}
export function slugStepId(content) {
    const slug = content
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    return slug === '' ? 'step' : slug;
}
export function assignStableStepIds(items) {
    const used = new Set();
    return items.map((item, index) => {
        const candidates = [
            ...(item.kind !== undefined ? [item.kind] : []),
            slugStepId(item.content),
            `s${index + 1}`,
        ];
        for (const candidate of candidates) {
            if (!used.has(candidate)) {
                used.add(candidate);
                return candidate;
            }
        }
        const fallback = `s${index + 1}`;
        used.add(fallback);
        return fallback;
    });
}
/** Match a user-supplied step ref against id, kind, or content. */
export function resolveStepRefs(refs, steps) {
    const ids = [];
    const kinds = [];
    const contents = [];
    for (const raw of refs) {
        const ref = raw.trim();
        if (ref === '')
            continue;
        const lower = ref.toLowerCase();
        const byId = steps.find((step) => step.id.toLowerCase() === lower);
        if (byId !== undefined) {
            ids.push(byId.id);
            if (byId.kind !== undefined)
                kinds.push(byId.kind);
            contents.push(byId.content);
            continue;
        }
        const byKind = steps.find((step) => step.kind !== undefined && step.kind.toLowerCase() === lower);
        if (byKind !== undefined) {
            ids.push(byKind.id);
            if (byKind.kind !== undefined)
                kinds.push(byKind.kind);
            contents.push(byKind.content);
            continue;
        }
        const byContent = steps.find((step) => step.content.toLowerCase().includes(lower) || lower.includes(step.content.toLowerCase()));
        if (byContent !== undefined) {
            ids.push(byContent.id);
            if (byContent.kind !== undefined)
                kinds.push(byContent.kind);
            contents.push(byContent.content);
        }
    }
    return { ids: unique(ids), kinds: unique(kinds), contents: unique(contents) };
}
export function buildGoalGraph(input) {
    const raw = stepsFrom(input.todos, input.plan);
    const deferred = new Set(input.deferredKinds ?? []);
    const deferredIds = new Set(input.deferredStepIds ?? []);
    const ids = assignStableStepIds(raw);
    const steps = raw.map((item, index) => ({
        id: ids[index] ?? `s${index + 1}`,
        content: item.content,
        ...(item.kind === undefined ? {} : { kind: item.kind }),
        status: item.status,
        dependsOn: [],
    }));
    applyReleaseTemplate(steps);
    applyLinearFallback(steps);
    for (const step of steps) {
        if (step.status === 'completed')
            continue;
        if (deferredIds.has(step.id) || (step.kind !== undefined && deferred.has(step.kind))) {
            step.status = 'deferred';
            continue;
        }
        const blockedByKind = input.blockedKind !== undefined && step.kind === input.blockedKind;
        const blockedByContent = input.blockedContent !== undefined && step.content === input.blockedContent;
        if (blockedByKind || blockedByContent) {
            if (input.waitingStatus === 'waiting_for_user')
                step.status = 'waiting_for_user';
            else if (input.waitingStatus === 'waiting_for_approval')
                step.status = 'waiting_for_approval';
            else
                step.status = 'blocked';
        }
    }
    const completedIds = new Set(steps.filter((step) => step.status === 'completed').map((step) => step.id));
    const remaining_runnable_steps = [];
    const blocked_steps = [];
    const deferred_steps = [];
    for (const step of steps) {
        if (step.status === 'deferred') {
            deferred_steps.push(step.content);
            continue;
        }
        if (step.status === 'blocked' || step.status === 'waiting_for_user' || step.status === 'waiting_for_approval') {
            blocked_steps.push(step.content);
            continue;
        }
        if (step.status === 'completed' || step.status === 'skipped' || step.status === 'cancelled' || step.status === 'failed') {
            continue;
        }
        const depsMet = step.dependsOn.every((id) => completedIds.has(id));
        if (depsMet) {
            if (step.status === 'pending')
                step.status = 'ready';
            remaining_runnable_steps.push(step.content);
        }
    }
    return { steps, blocked_steps, deferred_steps, remaining_runnable_steps };
}
function npm2faFact(facts) {
    return [...facts.tools].reverse().find((fact) => factLooksLikeNpm2fa(fact));
}
export function describeBlocked(input) {
    const { status, facts, graph } = input;
    if (status !== 'blocked' && status !== 'waiting_for_user' && status !== 'waiting_for_approval') {
        return undefined;
    }
    const independent = graph.remaining_runnable_steps.length > 0;
    const blockedStep = graph.steps.find((step) => step.status === 'blocked');
    const inProgress = graph.steps.find((step) => step.status === 'in_progress');
    const stepName = blockedStep?.content ?? inProgress?.content ?? graph.blocked_steps[0] ?? 'unknown step';
    if (status === 'waiting_for_approval') {
        return {
            step: input.approval?.tool_name ? `${stepName} (${input.approval.tool_name})` : stepName,
            reason: 'waiting_for_approval',
            resume_condition: 'Ask the user, then call dsh_approve with the exact approval_id, then dsh_wait_goal.',
            scope: independent ? 'step' : 'goal',
            independent_steps_available: independent,
        };
    }
    if (status === 'waiting_for_user') {
        return {
            step: stepName,
            reason: 'waiting_for_user',
            resume_condition: 'Ask the user, then call dsh_answer_question, then dsh_wait_goal.',
            scope: independent ? 'step' : 'goal',
            independent_steps_available: independent,
        };
    }
    const twoFa = npm2faFact(facts);
    if (twoFa !== undefined) {
        const npmStep = graph.steps.find((step) => step.kind === 'npm_publish')?.content ?? 'npm publish';
        return {
            step: npmStep,
            reason: 'npm_2fa_required',
            resume_condition: 'provide npm OTP or publish externally',
            scope: independent ? 'step' : 'goal',
            independent_steps_available: independent,
        };
    }
    return {
        step: stepName,
        reason: 'blocked_unspecified',
        resume_condition: 'Resolve the blocked step or re-arm the goal with dsh_start_goal on this session_id to continue independent steps.',
        scope: independent ? 'step' : 'goal',
        independent_steps_available: independent,
    };
}
export const KNOWN_ACTION_KINDS = new Set([
    'git_push', 'git_tag', 'npm_publish', 'github_release', 'git_worktree_add', 'npm_pack',
]);
export function deferredKindsOf(deferredStepIds) {
    if (deferredStepIds === undefined)
        return [];
    return deferredStepIds.filter((id) => KNOWN_ACTION_KINDS.has(id));
}
