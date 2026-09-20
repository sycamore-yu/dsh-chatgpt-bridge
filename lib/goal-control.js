/**
 * First-class Goal revision, bounded history, and sidecar persistence.
 * Not a second execution engine: DSH session events remain the authority
 * for what actually ran.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redactValue } from './redact.js';
import { defaultConstraintsForMode, mergeConstraints, parseConstraints, parseExecutionMode, } from './goal-constraints.js';
export const HISTORY_PERSIST_MAX = 200;
export const HISTORY_WIRE_MAX = 20;
export const REVISION_REASON_MAX = 200;
export const GOAL_CONTROL_CAP = 256;
export function isAgentOptionsEqual(a, b) {
    if (a === b)
        return true;
    if (a === undefined || b === undefined)
        return false;
    return (a.provider === b.provider &&
        a.model === b.model &&
        (a.reasoning_effort ?? undefined) === (b.reasoning_effort ?? undefined));
}
export function isGoalSemanticallyEqual(record, goal, plan, mode, constraints) {
    if (record.goal.trim() !== goal.trim())
        return false;
    if ((record.plan ?? '').trim() !== (plan ?? '').trim())
        return false;
    if (mode !== undefined && record.mode !== parseExecutionMode(mode))
        return false;
    if (constraints !== undefined) {
        const merged = mergeConstraints(defaultConstraintsForMode(record.mode), constraints);
        if (JSON.stringify(record.constraints) !== JSON.stringify(merged))
            return false;
    }
    return true;
}
export function pruneBlockers(record, completedKinds) {
    if (!record.active_blockers)
        return;
    const completed = new Set(completedKinds);
    record.active_blockers = record.active_blockers.filter((b) => !completed.has(b.step_id));
}
function iso(ms) {
    return new Date(ms).toISOString();
}
function clipReason(reason, fallback) {
    const text = (reason ?? fallback).trim();
    if (text === '')
        return fallback;
    return text.length <= REVISION_REASON_MAX ? text : text.slice(0, REVISION_REASON_MAX);
}
function snapshotOf(record, reason, at) {
    return {
        revision: record.revision,
        ...(record.revision > 1 ? { previous_revision: record.revision - 1 } : {}),
        goal: record.goal,
        ...(record.plan === undefined ? {} : { plan: record.plan }),
        mode: record.mode,
        revision_reason: reason,
        created_at: at,
        constraints: { ...record.constraints },
    };
}
function pushHistory(record, type, at, extra) {
    record.history_seq += 1;
    const metadata = extra?.metadata === undefined
        ? undefined
        : redactValue(extra.metadata);
    const event = {
        seq: record.history_seq,
        timestamp: at,
        goal_id: record.goal_id,
        revision: record.revision,
        type,
        ...(extra?.step_id === undefined ? {} : { step_id: extra.step_id }),
        ...(metadata === undefined ? {} : { metadata }),
    };
    record.history.push(event);
    if (record.history.length > HISTORY_PERSIST_MAX) {
        record.history = record.history.slice(record.history.length - HISTORY_PERSIST_MAX);
    }
}
export function createGoalRecord(input) {
    const now = input.now ?? Date.now();
    const at = iso(now);
    const mode = parseExecutionMode(input.mode);
    const constraints = mergeConstraints(defaultConstraintsForMode(mode), input.constraints);
    const reason = clipReason(input.revisionReason, 'goal_created');
    const record = {
        goal_id: `goal-${input.sessionId}`,
        session_id: input.sessionId,
        revision: 1,
        mode,
        constraints,
        goal: input.goal,
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        created_at: at,
        updated_at: at,
        revision_reason: reason,
        revisions: [],
        deferred_step_ids: [],
        completed_action_kinds: [],
        active_blockers: [],
        superseded_step_ids: [],
        history: [],
        history_seq: 0,
        ...(input.agentOptions !== undefined ? { agent_options: input.agentOptions } : {}),
    };
    record.revisions.push(snapshotOf(record, reason, at));
    pushHistory(record, 'goal_created', at, { metadata: { reason, mode } });
    return record;
}
export function applyRevision(record, input, type) {
    if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
        throw new Error(`REVISION_CONFLICT: expected revision ${input.expectedRevision}, but current revision is ${record.revision}`);
    }
    const now = input.now ?? Date.now();
    const at = iso(now);
    const next = {
        ...record,
        revisions: [...record.revisions],
        deferred_step_ids: [...record.deferred_step_ids],
        completed_action_kinds: [...record.completed_action_kinds],
        active_blockers: record.active_blockers ? [...record.active_blockers] : [],
        superseded_step_ids: record.superseded_step_ids ? [...record.superseded_step_ids] : [],
        history: [...record.history],
        constraints: { ...record.constraints },
    };
    next.revision = record.revision + 1;
    next.updated_at = at;
    if (input.goal !== undefined)
        next.goal = input.goal;
    if (input.plan !== undefined)
        next.plan = input.plan;
    if (input.mode !== undefined) {
        next.mode = parseExecutionMode(input.mode);
        next.constraints = mergeConstraints(defaultConstraintsForMode(next.mode), next.constraints);
    }
    if (input.constraints !== undefined) {
        next.constraints = mergeConstraints(next.constraints, input.constraints);
    }
    if (input.completedActionKinds !== undefined) {
        next.completed_action_kinds = uniqueKinds([
            ...next.completed_action_kinds,
            ...input.completedActionKinds,
        ]);
    }
    if (input.deferredStepIds !== undefined && input.deferredStepIds.length > 0) {
        next.deferred_step_ids = uniqueStrings([...next.deferred_step_ids, ...input.deferredStepIds]);
    }
    if (input.resumeStepIds !== undefined) {
        if (input.resumeStepIds.length === 0) {
            next.deferred_step_ids = [];
        }
        else {
            const resume = new Set(input.resumeStepIds);
            next.deferred_step_ids = next.deferred_step_ids.filter((id) => !resume.has(id));
        }
    }
    const reason = clipReason(input.revisionReason, type === 'goal_resumed' ? 'user_resumed_goal' : 'user_modified_goal');
    next.revision_reason = reason;
    next.revisions.push(snapshotOf(next, reason, at));
    pushHistory(next, type, at, {
        metadata: {
            reason,
            ...(input.deferredStepIds === undefined ? {} : { deferred: input.deferredStepIds }),
            ...(input.resumeStepIds === undefined ? {} : { resumed: input.resumeStepIds }),
        },
    });
    if (input.deferredStepIds !== undefined) {
        for (const stepId of input.deferredStepIds) {
            pushHistory(next, 'step_deferred', at, { step_id: stepId, metadata: { reason } });
        }
    }
    return next;
}
export function appendGoalEvent(record, type, extra) {
    const next = {
        ...record,
        revisions: [...record.revisions],
        deferred_step_ids: [...record.deferred_step_ids],
        completed_action_kinds: [...record.completed_action_kinds],
        history: [...record.history],
        constraints: { ...record.constraints },
        updated_at: iso(extra?.now ?? Date.now()),
    };
    pushHistory(next, type, next.updated_at, extra);
    return next;
}
function uniqueStrings(values) {
    return [...new Set(values.filter((item) => item.trim() !== ''))];
}
function uniqueKinds(values) {
    return [...new Set(values)];
}
export function sliceHistory(history, sinceSeq, max = HISTORY_WIRE_MAX) {
    const filtered = sinceSeq === undefined ? [...history] : history.filter((event) => event.seq > sinceSeq);
    if (filtered.length <= max)
        return filtered;
    return filtered.slice(filtered.length - max);
}
export function supervisionGoal(record) {
    const revision_history = foldRevisionHistory(record);
    return {
        goal_id: record.goal_id,
        revision: record.revision,
        mode: record.mode,
        card: goalCardLabel(record),
        revision_history_folded: revision_history.length > 1,
        revision_history,
        ...(record.revision > 1 ? { previous_revision: record.revision - 1 } : {}),
    };
}
export function reconstructGoalRecord(sessionId, goal = '', plan) {
    return createGoalRecord({ sessionId, goal, plan, revisionReason: 'reconstructed_from_session' });
}
/**
 * Native get_goal and Bridge supervised Goal are different namespaces.
 * A null (or any) native lookup must not clear, replace, recreate, or
 * downgrade the sidecar record: goal_id, revision, mode, constraints, history.
 */
