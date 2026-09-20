/**
 * Workspace Concurrency Guard: Single mutable session lock, baseline
 * Git HEAD / dirty status snapshot, pre-mutation drift detection, and
 * cross-session operation provenance tracking.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { normalizePath } from './paths.js';
const execFileAsync = promisify(execFile);
function normalizeExcludePaths(paths) {
    if (paths === undefined || paths.length === 0)
        return [];
    const seen = new Set();
    for (const item of paths) {
        const normalized = item.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        if (normalized !== '')
            seen.add(normalized);
    }
    return [...seen];
}
/** `XY <path>` (or `R  <old> -> <new>`) porcelain path extraction. */
function porcelainPath(line) {
    const arrow = line.indexOf(' -> ');
    const raw = arrow < 0 ? line.slice(3) : line.slice(arrow + 4);
    return unquoteGitPath(raw);
}
function unquoteGitPath(raw) {
    return raw.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
}
export class WorkspaceConcurrencyGuard {
    locks = new Map(); // normalizedPath -> lock
    sessionLocks = new Map(); // sessionId -> normalizedPath
    mutations = new Map(); // normalizedPath -> mutations
    /**
     * Attempt to acquire an exclusive mutable session lock for a workspace.
     * Read-only sessions do not need to acquire this lock.
     */
    acquireMutableLock(workspacePath, sessionId, goalId, isExistingHolderActive = true, override = false) {
        const key = normalizePath(workspacePath);
        const existing = this.locks.get(key);
        if (existing !== undefined && existing.sessionId !== sessionId) {
            if (!isExistingHolderActive || override) {
                this.sessionLocks.delete(existing.sessionId);
                this.locks.set(key, { sessionId, goalId, workspacePath: key, lockedAt: Date.now() });
                this.sessionLocks.set(sessionId, key);
                return {
                    success: true,
                    ...(isExistingHolderActive && override ? {
                        warning: `Workspace mutable lock overridden. Previous holder: session ${existing.sessionId}, goal ${existing.goalId}`,
                    } : {}),
                };
            }
            return { success: false, holder: existing };
        }
        const holder = {
            sessionId,
            goalId,
            workspacePath: key,
            lockedAt: Date.now(),
        };
        this.locks.set(key, holder);
        this.sessionLocks.set(sessionId, key);
        return { success: true, holder };
    }
    /** Release mutable lock held by a session upon completion or cancellation. */
    releaseLock(sessionId) {
        const key = this.sessionLocks.get(sessionId);
        if (key === undefined)
            return false;
        this.sessionLocks.delete(sessionId);
        const holder = this.locks.get(key);
        if (holder?.sessionId === sessionId) {
            this.locks.delete(key);
            return true;
        }
        return false;
    }
    getLock(workspacePath) {
        return this.locks.get(normalizePath(workspacePath));
    }
    /** Record a mutating operation (write, commit, tag, publish) for provenance. */
    recordMutation(workspacePath, record) {
        const key = normalizePath(workspacePath);
        const list = this.mutations.get(key) ?? [];
        list.push({ ...record, timestamp: Date.now() });
        if (list.length > 100)
            list.shift();
        this.mutations.set(key, list);
    }
    getLastMutation(workspacePath) {
        const list = this.mutations.get(normalizePath(workspacePath));
        return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
    }
    /** Capture baseline git HEAD SHA and dirty file status at Goal start. */
    async captureBaseline(workspacePath, options) {
        const normalized = normalizePath(workspacePath);
        const excludePaths = normalizeExcludePaths(options?.excludePaths);
        const excluded = new Set(excludePaths);
        // `git status` reports repository-root-relative paths while `git diff` and
        // `git ls-files` pathspecs are cwd-relative. Map the caller's
        // workspace-relative excludes onto both spellings.
        let statusPrefix = '';
        if (excludePaths.length > 0) {
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', '--show-prefix'], {
                    cwd: normalized,
                    timeout: 5000,
                });
                statusPrefix = stdout.trim();
            }
            catch {
                statusPrefix = '';
            }
        }
        const statusExcluded = new Set(excludePaths.map((item) => `${statusPrefix}${item}`));
        let headSha;
        let dirtyFiles = [];
        let statusRaw = '';
        let unstagedDiff = '';
        let stagedDiff = '';
        let untrackedMetadata = [];
        try {
            const { stdout: headOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
                cwd: normalized,
                timeout: 5000,
            });
            headSha = headOut.trim();
        }
        catch {
            // Not a git repo or git not found
        }
        try {
            const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
                cwd: normalized,
                timeout: 5000,
                maxBuffer: 32 * 1024 * 1024,
            });
            const kept = statusOut
                .split('\n')
                .map((line) => line.replace(/\r$/, ''))
                .filter((line) => line.trim().length > 0)
                .filter((line) => statusExcluded.size === 0 || !statusExcluded.has(porcelainPath(line)));
            statusRaw = kept.join('\n');
            dirtyFiles = kept.map((line) => line.trim());
        }
        catch {
            // ignore
        }
        const diffArgs = ['diff', '--no-ext-diff', '--binary', '--'];
        if (excludePaths.length > 0) {
            diffArgs.push(...excludePaths.map((item) => `:(exclude,literal)${item}`));
        }
        try {
            const { stdout } = await execFileAsync('git', diffArgs, {
                cwd: normalized,
                timeout: 10000,
                maxBuffer: 32 * 1024 * 1024,
            });
            unstagedDiff = stdout;
        }
        catch {
            // Status still provides a conservative fallback fingerprint.
        }
        const stagedArgs = [...diffArgs];
        stagedArgs.splice(1, 0, '--cached');
        try {
            const { stdout } = await execFileAsync('git', stagedArgs, {
                cwd: normalized,
                timeout: 10000,
                maxBuffer: 32 * 1024 * 1024,
            });
            stagedDiff = stdout;
        }
        catch {
            // Status still provides a conservative fallback fingerprint.
        }
        const lsFilesArgs = ['ls-files', '--others', '--exclude-standard', '-z'];
        if (excludePaths.length > 0) {
            lsFilesArgs.push('--', ...excludePaths.map((item) => `:(exclude,literal)${item}`));
        }
        try {
            const { stdout } = await execFileAsync('git', lsFilesArgs, {
                cwd: normalized,
                timeout: 5000,
                maxBuffer: 8 * 1024 * 1024,
            });
            const untracked = stdout
                .split('\0')
                .filter((item) => item !== '')
                .filter((item) => !excluded.has(item))
                .sort();
            untrackedMetadata = await Promise.all(untracked.map(async (relativePath) => {
                try {
                    const info = await stat(join(normalized, relativePath));
                    return `${relativePath}\0${info.size}\0${Math.trunc(info.mtimeMs)}`;
                }
                catch {
                    return `${relativePath}\0missing`;
                }
            }));
        }
        catch {
            // Status already contains untracked path names.
        }
        const workspaceFingerprint = createHash('sha256')
            .update(statusRaw)
            .update('\0unstaged\0')
            .update(unstagedDiff)
            .update('\0staged\0')
            .update(stagedDiff)
            .update('\0untracked\0')
            .update(untrackedMetadata.join('\0'))
            .digest('hex');
        return {
            workspacePath: normalized,
            headSha,
            dirtyFiles,
            workspaceFingerprint,
            timestamp: Date.now(),
        };
    }
    /** Detect workspace state drift since baseline. */
    async detectDrift(workspacePath, baseline, currentSessionId, currentSnapshot) {
        const normalized = normalizePath(workspacePath);
        try {
            const current = currentSnapshot ?? await this.captureBaseline(normalized);
            const headDrifted = baseline.headSha !== undefined && current.headSha !== baseline.headSha;
            const workspaceDrifted = baseline.workspaceFingerprint !== undefined
                && current.workspaceFingerprint !== baseline.workspaceFingerprint;
            if (headDrifted || workspaceDrifted) {
                const lastMutation = this.getLastMutation(normalized);
                const originating = lastMutation?.sessionId !== currentSessionId ? lastMutation?.sessionId : undefined;
                const changes = [
                    ...(headDrifted
                        ? [`Git HEAD ${baseline.headSha?.slice(0, 7) ?? 'unknown'} -> ${current.headSha?.slice(0, 7) ?? 'unknown'}`]
                        : []),
                    ...(workspaceDrifted ? ['working tree/index fingerprint changed'] : []),
                ];
                const details = `Workspace drifted: ${changes.join('; ')}` +
                    (originating ? ` (likely from session ${originating})` : '');
                return {
                    drifted: true,
                    currentSha: current.headSha,
                    details,
                    originatingSessionId: originating,
                };
            }
        }
        catch {
            // ignore
        }
        return { drifted: false };
    }
}
