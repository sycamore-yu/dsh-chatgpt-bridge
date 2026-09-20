import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { WorkspaceConcurrencyGuard } from './workspace-guard.js';
/** Stable machine-readable error codes of the direct-workspace channel. */
export declare const DIRECT_WORKSPACE_ERROR_CODES: readonly ["WORKSPACE_NOT_FOUND", "WORKSPACE_REGISTRY_UNAVAILABLE", "PATH_OUTSIDE_WORKSPACE", "SENSITIVE_PATH_DENIED", "BINARY_FILE_DENIED", "FILE_NOT_FOUND", "FILE_EXISTS", "FILE_TOO_LARGE", "IS_A_DIRECTORY", "NOT_A_DIRECTORY", "SYMLINK_NOT_WRITABLE", "DIRECTORY_NOT_FOUND", "PRECONDITION_FAILED", "PATCH_CONFLICT", "PATCH_INVALID", "WORKSPACE_LOCKED", "WORKSPACE_DRIFT", "WRITE_FAILED", "GIT_UNAVAILABLE", "GIT_NOT_A_REPOSITORY", "GIT_ERROR", "COMMAND_TIMEOUT", "SEARCH_FAILED", "INVALID_ARGUMENT"];
export type DirectWorkspaceErrorCode = (typeof DIRECT_WORKSPACE_ERROR_CODES)[number];
/** Typed failure with a stable code, mapped to an MCP error result unchanged. */
export declare class DirectWorkspaceError extends Error {
    readonly code: DirectWorkspaceErrorCode;
    readonly details?: Record<string, unknown>;
    constructor(code: DirectWorkspaceErrorCode, message: string, details?: Record<string, unknown>);
}
export interface DirectWorkspaceLimits {
    /** Max bytes returned by one read_file call. */
    maxReadBytes: number;
    /** Max bytes scanned by one read_file call before it reports truncation. */
    maxScanBytes: number;
    /** Max bytes one write_file / apply_patch may produce. */
    maxWriteBytes: number;
    /** Max bytes of pre-image apply_patch will load. */
    maxPatchBytes: number;
    /** Max entries returned by list_directory. */
    maxListEntries: number;
    /** Max recursion depth accepted by list_directory. */
    maxListDepth: number;
    /** Max matches returned by search_workspace. */
    maxSearchResults: number;
    /** Max files the node search fallback visits. */
    maxSearchFiles: number;
    /** Max bytes the node search fallback scans. */
    maxSearchScanBytes: number;
    /** Max file size the search engines inspect. */
    maxSearchFileBytes: number;
    /** Max bytes of git diff text collected. */
    maxDiffBytes: number;
    /** Max diff lines returned by one git_diff call. */
    maxDiffLines: number;
    /** Timeout for one git invocation. */
    commandTimeoutMs: number;
}
export declare const DEFAULT_DIRECT_WORKSPACE_LIMITS: DirectWorkspaceLimits;
export interface DirectWorkspaceTestHooks {
    /** Runs after a file mutation and before the post-write drift fingerprint. */
    afterWriteBeforeFingerprint?: (context: {
        workspacePath: string;
        path: string;
    }) => Promise<void>;
    /** Force one search engine so both paths are exercised without touching PATH. */
    forceSearchEngine?: 'ripgrep' | 'node';
}
export interface DirectWorkspaceDeps {
    /** Resolve a workspace id, canonical path or title against the registry. */
    resolveWorkspace(input: string): Promise<Workspace>;
    /** The Bridge's single workspace concurrency guard (never a second model). */
    guard: WorkspaceConcurrencyGuard;
    /** Same liveness seam the Goal channel uses to judge a lock holder. */
    isLockHolderActive(sessionId: string): boolean;
    /** ripgrep executable; defaults to `rg` resolved from PATH. */
    ripgrepExecutable?: string;
    limits?: Partial<DirectWorkspaceLimits>;
    /** Test-only seams; never wired in production. */
    testHooks?: DirectWorkspaceTestHooks;
}
export interface DirectoryEntry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size?: number;
    mtime?: string;
    /** Set for symlinks whose real target escapes the workspace root. */
    target_escapes?: boolean;
}
export interface SearchMatch {
    path: string;
    line: number;
    column: number;
    text: string;
}
export interface GitStatusEntry {
    path: string;
    index: string;
    worktree: string;
    status: string;
    /** Present on rename/copy records (the pre-image path). */
    original_path?: string;
}
export interface FileMutationOutcome {
    workspace_id: string;
    workspace_path: string;
    path: string;
    absolute_path: string;
    bytes: number;
    changed: boolean;
    created: boolean;
    old_sha256: string | null;
    new_sha256: string;
    mode: string;
    dry_run: boolean;
}
/**
 * Direct read/search/git/write service over registered workspaces.
 * One instance per Bridge; every operation is bounded and every refusal is a
 * stable code.
 */
