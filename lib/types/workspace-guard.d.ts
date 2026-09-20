export interface WorkspaceLockHolder {
    sessionId: string;
    goalId: string;
    workspacePath: string;
    lockedAt: number;
}
export interface WorkspaceBaseline {
    workspacePath: string;
    headSha?: string;
    dirtyFiles: string[];
    /** Hash of tracked diffs plus untracked path metadata at capture time. */
    workspaceFingerprint?: string;
    timestamp: number;
}
export interface MutationRecord {
    sessionId: string;
    goalId: string;
    stepId?: string;
    type: string;
    details?: string;
    timestamp: number;
}
export interface BaselineCaptureOptions {
    /**
     * Workspace-relative paths this caller owns. Changes to exactly these paths
     * are removed from the fingerprint, so a direct write can prove that nothing
     * else changed while it was in flight. Exclusion is exact-path only; a
     * directory prefix must be listed explicitly.
     */
    excludePaths?: string[];
}
export declare class WorkspaceConcurrencyGuard {
    private readonly locks;
    private readonly sessionLocks;
    private readonly mutations;
    /**
     * Attempt to acquire an exclusive mutable session lock for a workspace.
     * Read-only sessions do not need to acquire this lock.
     */
    acquireMutableLock(workspacePath: string, sessionId: string, goalId: string, isExistingHolderActive?: boolean, override?: boolean): {
        success: boolean;
        holder?: WorkspaceLockHolder;
        warning?: string;
    };
    /** Release mutable lock held by a session upon completion or cancellation. */
    releaseLock(sessionId: string): boolean;
    getLock(workspacePath: string): WorkspaceLockHolder | undefined;
    /** Record a mutating operation (write, commit, tag, publish) for provenance. */
    recordMutation(workspacePath: string, record: Omit<MutationRecord, 'timestamp'>): void;
    getLastMutation(workspacePath: string): MutationRecord | undefined;
    /** Capture baseline git HEAD SHA and dirty file status at Goal start. */
    captureBaseline(workspacePath: string, options?: BaselineCaptureOptions): Promise<WorkspaceBaseline>;
    /** Detect workspace state drift since baseline. */
    detectDrift(workspacePath: string, baseline: WorkspaceBaseline, currentSessionId: string, currentSnapshot?: WorkspaceBaseline): Promise<{
        drifted: boolean;
        currentSha?: string;
        details?: string;
        originatingSessionId?: string;
    }>;
}
