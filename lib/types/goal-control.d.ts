import type { ActionKind } from './goal-facts.js';
import { type ExecutionMode, type GoalConstraints } from './goal-constraints.js';
export declare const HISTORY_PERSIST_MAX = 200;
export declare const HISTORY_WIRE_MAX = 20;
export declare const REVISION_REASON_MAX = 200;
export declare const GOAL_CONTROL_CAP = 256;
export type GoalHistoryType = 'goal_created' | 'goal_revised' | 'goal_resumed' | 'step_started' | 'step_completed' | 'step_blocked' | 'step_deferred' | 'approval_requested' | 'approval_resolved' | 'question_requested' | 'question_answered' | 'constraint_rejected' | 'step_skipped' | 'goal_completed' | 'goal_cancelled';
export interface GoalRevisionSnapshot {
    revision: number;
    previous_revision?: number;
    goal: string;
    plan?: string;
    mode: ExecutionMode;
    revision_reason: string;
    created_at: string;
    constraints: GoalConstraints;
}
export interface GoalHistoryEvent {
    seq: number;
    timestamp: string;
    goal_id: string;
    revision: number;
    type: GoalHistoryType;
    step_id?: string;
    metadata?: Record<string, unknown>;
}
export interface BlockedStepRecord {
    step_id: string;
    reason: string;
    seq: number;
    superseded?: boolean;
}
export interface AgentOptionsInput {
    provider: string;
    model: string;
    reasoning_effort?: string;
}
export declare function isAgentOptionsEqual(a: AgentOptionsInput | undefined, b: AgentOptionsInput | undefined): boolean;
export interface GoalRecord {
    goal_id: string;
    session_id: string;
    revision: number;
    mode: ExecutionMode;
    constraints: GoalConstraints;
    goal: string;
    plan?: string;
    created_at: string;
    updated_at: string;
    revision_reason?: string;
    revisions: GoalRevisionSnapshot[];
    deferred_step_ids: string[];
    completed_action_kinds: ActionKind[];
    active_blockers?: BlockedStepRecord[];
    superseded_step_ids?: string[];
    history: GoalHistoryEvent[];
    history_seq: number;
    agent_options?: AgentOptionsInput;
}
/** Compact revision row for folded UI / wire payloads. No goal/plan text. */
export interface FoldedRevision {
    revision: number;
    previous_revision?: number;
    revision_reason: string;
    created_at: string;
}
export interface GoalSupervisionView {
    goal_id: string;
    revision: number;
    mode: ExecutionMode;
    card: string;
    revision_history_folded: boolean;
    revision_history: FoldedRevision[];
    previous_revision?: number;
    revisions?: GoalRevisionSnapshot[];
}
export interface CreateGoalInput {
    sessionId: string;
    goal: string;
    plan?: string;
    mode?: ExecutionMode;
    constraints?: GoalConstraints;
    now?: number;
    revisionReason?: string;
    agentOptions?: AgentOptionsInput;
}
export interface ReviseGoalInput {
    goal?: string;
    plan?: string;
    mode?: ExecutionMode;
    constraints?: GoalConstraints;
    expectedRevision?: number;
    deferredStepIds?: string[];
    resumeStepIds?: string[];
    completedActionKinds?: ActionKind[];
    revisionReason?: string;
    now?: number;
}
export declare function isGoalSemanticallyEqual(record: GoalRecord, goal: string, plan?: string, mode?: ExecutionMode, constraints?: GoalConstraints): boolean;
export declare function pruneBlockers(record: GoalRecord, completedKinds: Iterable<ActionKind>): void;
export interface GoalStoreIo {
    read(sessionId: string): string | undefined;
    write(sessionId: string, json: string): void;
}
export declare function createGoalRecord(input: CreateGoalInput): GoalRecord;
export declare function applyRevision(record: GoalRecord, input: ReviseGoalInput, type: 'goal_revised' | 'goal_resumed'): GoalRecord;
export declare function appendGoalEvent(record: GoalRecord, type: GoalHistoryType, extra?: {
    step_id?: string;
    metadata?: Record<string, unknown>;
    now?: number;
}): GoalRecord;
export declare function sliceHistory(history: readonly GoalHistoryEvent[], sinceSeq?: number, max?: number): GoalHistoryEvent[];
export declare function supervisionGoal(record: GoalRecord): GoalSupervisionView;
export declare function reconstructGoalRecord(sessionId: string, goal?: string, plan?: string): GoalRecord;
/** Native DSH get_goal payload. A null `goal` is the observed Agent-native miss. */
export type NativeGetGoalResult = {
    goal: unknown;
} | null | undefined;
/**
 * Native get_goal and Bridge supervised Goal are different namespaces.
 * A null (or any) native lookup must not clear, replace, recreate, or
 * downgrade the sidecar record: goal_id, revision, mode, constraints, history.
 */
export declare function applyNativeGetGoalResult(record: GoalRecord | undefined, _native: NativeGetGoalResult): GoalRecord | undefined;
export declare function parseGoalRecord(raw: string): GoalRecord | undefined;
export declare function safeSessionFileId(sessionId: string): string;
export declare function fileStoreIo(dir: string): GoalStoreIo;
export declare function memoryStoreIo(files?: Map<string, string>): GoalStoreIo & {
    files: Map<string, string>;
};
/** FIFO-capped in-memory cache with optional sidecar persistence. */
export declare class GoalControlStore {
    private readonly items;
    private readonly cap;
    private readonly io?;
    constructor(io?: GoalStoreIo, cap?: number);
    get(sessionId: string): GoalRecord | undefined;
    put(record: GoalRecord): GoalRecord;
    private remember;
}
export declare function goalControlDir(dshHome: string): string;
export declare function revisionBanner(record: GoalRecord): string;
export declare function goalCardLabel(record: {
    revision: number;
}): string;
export declare function foldRevisionHistory(record: GoalRecord): FoldedRevision[];
