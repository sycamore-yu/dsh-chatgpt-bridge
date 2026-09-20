/**
 * Reconcile Goal todos against structured tool facts.
 * Never scans assistant summary text.
 */
import { type ActionKind, type GoalFacts } from './goal-facts.js';
export interface ReconcileTodo {
    content: string;
    status: string;
}
export interface ReconcileInput {
    todos?: ReconcileTodo[];
    facts: GoalFacts;
    /** Kinds that are currently waiting / blocked and must not flip to completed. */
    waitingKinds?: ActionKind[];
    /** Contents whose todo must stay in_progress (waiting/blocked step). */
    waitingContents?: string[];
    /** Waiting/blocked with no inferred kind: keep a current step in_progress. */
    holdInProgress?: boolean;
}
/**
 * Map a todo line onto at most one action kind using an explicit lexicon.
 * Unmatched lines stay untouched later. The lexicon deliberately refuses
 * negation, discussion and quoted-reference wording, because this label feeds
 * the blocked / deferred / completed reporting paths.
 */
export declare function classifyTodoKind(content: string): ActionKind | undefined;
/**
 * Overlay reconciled statuses onto the last todo/write snapshot.
 * Agent-authored `completed` is never rolled back.
 */
export declare function reconcileTodos(input: ReconcileInput): ReconcileTodo[] | undefined;