export function applyNativeGetGoalResult(record, _native) {
    return record;
}
export function parseGoalRecord(raw) {
    try {
        const value = JSON.parse(raw);
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            return undefined;
        const rec = value;
        if (typeof rec.goal_id !== 'string' || typeof rec.session_id !== 'string')
            return undefined;
        if (typeof rec.goal !== 'string')
            return undefined;
        const revision = typeof rec.revision === 'number' && rec.revision >= 1 ? Math.trunc(rec.revision) : 1;
        const mode = parseExecutionMode(rec.mode);
        const constraints = parseConstraints(rec.constraints);
        const revisions = Array.isArray(rec.revisions)
            ? rec.revisions.filter((item) => {
                return item !== null && typeof item === 'object' && typeof item.revision === 'number';
            })
            : [];
        const history = Array.isArray(rec.history)
            ? rec.history.filter((item) => {
                return item !== null && typeof item === 'object' && typeof item.seq === 'number';
            })
            : [];
        const deferred = Array.isArray(rec.deferred_step_ids)
            ? rec.deferred_step_ids.filter((item) => typeof item === 'string')
            : [];
        const completed = Array.isArray(rec.completed_action_kinds)
            ? rec.completed_action_kinds.filter((item) => typeof item === 'string')
            : [];
        const rawOpts = rec.agent_options;
        const agentOptions = rawOpts !== null && typeof rawOpts === 'object' && !Array.isArray(rawOpts)
            ? {
                provider: String(rawOpts.provider ?? ''),
                model: String(rawOpts.model ?? ''),
                ...(rawOpts.reasoning_effort !== undefined
                    ? { reasoning_effort: String(rawOpts.reasoning_effort) }
                    : {}),
            }
            : undefined;
        return {
            goal_id: rec.goal_id,
            session_id: rec.session_id,
            revision,
            mode,
            constraints,
            goal: rec.goal,
            ...(typeof rec.plan === 'string' ? { plan: rec.plan } : {}),
            created_at: typeof rec.created_at === 'string' ? rec.created_at : new Date(0).toISOString(),
            updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : new Date(0).toISOString(),
            ...(typeof rec.revision_reason === 'string' ? { revision_reason: rec.revision_reason } : {}),
            revisions,
            deferred_step_ids: deferred,
            completed_action_kinds: completed,
            history,
            history_seq: typeof rec.history_seq === 'number' ? rec.history_seq : history.at(-1)?.seq ?? 0,
            ...(agentOptions !== undefined && agentOptions.provider !== '' && agentOptions.model !== ''
                ? { agent_options: agentOptions }
                : {}),
        };
    }
    catch {
        return undefined;
    }
}
export function safeSessionFileId(sessionId) {
    const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return cleaned === '' ? 'session' : cleaned;
}
export function fileStoreIo(dir) {
    return {
        read(sessionId) {
            try {
                return readFileSync(join(dir, `${safeSessionFileId(sessionId)}.json`), 'utf8');
            }
            catch {
                return undefined;
            }
        },
        write(sessionId, json) {
            mkdirSync(dir, { recursive: true });
            const target = join(dir, `${safeSessionFileId(sessionId)}.json`);
            const tmp = join(dir, `${safeSessionFileId(sessionId)}.${process.pid}.${randomUUID()}.tmp`);
            try {
                writeFileSync(tmp, json, 'utf8');
                renameSync(tmp, target);
            }
            catch (error) {
                try {
                    rmSync(tmp, { force: true });
                }
                catch {
                    // best-effort
                }
                throw error;
            }
        },
    };
}
export function memoryStoreIo(files = new Map()) {
    return {
        files,
        read(sessionId) {
            return files.get(sessionId);
        },
        write(sessionId, json) {
            files.set(sessionId, json);
        },
    };
}
/** FIFO-capped in-memory cache with optional sidecar persistence. */
export class GoalControlStore {
    items = new Map();
    cap;
    io;
    constructor(io, cap = GOAL_CONTROL_CAP) {
        this.io = io;
        this.cap = cap;
    }
    get(sessionId) {
        const mem = this.items.get(sessionId);
        if (mem !== undefined)
            return mem;
        const raw = this.io?.read(sessionId);
        if (raw === undefined)
            return undefined;
        const parsed = parseGoalRecord(raw);
        if (parsed === undefined)
            return undefined;
        this.remember(parsed);
        return parsed;
    }
    put(record) {
        this.remember(record);
        try {
            this.io?.write(record.session_id, JSON.stringify(record));
        }
        catch {
            // persistence failure is not fatal: this process still has the record
        }
        return record;
    }
    remember(record) {
        if (this.items.has(record.session_id))
            this.items.delete(record.session_id);
        this.items.set(record.session_id, record);
        while (this.items.size > this.cap) {
            const first = this.items.keys().next().value;
            if (first === undefined)
                break;
            this.items.delete(first);
        }
    }
}
export function goalControlDir(dshHome) {
    return join(dshHome, 'chatgpt-bridge', 'goals');
}
export function revisionBanner(record) {
    const deferred = record.deferred_step_ids.length === 0 ? '' : ` · deferred: ${record.deferred_step_ids.join(', ')}`;
    return `[Goal] rev ${record.revision} · ${record.mode}${deferred}`;
}
export function goalCardLabel(record) {
    return `Goal rev ${record.revision}`;
}
export function foldRevisionHistory(record) {
    return record.revisions.map((snapshot) => ({
        revision: snapshot.revision,
        ...(snapshot.previous_revision === undefined ? {} : { previous_revision: snapshot.previous_revision }),
        revision_reason: snapshot.revision_reason,
        created_at: snapshot.created_at,
    }));
}
