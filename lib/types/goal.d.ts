/**
 * Thin Goal Supervision mapper. No Goal DB: maps existing DSH session
 * status (deriveStatus) into the start/wait/stop continuation protocol.
 */
import type { ActionKind } from './goal-facts.js';
import type { GoalHistoryEvent, GoalRecord, GoalSupervisionView } from './goal-control.js';
import type { ExecutionMode, GoalConstraints } from './goal-constraints.js';
import type { BlockedInfo, GoalGraph } from './goal-graph.js';
import type { ProgressDelta } from './goal-delta.js';
import type { BridgeStatus } from './status.js';
export declare const DEFAULT_WAIT_SECONDS = 25;
export declare const MIN_WAIT_SECONDS = 1;
export declare const MAX_WAIT_SECONDS = 30;
export declare const WAIT_POLL_MS = 500;
export declare const REQUEST_ID_CAP = 256;
export declare const GOAL_SUMMARY_MAX_CHARS = 4000;
export declare const GOAL_FILES_MAX = 40;
export declare const GOAL_TODOS_MAX = 40;
export declare const OBSERVE_STATE_CAP = 256;
/** Injected into every ChatGPT Bridge supervised Agent turn. Native get_goal is a different namespace. */
export declare const SUPERVISED_GOAL_AUTHORITY: string;
export declare function clampWaitSeconds(value: number | undefined): number;
export interface GoalMessageOptions {
    mode?: ExecutionMode;
    constraints?: GoalConstraints;
    completedKinds?: ActionKind[];
    deferredSteps?: string[];
    resumeSteps?: string[];
    revision?: number;
    intent?: 'start' | 'revise' | 'resume' | 'defer';
}
export declare function buildGoalMessage(goal: string, plan?: string, options?: GoalMessageOptions): string;
export declare function foldedGoalDisplay(record: GoalRecord): string;
/** Full Agent-turn payload: [Goal] banner + authority rules + goal/plan/mode. */
export declare function buildSupervisedGoalContext(record: GoalRecord, goal: string, plan: string | undefined, intent: 'start' | 'revise' | 'resume' | 'defer', resumeSteps?: string[]): string;
export interface ExecutionSupervisionView {
    current_step?: string;
    runnable_steps: string[];
    blocked_steps: string[];
    deferred_steps: string[];
}
export declare function executionView(graph: GoalGraph, currentStep?: string): ExecutionSupervisionView;
export declare function titleFromGoal(goal: string): string;
export declare function fingerprintStart(input: {
    workspace: string;
    goal: string;
    plan?: string;
    session_id?: string;
    execution_mode?: string;
    constraints?: unknown;
    action?: string;
    agent_options?: unknown;
}): string;
/** Only these statuses keep the Goal wait loop alive. Never treat idle as running. */
export declare function isActiveStatus(status: BridgeStatus): boolean;
export declare function isTerminalStatus(status: BridgeStatus): boolean;
export declare function isWaitingStatus(status: BridgeStatus): boolean;
export interface GoalToolCall {
    name: string;
    arguments: Record<string, unknown>;
}
export interface GoalProgress {
    todos: {
        content: string;
        status: string;
    }[];
    todos_completed: number;
    todos_total: number;
    agent_status?: 'idle' | 'running';
    last_activity?: string;
    last_turn?: {
        turn: number;
        reason?: string;
    };
    changed_files: string[];
    error_summary?: string;
}
export interface GoalResult {
    summary: string;
    changed_files: string[];
    todos: {
        content: string;
        status: string;
    }[];
}
export interface GoalStartResult {
    session_id: string;
    status: BridgeStatus;
    continuation_required: boolean;
    next_action: string;
    next_tool_call?: GoalToolCall;
    existing_goal_reused?: boolean;
    revision_unchanged?: boolean;
    conflicts?: string[];
    evidence_id?: string;
    workspace_lock_acquired?: boolean;
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
}
export interface GoalWaitResult {
    session_id: string;
    status: BridgeStatus;
    terminal: boolean;
    waited_ms: number;
    continuation_required: boolean;
    needs_user_action?: boolean;
    progress?: GoalProgress;
    result?: GoalResult;
    approval?: unknown;
    question?: unknown;
    next_action: string;
    next_tool_call?: GoalToolCall;
    progress_delta?: ProgressDelta;
    blocked?: BlockedInfo;
    deferred_steps?: string[];
    blocked_steps?: string[];
    remaining_runnable_steps?: string[];
    cleanup_warning?: string;
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
}
export interface GoalSnapshot {
    sessionId: string;
    status: BridgeStatus;
    waitedMs: number;
    waitSeconds: number;
    todos?: {
        content: string;
        status: string;
    }[];
    lastActivity?: string;
    lastTurn?: {
        turn: number;
        reason?: string;
    };
    changedFiles: string[];
    assistantSummary: string;
    errorSummary?: string;
    agentStatus?: 'idle' | 'running';
    approval?: unknown;
    question?: unknown;
    progressDelta?: ProgressDelta;
    blocked?: BlockedInfo;
    deferredSteps?: string[];
    blockedSteps?: string[];
    remainingRunnableSteps?: string[];
    cleanupWarning?: string;
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
}
/** blocked is only a wait-loop terminal when no independent branch remains. */
export declare function isWaitTerminal(status: BridgeStatus, remainingRunnableSteps?: string[]): boolean;
export declare function mapStartGoal(sessionId: string, status: BridgeStatus, waitSeconds?: number, extras?: {
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
}): GoalStartResult;
export declare function mapWaitGoal(snapshot: GoalSnapshot): GoalWaitResult;
export interface GoalRequestRecord {
    sessionId: string;
    fingerprint: string;
}
/** FIFO-capped in-memory request_id map. Not durable across process restarts. */
export declare class RequestIdMap {
    private readonly items;
    private readonly cap;
    constructor(cap?: number);
    get(requestId: string): GoalRequestRecord | undefined;
    set(requestId: string, record: GoalRequestRecord): void;
}
/** Per-session Goal observation (plan, deferrals). Not a Goal DB. */
export interface GoalObserveState {
    goalId: string;
    goal: string;
    plan?: string;
    startedAt: number;
    deferredKinds: ActionKind[];
}
export declare class GoalObserveMap {
    private readonly items;
    private readonly cap;
    constructor(cap?: number);
    get(sessionId: string): GoalObserveState | undefined;
    set(sessionId: string, state: GoalObserveState): void;
}