export declare class DirectWorkspaceService {
    private readonly deps;
    private readonly limits;
    private readonly hooks;
    private readonly ripgrepExecutable;
    /** In-process serialization of direct writes per workspace path. */
    private readonly writeChains;
    /** Direct lock holders currently in flight (consulted by the Goal seam). */
    private readonly activeWriters;
    constructor(deps: DirectWorkspaceDeps);
    /** True while a direct write holds the guard lock for that pseudo-session. */
    isDirectWriterActive(sessionId: string): boolean;
    /** Effective bounds, reported by dsh_workspace_info. */
    describeLimits(): DirectWorkspaceLimits;
    workspaceInfo(input: string): Promise<Record<string, unknown>>;
    listDirectory(input: {
        workspace: string;
        path?: string;
        depth?: number;
        limit?: number;
        offset?: number;
    }): Promise<Record<string, unknown>>;
    readFile(input: {
        workspace: string;
        path: string;
        start_line?: number;
        end_line?: number;
        max_bytes?: number;
    }): Promise<Record<string, unknown>>;
    searchWorkspace(input: {
        workspace: string;
        query: string;
        path?: string;
        regex?: boolean;
        case_sensitive?: boolean;
        glob?: string;
        limit?: number;
        offset?: number;
    }): Promise<Record<string, unknown>>;
    gitStatus(input: {
        workspace: string;
    }): Promise<Record<string, unknown>>;
    gitDiff(input: {
        workspace: string;
        mode?: 'unstaged' | 'staged' | 'head' | 'ref';
        ref?: string;
        path?: string;
        offset?: number;
        max_lines?: number;
    }): Promise<Record<string, unknown>>;
    writeFile(input: {
        workspace: string;
        path: string;
        content: string;
        expected_sha256?: string;
        create_only?: boolean;
    }): Promise<FileMutationOutcome>;
    applyPatch(input: {
        workspace: string;
        path: string;
        old_text: string;
        new_text: string;
        expected_sha256?: string;
        replace_all?: boolean;
        line_start?: number;
        line_end?: number;
    }): Promise<FileMutationOutcome & {
        replacements: number;
    }>;
    private resolveWorkspace;
    /**
     * Prove one caller-supplied path resolves inside the registered workspace,
     * then apply the sensitive-path policy. Containment is lexical (`..`) AND
     * physical (realpath of the target or its nearest existing ancestor), so a
     * symlink cannot escape the root.
     */
    private resolveTarget;
    private assertWritableText;
    private boundedInteger;
    private assertSafeRegex;
    private hashFile;
    /**
     * Stream one bounded window of a UTF-8 text file. Binary files (NUL bytes)
     * and non-UTF-8 byte sequences are refused rather than lossily decoded.
     */
    private readTextWindow;
    private describeEntry;
    private isGitRepository;
    private gitSummaryIfAvailable;
    /** Repository-root-relative prefix of the workspace directory ('' or 'a/b/'). */
    private gitPrefix;
    private readGitStatus;
    private git;
    private searchWithRipgrep;
    private searchWithNode;
    /**
     * One serialized, lock-guarded, drift-checked file mutation.
     *
     * Order is deliberate: in-process serialization first, then the shared
     * WorkspaceConcurrencyGuard (refuse while a live Goal holds the lock, publish
     * a transient direct holder otherwise), then the excluded-path fingerprint
     * before and after the atomic write so a foreign change fails closed and is
     * rolled back.
     */
    private mutateFile;
    private mutateUnderLock;
    private readPreImage;
    /** Temporary file in the same directory + rename; mode is preserved. */
    private atomicWrite;
    private rollback;
    private withChain;
    private countOccurrences;
    private offsetOfLine;
    private endOffsetOfLine;
}
