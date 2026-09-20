/**
 * Direct workspace channel.
 *
 * ChatGPT can reach a registered workspace without starting a DSH Goal: this
 * module implements the Bridge's own file, search and git tools over the SAME
 * workspace registry and the SAME WorkspaceConcurrencyGuard the Goal channel
 * already uses. It never re-implements DSH: a direct write refuses to run while
 * a live Goal holds the workspace mutable lock, publishes its own transient
 * holder in that guard for the duration of one write, and fails closed on
 * workspace drift it did not cause.
 *
 * Security decisions are structural only — registered workspace + resolved
 * path facts + sensitive-path policy + live guard state + observed file/git
 * state. Goal free text, model reasoning and any other prose never enter a
 * permission decision here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isPathInsideWorkspace } from './paths.js';
import { classifySensitivePath, sensitiveSearchGlobs } from './sensitive-paths.js';
import { redactText } from './redact.js';
const execFileAsync = promisify(execFile);
/** Stable machine-readable error codes of the direct-workspace channel. */
export const DIRECT_WORKSPACE_ERROR_CODES = [
    'WORKSPACE_NOT_FOUND',
    'WORKSPACE_REGISTRY_UNAVAILABLE',
    'PATH_OUTSIDE_WORKSPACE',
    'SENSITIVE_PATH_DENIED',
    'BINARY_FILE_DENIED',
    'FILE_NOT_FOUND',
    'FILE_EXISTS',
    'FILE_TOO_LARGE',
    'IS_A_DIRECTORY',
    'NOT_A_DIRECTORY',
    'SYMLINK_NOT_WRITABLE',
    'DIRECTORY_NOT_FOUND',
    'PRECONDITION_FAILED',
    'PATCH_CONFLICT',
    'PATCH_INVALID',
    'WORKSPACE_LOCKED',
    'WORKSPACE_DRIFT',
    'WRITE_FAILED',
    'GIT_UNAVAILABLE',
    'GIT_NOT_A_REPOSITORY',
    'GIT_ERROR',
    'COMMAND_TIMEOUT',
    'SEARCH_FAILED',
    'INVALID_ARGUMENT',
];
/** Typed failure with a stable code, mapped to an MCP error result unchanged. */
export class DirectWorkspaceError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'DirectWorkspaceError';
        this.code = code;
        if (details !== undefined)
            this.details = details;
    }
}
export const DEFAULT_DIRECT_WORKSPACE_LIMITS = {
    maxReadBytes: 256 * 1024,
    maxScanBytes: 4 * 1024 * 1024,
    maxWriteBytes: 256 * 1024,
    maxPatchBytes: 256 * 1024,
    maxListEntries: 200,
    maxListDepth: 3,
    maxSearchResults: 200,
    maxSearchFiles: 4000,
    maxSearchScanBytes: 32 * 1024 * 1024,
    maxSearchFileBytes: 2 * 1024 * 1024,
    maxDiffBytes: 4 * 1024 * 1024,
    maxDiffLines: 400,
    commandTimeoutMs: 20000,
};
const UTF8_DECODER_OPTIONS = { fatal: true };
function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}
function toPosix(path) {
    return path.split(sep).join('/');
}
function byteColumn(text, characterIndex) {
    return Buffer.byteLength(text.slice(0, characterIndex), 'utf8') + 1;
}
function hasUnpairedSurrogate(text) {
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                return true;
            index += 1;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}
function errnoOf(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}
function octalMode(mode) {
    return `0${(mode & 0o777).toString(8)}`;
}
/**
 * Direct read/search/git/write service over registered workspaces.
 * One instance per Bridge; every operation is bounded and every refusal is a
 * stable code.
 */
export class DirectWorkspaceService {
    deps;
    limits;
    hooks;
    ripgrepExecutable;
    /** In-process serialization of direct writes per workspace path. */
    writeChains = new Map();
    /** Direct lock holders currently in flight (consulted by the Goal seam). */
    activeWriters = new Set();
    constructor(deps) {
        this.deps = deps;
        this.limits = { ...DEFAULT_DIRECT_WORKSPACE_LIMITS, ...(deps.limits ?? {}) };
        this.hooks = deps.testHooks;
        this.ripgrepExecutable = deps.ripgrepExecutable ?? 'rg';
    }
    /** True while a direct write holds the guard lock for that pseudo-session. */
    isDirectWriterActive(sessionId) {
        return this.activeWriters.has(sessionId);
    }
    /** Effective bounds, reported by dsh_workspace_info. */
    describeLimits() {
        return { ...this.limits };
    }
    // ── read-only operations ──────────────────────────────────────────────────
    async workspaceInfo(input) {
        const workspace = await this.resolveWorkspace(input);
        const root = resolve(workspace.path);
        let exists = false;
        try {
            exists = (await stat(root)).isDirectory();
        }
        catch {
            exists = false;
        }
        const lock = this.deps.guard.getLock(root);
        return {
            workspace_id: workspace.id,
            title: workspace.title,
            path: root,
            exists,
            is_git_repository: exists ? await this.isGitRepository(root) : false,
            git: exists ? await this.gitSummaryIfAvailable(root) : null,
            lock: lock === undefined
                ? null
                : {
                    held: true,
                    kind: this.isDirectWriterActive(lock.sessionId) ? 'direct' : 'goal',
                    session_id: lock.sessionId,
                    goal_id: lock.goalId,
                    locked_at: new Date(lock.lockedAt).toISOString(),
                    holder_active: this.isDirectWriterActive(lock.sessionId) || this.deps.isLockHolderActive(lock.sessionId),
                },
            limits: this.limits,
            sensitive_policy: 'bridge-direct-workspace/1',
        };
    }
    async listDirectory(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        const root = resolve(workspace.path);
        const target = this.resolveTarget(workspace, input.path ?? '.', { required: false });
        const depth = this.boundedInteger(input.depth ?? 1, 1, this.limits.maxListDepth, 'depth');
        const limit = this.boundedInteger(input.limit ?? this.limits.maxListEntries, 1, this.limits.maxListEntries, 'limit');
        const offset = this.boundedInteger(input.offset ?? 0, 0, 1_000_000, 'offset');
        const info = await lstat(target.absolute).catch(() => undefined);
        if (info === undefined) {
            throw new DirectWorkspaceError('FILE_NOT_FOUND', `directory not found: ${target.relative === '' ? '.' : target.relative}`);
        }
        if (!info.isDirectory()) {
            throw new DirectWorkspaceError('NOT_A_DIRECTORY', `not a directory: ${target.relative}`);
        }
        const queue = [{ absolute: target.absolute, relative: target.relative, level: 0 }];
        const collected = [];
        let skippedSensitive = 0;
        let unreadable = 0;
        let walkTruncated = false;
        const maxCollect = offset + limit;
        while (queue.length > 0 && collected.length < maxCollect) {
            const current = queue.shift();
            if (current.level >= depth)
                continue;
            let children;
            try {
                children = await readdir(current.absolute, { withFileTypes: true });
            }
            catch {
                unreadable += 1;
                continue;
            }
            children.sort((left, right) => left.name.localeCompare(right.name));
            for (const child of children) {
                const childAbsolute = join(current.absolute, child.name);
                const childRelative = toPosix(relative(root, childAbsolute));
                const verdict = classifySensitivePath(childRelative);
                if (verdict.sensitive) {
                    skippedSensitive += 1;
                    continue;
                }
                const type = child.isDirectory()
                    ? 'directory'
                    : child.isFile()
                        ? 'file'
                        : child.isSymbolicLink()
                            ? 'symlink'
                            : 'other';
                collected.push({ name: child.name, path: childRelative, type });
                if (collected.length >= maxCollect) {
                    walkTruncated = true;
                    break;
                }
                if (type === 'directory' && current.level + 1 < depth) {
                    queue.push({ absolute: childAbsolute, relative: childRelative, level: current.level + 1 });
                }
            }
        }
        const page = collected.slice(offset, offset + limit);
        const entries = await Promise.all(page.map(async (entry) => this.describeEntry(workspace, entry)));
        const truncated = walkTruncated || collected.length > offset + entries.length;
        return {
            workspace_id: workspace.id,
            workspace_path: root,
            path: target.relative === '' ? '.' : target.relative,
            depth,
            limit,
            offset,
            entries,
            returned: entries.length,
            truncated,
            next_offset: truncated ? offset + entries.length : null,
            sensitive_skipped: skippedSensitive,
            unreadable_directories: unreadable,
        };
    }
    async readFile(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        const root = resolve(workspace.path);
        const target = this.resolveTarget(workspace, input.path, { required: true });
        const startLine = this.boundedInteger(input.start_line ?? 1, 1, 100_000_000, 'start_line');
        const endLine = input.end_line === undefined
            ? undefined
            : this.boundedInteger(input.end_line, startLine, 100_000_000, 'end_line');
        const maxBytes = this.boundedInteger(input.max_bytes ?? this.limits.maxReadBytes, 1, this.limits.maxReadBytes, 'max_bytes');
        const info = await lstat(target.absolute).catch(() => undefined);
        if (info === undefined) {
            throw new DirectWorkspaceError('FILE_NOT_FOUND', `file not found: ${target.relative}`, { path: target.relative });
        }
        if (info.isDirectory()) {
            throw new DirectWorkspaceError('IS_A_DIRECTORY', `not a file: ${target.relative}`, { path: target.relative });
        }
        if (!info.isFile()) {
            throw new DirectWorkspaceError('BINARY_FILE_DENIED', `not a regular file: ${target.relative}`, { path: target.relative });
        }
        const window = await this.readTextWindow(target.absolute, {
            startLine,
            ...(endLine === undefined ? {} : { endLine }),
            maxBytes,
        });
        const redacted = redactText(window.content) !== window.content;
        return {
            workspace_id: workspace.id,
            workspace_path: root,
            path: target.relative,
            absolute_path: target.absolute,
            size_bytes: info.size,
            mode: octalMode(info.mode),
            sha256: await this.hashFile(target.absolute),
            encoding: 'utf-8',
            content: window.content,
            start_line: window.start_line,
            end_line: window.end_line,
            returned_lines: window.returned_lines,
            total_lines: window.total_lines,
            complete: window.complete,
            truncated: window.truncated,
            byte_truncated: window.byte_truncated,
            next_start_line: window.truncated ? window.end_line + 1 : null,
            /** True when bridge-wide secret redaction altered the returned text. */
            redacted,
        };
    }
    async searchWorkspace(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        const root = resolve(workspace.path);
        const target = this.resolveTarget(workspace, input.path ?? '.', { required: false });
        const query = input.query;
        if (typeof query !== 'string' || query === '') {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'query must be a non-empty string');
        }
        if (query.length > 1000) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'query is limited to 1000 characters');
        }
        const limit = this.boundedInteger(input.limit ?? 100, 1, this.limits.maxSearchResults, 'limit');
        const offset = this.boundedInteger(input.offset ?? 0, 0, 1_000_000, 'offset');
        const useRegex = input.regex === true;
        const caseSensitive = input.case_sensitive === true;
        if (useRegex)
            this.assertSafeRegex(query);
        if (input.glob !== undefined && !/^[A-Za-z0-9._*?/{}[\]!,-]+$/.test(input.glob)) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'glob contains unsupported characters');
        }
        const info = await lstat(target.absolute).catch(() => undefined);
        if (info === undefined) {
            throw new DirectWorkspaceError('FILE_NOT_FOUND', `search root not found: ${target.relative === '' ? '.' : target.relative}`);
        }
        if (!info.isDirectory()) {
            throw new DirectWorkspaceError('NOT_A_DIRECTORY', `search root is not a directory: ${target.relative}`);
        }
        const searchTarget = target.relative === '' ? '.' : target.relative;
        const options = { query, useRegex, caseSensitive, glob: input.glob, limit, offset };
        const ripgrep = this.hooks?.forceSearchEngine === 'node'
            ? undefined
            : await this.searchWithRipgrep(root, searchTarget, options);
        const result = ripgrep ?? await this.searchWithNode(root, target.absolute, options);
        return {
            workspace_id: workspace.id,
            workspace_path: root,
            path: searchTarget,
            query,
            regex: useRegex,
            case_sensitive: caseSensitive,
            engine: ripgrep === undefined ? 'node' : 'ripgrep',
            matches: result.matches.map((match) => ({
                ...match,
                ...(redactText(match.text) === match.text ? {} : { redacted: true }),
                text: redactText(match.text),
            })),
            returned: result.matches.length,
            offset,
            next_offset: result.truncated ? offset + result.matches.length : null,
            truncated: result.truncated,
            files_scanned: result.filesScanned ?? null,
        };
    }
    async gitStatus(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        const root = resolve(workspace.path);
        const summary = await this.readGitStatus(root);
        return {
            workspace_id: workspace.id,
            workspace_path: root,
            read_only: true,
            ...summary,
        };
    }
    async gitDiff(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        const root = resolve(workspace.path);
        const mode = input.mode ?? 'unstaged';
        const offset = this.boundedInteger(input.offset ?? 0, 0, 1_000_000, 'offset');
        const maxLines = this.boundedInteger(input.max_lines ?? this.limits.maxDiffLines, 1, this.limits.maxDiffLines, 'max_lines');
        let targetPath;
        if (input.path !== undefined && input.path !== '') {
            const target = this.resolveTarget(workspace, input.path, { required: true });
            targetPath = target.relative;
        }
        const args = [];
        if (mode === 'staged')
            args.push('--cached');
        if (mode === 'ref') {
            const ref = input.ref ?? '';
            if (!/^[A-Za-z0-9_][A-Za-z0-9._/~^{}@-]*$/.test(ref)) {
                throw new DirectWorkspaceError('INVALID_ARGUMENT', 'ref must be a plain revision name (no option prefix, whitespace, or rev:path form)', { ref: input.ref });
            }
            args.push(ref);
        }
        if (mode === 'head')
            args.push('HEAD');
        const nameArgs = ['diff', '--name-only', '-z', '--no-ext-diff', '--relative', ...args];
        const changed = await this.git(nameArgs, root);
        const changedPaths = changed.stdout.split('\0').filter((item) => item !== '');
        const visiblePaths = changedPaths.filter((item) => !classifySensitivePath(item).sensitive);
        const omitted = changedPaths.length - visiblePaths.length;
        const diffArgs = ['diff', '--no-ext-diff', '--no-color', '--no-textconv', '--relative', ...args];
        const pathspecs = [];
        if (targetPath !== undefined)
            pathspecs.push(targetPath);
        for (const hide of changedPaths.filter((item) => classifySensitivePath(item).sensitive).slice(0, 500)) {
            pathspecs.push(`:(exclude,literal)${hide}`);
        }
        if (pathspecs.length > 0)
            diffArgs.push('--', ...pathspecs);
        const diff = await this.git(diffArgs, root);
        const text = diff.stdout;
        const allLines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
        const page = allLines.slice(offset, offset + maxLines);
        return {
            workspace_id: workspace.id,
            workspace_path: root,
            read_only: true,
            mode,
            ...(mode === 'ref' ? { ref: input.ref } : {}),
            ...(targetPath === undefined ? {} : { path: targetPath }),
            changed_files: visiblePaths,
            sensitive_omitted: omitted,
            offset,
            max_lines: maxLines,
            total_lines: allLines.length,
            returned_lines: page.length,
            next_offset: offset + page.length < allLines.length ? offset + page.length : null,
            truncated: offset + page.length < allLines.length,
            output_truncated: diff.truncated,
            diff: page.join('\n'),
        };
    }
    // ── write operations ──────────────────────────────────────────────────────
    async writeFile(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        const target = this.resolveTarget(workspace, input.path, { required: true });
        if (typeof input.content !== 'string') {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'content must be a string');
        }
        this.assertWritableText(input.content, 'content');
        return this.mutateFile({
            workspace,
            target,
            tool: 'write_file',
            ...(input.expected_sha256 === undefined ? {} : { expectedSha256: input.expected_sha256 }),
            ...(input.create_only === undefined ? {} : { createOnly: input.create_only }),
            build: () => input.content,
        });
    }
    async applyPatch(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        const target = this.resolveTarget(workspace, input.path, { required: true });
        if (typeof input.old_text !== 'string' || input.old_text === '') {
            throw new DirectWorkspaceError('PATCH_INVALID', 'old_text must be a non-empty string');
        }
        if (typeof input.new_text !== 'string') {
            throw new DirectWorkspaceError('PATCH_INVALID', 'new_text must be a string');
        }
        if (input.old_text === input.new_text) {
            throw new DirectWorkspaceError('PATCH_INVALID', 'old_text and new_text are identical');
        }
        const lineStart = input.line_start === undefined
            ? undefined
            : this.boundedInteger(input.line_start, 1, 100_000_000, 'line_start');
        const lineEnd = input.line_end === undefined
            ? undefined
            : this.boundedInteger(input.line_end, lineStart ?? 1, 100_000_000, 'line_end');
        let replacements = 0;
        const outcome = await this.mutateFile({
            workspace,
            target,
            tool: 'apply_patch',
            ...(input.expected_sha256 === undefined ? {} : { expectedSha256: input.expected_sha256 }),
            build: (before) => {
                const text = before.text;
                if (text === undefined) {
                    throw new DirectWorkspaceError('PATCH_CONFLICT', `cannot patch a file that does not exist: ${target.relative}`, {
                        path: target.relative,
                        matches: 0,
                    });
                }
                const searchStart = lineStart === undefined ? 0 : this.offsetOfLine(text, lineStart);
                const searchEnd = lineEnd === undefined ? text.length : this.endOffsetOfLine(text, lineEnd);
                if (searchStart > searchEnd) {
                    throw new DirectWorkspaceError('PATCH_INVALID', 'line_start is after line_end');
                }
                const scoped = text.slice(searchStart, searchEnd);
                const matches = this.countOccurrences(scoped, input.old_text);
                if (matches === 0) {
                    throw new DirectWorkspaceError('PATCH_CONFLICT', 'old_text does not match the target file', {
                        path: target.relative,
                        matches: 0,
                        ...(lineStart === undefined ? {} : { line_start: lineStart, line_end: lineEnd }),
                    });
                }
                if (matches > 1 && input.replace_all !== true) {
                    throw new DirectWorkspaceError('PATCH_CONFLICT', `old_text matches ${matches} times; make it unique, pass replace_all=true, or scope it with line_start/line_end`, { path: target.relative, matches });
                }
                replacements = matches;
                const patchedScope = input.replace_all === true
                    ? scoped.split(input.old_text).join(input.new_text)
                    : scoped.replace(input.old_text, input.new_text);
                const patched = text.slice(0, searchStart) + patchedScope + text.slice(searchEnd);
                this.assertWritableText(patched, 'patched content');
                return patched;
            },
        });
        return { ...outcome, replacements };
    }
    // ── path + target resolution ──────────────────────────────────────────────
    async resolveWorkspace(input) {
        if (typeof input !== 'string' || input.trim() === '') {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'workspace must be a non-empty id, path, or title');
        }
        return this.deps.resolveWorkspace(input);
    }
    /**
     * Prove one caller-supplied path resolves inside the registered workspace,
     * then apply the sensitive-path policy. Containment is lexical (`..`) AND
     * physical (realpath of the target or its nearest existing ancestor), so a
     * symlink cannot escape the root.
     */
    resolveTarget(workspace, input, options) {
        if (typeof input !== 'string') {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'path must be a string');
        }
        if (input.includes('\0')) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'path contains a NUL byte');
        }
        const trimmed = input.trim();
        if (options.required && trimmed === '') {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'path is required');
        }
        const root = resolve(workspace.path);
        const absolute = trimmed === '' || trimmed === '.'
            ? root
            : isAbsolute(trimmed)
                ? resolve(trimmed)
                : resolve(root, trimmed);
        if (!isPathInsideWorkspace(absolute, root)) {
            throw new DirectWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'path resolves outside the registered workspace root', { path: input, workspace_path: root });
        }
        const relativePath = toPosix(relative(root, absolute));
        if (relativePath !== '') {
            const verdict = classifySensitivePath(relativePath);
            if (verdict.sensitive) {
                throw new DirectWorkspaceError('SENSITIVE_PATH_DENIED', `path is denied by the Bridge sensitive-path policy (${verdict.reason ?? 'sensitive'})`, { path: relativePath, workspace_path: root, reason: verdict.reason });
            }
        }
        return { absolute, relative: relativePath };
    }
    assertWritableText(text, label) {
        if (text.includes('\0')) {
            throw new DirectWorkspaceError('BINARY_FILE_DENIED', `${label} contains a NUL byte; only UTF-8 text is writable`);
        }
        if (hasUnpairedSurrogate(text)) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', `${label} contains an unpaired UTF-16 surrogate and is not valid UTF-8 text`);
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > this.limits.maxWriteBytes) {
            throw new DirectWorkspaceError('FILE_TOO_LARGE', `${label} is ${bytes} bytes; one write is limited to ${this.limits.maxWriteBytes} bytes`, { bytes, max_bytes: this.limits.maxWriteBytes });
        }
    }
    boundedInteger(value, min, max, label) {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', `${label} must be an integer`);
        }
        if (value < min || value > max) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`);
        }
        return value;
    }
    assertSafeRegex(pattern) {
        if (pattern.length > 500) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'regex pattern is limited to 500 characters');
        }
        // Reject the constructs with catastrophic backtracking potential; the node
        // fallback compiles this pattern in-process, so it must stay linear-ish.
        if (/\(\?[^)]*[+*{]/.test(pattern) || /\([^)]*[+*]\)[+*]/.test(pattern)) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', 'regex uses a nested quantifier that is not supported');
        }
        try {
            new RegExp(pattern);
        }
        catch (error) {
            throw new DirectWorkspaceError('INVALID_ARGUMENT', `regex is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // ── file reads ────────────────────────────────────────────────────────────
    async hashFile(absolute) {
        const handle = await open(absolute, 'r');
        try {
            const hash = createHash('sha256');
            const buffer = Buffer.allocUnsafe(64 * 1024);
            for (;;) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (bytesRead === 0)
                    break;
                hash.update(buffer.subarray(0, bytesRead));
            }
            return hash.digest('hex');
        }
        finally {
            await handle.close();
        }
    }
    /**
     * Stream one bounded window of a UTF-8 text file. Binary files (NUL bytes)
     * and non-UTF-8 byte sequences are refused rather than lossily decoded.
     */
    async readTextWindow(absolute, options) {
        const decoder = new TextDecoder('utf-8', UTF8_DECODER_OPTIONS);
        const handle = await open(absolute, 'r');
        const out = [];
        let pending = '';
        let lineNumber = 0;
        let collectedBytes = 0;
        let scannedBytes = 0;
        let complete = false;
        let byteTruncated = false;
        let limitStop = false;
        let moreContent = false;
        let firstLine;
        let lastLine;
        const endLine = options.endLine ?? Number.MAX_SAFE_INTEGER;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const consume = (line) => {
            if (lineNumber < options.startLine)
                return true;
            if (lineNumber > endLine) {
                // Past the requested window: keep scanning (bounded by maxScanBytes) so
                // `truncated` reports honestly that more content exists instead of
                // guessing from the fact that we stopped early.
                moreContent = true;
                return true;
            }
            // The joining newline counts against the byte budget too.
            const separator = out.length > 0 ? 1 : 0;
            const remaining = options.maxBytes - collectedBytes - separator;
            if (remaining <= 0) {
                byteTruncated = true;
                return false;
            }
            let value = line;
            if (Buffer.byteLength(value, 'utf8') > remaining) {
                // Cut on the byte budget, then repair a possible split surrogate pair.
                value = Buffer.from(value, 'utf8').subarray(0, remaining).toString('utf8');
                byteTruncated = true;
            }
            firstLine ??= lineNumber;
            lastLine = lineNumber;
            out.push(value);
            collectedBytes += Buffer.byteLength(value, 'utf8') + separator;
            return !byteTruncated;
        };
        try {
            scan: while (scannedBytes < this.limits.maxScanBytes) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (bytesRead === 0) {
                    complete = true;
                    break;
                }
                scannedBytes += bytesRead;
                const slice = buffer.subarray(0, bytesRead);
                if (slice.includes(0)) {
                    throw new DirectWorkspaceError('BINARY_FILE_DENIED', 'file contains NUL bytes and is not UTF-8 text', { path: absolute });
                }
                let text;
                try {
                    text = decoder.decode(slice, { stream: true });
                }
                catch {
                    throw new DirectWorkspaceError('BINARY_FILE_DENIED', 'file is not valid UTF-8 text', { path: absolute });
                }
                pending += text;
                for (;;) {
                    const index = pending.indexOf('\n');
                    if (index < 0)
                        break;
                    let line = pending.slice(0, index);
                    pending = pending.slice(index + 1);
                    if (line.endsWith('\r'))
                        line = line.slice(0, -1);
                    lineNumber += 1;
                    if (!consume(line)) {
                        limitStop = true;
                        break scan;
                    }
                }
                if (limitStop)
                    break;
            }
            if (complete && pending !== '') {
                lineNumber += 1;
                consume(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
                pending = '';
            }
        }
        finally {
            await handle.close();
        }
        // `truncated` means "content beyond the returned window exists or may
        // exist": either we stopped before EOF, hit the byte budget, or observed
        // lines after end_line while scanning to EOF.
        const truncated = !complete || byteTruncated || moreContent;
        return {
            content: out.join('\n'),
            start_line: firstLine ?? options.startLine,
            end_line: lastLine ?? firstLine ?? options.startLine,
            returned_lines: out.length,
            total_lines: complete ? lineNumber : null,
            complete,
            truncated,
            byte_truncated: byteTruncated,
            scanned_bytes: scannedBytes,
        };
    }
    // ── directory helpers ─────────────────────────────────────────────────────
    async describeEntry(workspace, entry) {
        const absolute = join(resolve(workspace.path), entry.path);
        try {
            const info = await lstat(absolute);
            if (entry.type === 'symlink') {
                const escapes = !isPathInsideWorkspace(absolute, resolve(workspace.path));
                return {
                    ...entry,
                    mtime: new Date(info.mtimeMs).toISOString(),
                    ...(escapes ? { target_escapes: true } : {}),
                };
            }
            return { ...entry, size: info.size, mtime: new Date(info.mtimeMs).toISOString() };
        }
        catch {
            return entry;
        }
    }
    // ── git (read-only) ───────────────────────────────────────────────────────
    async isGitRepository(root) {
        try {
            const result = await this.git(['rev-parse', '--is-inside-work-tree'], root);
            return result.stdout.trim() === 'true';
        }
        catch {
            return false;
        }
    }
    async gitSummaryIfAvailable(root) {
        try {
            return await this.readGitStatus(root);
        }
        catch {
            return null;
        }
    }
    /** Repository-root-relative prefix of the workspace directory ('' or 'a/b/'). */
    async gitPrefix(root) {
        try {
            const result = await this.git(['rev-parse', '--show-prefix'], root);
            return result.stdout.trim();
        }
        catch {
            return '';
        }
    }
    async readGitStatus(root) {
        const { stdout } = await this.git(['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z'], root);
        // Porcelain status paths are repository-root-relative; report them
        // workspace-relative like every other direct-workspace tool.
        const prefix = await this.gitPrefix(root);
        const records = stdout.split('\0');
        let branch = null;
        let upstream = null;
        let ahead = null;
        let behind = null;
        const entries = [];
        let sensitiveOmitted = 0;
        let index = 0;
        if (records.length > 0 && records[0].startsWith('## ')) {
            const header = records[0].slice(3);
            index = 1;
            const trackIndex = header.indexOf('...');
            if (trackIndex < 0) {
                branch = header.replace(/^No commits yet on /, '').replace(/ \(no branch\)$/, '');
                if (header === 'HEAD (no branch)')
                    branch = null;
            }
            else {
                branch = header.slice(0, trackIndex);
                const rest = header.slice(trackIndex + 3);
                const bracket = rest.indexOf(' [');
                upstream = bracket < 0 ? rest : rest.slice(0, bracket);
                const tracked = bracket < 0 ? '' : rest.slice(bracket + 2, -1);
                const aheadMatch = /ahead (\d+)/.exec(tracked);
                const behindMatch = /behind (\d+)/.exec(tracked);
                ahead = aheadMatch === null ? 0 : Number(aheadMatch[1]);
                behind = behindMatch === null ? 0 : Number(behindMatch[1]);
            }
        }
        for (let cursor = index; cursor < records.length; cursor += 1) {
            const record = records[cursor];
            if (record === '' || record.length < 4)
                continue;
            const indexStatus = record[0];
            const worktreeStatus = record[1];
            const path = stripGitPrefix(record.slice(3), prefix);
            if (path === '')
                continue;
            let originalPath;
            if (indexStatus === 'R' || indexStatus === 'C') {
                originalPath = stripGitPrefix(records[cursor + 1] ?? '', prefix);
                cursor += 1;
            }
            if (classifySensitivePath(path).sensitive || (originalPath !== undefined && classifySensitivePath(originalPath).sensitive)) {
                sensitiveOmitted += 1;
                continue;
            }
            entries.push({
                path,
                index: indexStatus,
                worktree: worktreeStatus,
                status: `${indexStatus}${worktreeStatus}`,
                ...(originalPath === undefined ? {} : { original_path: originalPath }),
            });
        }
        return {
            branch,
            upstream,
            ahead,
            behind,
            clean: entries.length === 0,
            dirty_count: entries.length,
            entries,
            sensitive_omitted: sensitiveOmitted,
        };
    }
    async git(args, root) {
        try {
            const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
                cwd: root,
                timeout: this.limits.commandTimeoutMs,
                maxBuffer: this.limits.maxDiffBytes,
                windowsHide: true,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
            });
            return { stdout, truncated: stdout.length >= this.limits.maxDiffBytes - 1 };
        }
        catch (error) {
            const errno = errnoOf(error);
            if (errno === 'ENOENT') {
                throw new DirectWorkspaceError('GIT_UNAVAILABLE', 'git executable is not available on this host');
            }
            const stderr = String(error.stderr ?? '');
            const killed = error.killed === true || errno === 'ETIMEDOUT';
            if (killed) {
                throw new DirectWorkspaceError('COMMAND_TIMEOUT', `git ${args[0] ?? ''} timed out after ${this.limits.commandTimeoutMs}ms`);
            }
            if (/not a git repository/i.test(stderr)) {
                throw new DirectWorkspaceError('GIT_NOT_A_REPOSITORY', 'the workspace is not inside a git work tree', { workspace_path: root });
            }
            if (errno === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                return { stdout: String(error.stdout ?? ''), truncated: true };
            }
            throw new DirectWorkspaceError('GIT_ERROR', `git ${args[0] ?? ''} failed: ${redactText(stderr.trim() || (error instanceof Error ? error.message : String(error)))}`);
        }
    }
    // ── search engines ────────────────────────────────────────────────────────
    async searchWithRipgrep(root, target, options) {
        const wanted = options.offset + options.limit;
        return new Promise((resolvePromise, reject) => {
            const args = [
                '--json',
                '--no-messages',
                '--color', 'never',
                '--max-filesize', String(this.limits.maxSearchFileBytes),
                '--max-columns', '400',
                '--max-columns-preview',
            ];
            for (const glob of sensitiveSearchGlobs())
                args.push('--glob', glob);
            args.push('--glob', '!**/.git/**');
            if (options.glob !== undefined)
                args.push('--glob', options.glob);
            if (!options.caseSensitive)
                args.push('--ignore-case');
            if (!options.useRegex)
                args.push('--fixed-strings');
            args.push('-e', options.query, '--', target);
            let child;
            try {
                child = spawn(this.ripgrepExecutable, args, { cwd: root, windowsHide: true });
            }
            catch {
                resolvePromise(undefined);
                return;
            }
            const matches = [];
            let allMatches = 0;
            let settled = false;
            let pending = '';
            let stderr = '';
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                resolvePromise(value);
            };
            child.on('error', (error) => {
                if (error.code === 'ENOENT') {
                    finish(undefined);
                    return;
                }
                finish(undefined);
            });
            child.stderr?.on('data', (chunk) => {
                if (stderr.length < 4096)
                    stderr += chunk.toString();
            });
            child.stdout?.on('data', (chunk) => {
                pending += chunk.toString('utf8');
                for (;;) {
                    if (settled)
                        return;
                    const index = pending.indexOf('\n');
                    if (index < 0)
                        break;
                    const line = pending.slice(0, index);
                    pending = pending.slice(index + 1);
                    if (line === '')
                        continue;
                    let event;
                    try {
                        event = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    const parsed = event;
                    if (parsed.type !== 'match' || parsed.data === undefined)
                        continue;
                    const path = parsed.data.path?.text;
                    if (path === undefined || classifySensitivePath(path).sensitive)
                        continue;
                    allMatches += 1;
                    if (allMatches <= options.offset)
                        continue;
                    if (matches.length >= options.limit)
                        continue;
                    const rawText = (parsed.data.lines?.text ?? '').replace(/\r?\n$/, '');
                    const matchLine = parsed.data.line_number ?? 0;
                    const submatches = parsed.data.submatches ?? [];
                    const columnStarts = submatches
                        .map((item) => item.start)
                        .filter((value) => typeof value === 'number');
                    matches.push({
                        path,
                        line: matchLine,
                        column: columnStarts.length === 0 ? 1 : byteColumn(rawText, columnStarts[0]),
                        text: rawText,
                    });
                    if (allMatches >= wanted) {
                        if (matches.length >= options.limit) {
                            child.kill('SIGKILL');
                            finish({ matches, truncated: true });
                        }
                    }
                }
            });
            child.on('close', () => {
                if (settled)
                    return;
                if (child.exitCode === 127 || /command not found/i.test(stderr)) {
                    finish(undefined);
                    return;
                }
                finish({ matches, truncated: matches.length >= options.limit });
            });
        });
    }
    async searchWithNode(root, targetAbsolute, options) {
        const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
        let matcher;
        if (options.useRegex) {
            matcher = new RegExp(options.query, options.caseSensitive ? '' : 'i');
        }
        const fileGlob = options.glob === undefined ? undefined : globToRegExp(options.glob);
        const matches = [];
        let allMatches = 0;
        let filesScanned = 0;
        let scannedBytes = 0;
        let truncated = false;
        const stack = [targetAbsolute];
        const skippedDirectories = new Set(['.git', 'node_modules', '.dsh']);
        while (stack.length > 0) {
            const current = stack.pop();
            if (filesScanned >= this.limits.maxSearchFiles || scannedBytes >= this.limits.maxSearchScanBytes) {
                truncated = true;
                break;
            }
            let children;
            try {
                children = await readdir(current, { withFileTypes: true });
            }
            catch {
                continue;
            }
            children.sort((left, right) => left.name.localeCompare(right.name));
            for (const child of children) {
                const absolute = join(current, child.name);
                const relativePath = toPosix(relative(root, absolute));
                if (classifySensitivePath(relativePath).sensitive)
                    continue;
                if (child.isDirectory()) {
                    if (skippedDirectories.has(child.name))
                        continue;
                    stack.push(absolute);
                    continue;
                }
                if (!child.isFile())
                    continue;
                if (fileGlob !== undefined && !fileGlob.test(child.name))
                    continue;
                filesScanned += 1;
                if (filesScanned > this.limits.maxSearchFiles) {
                    truncated = true;
                    break;
                }
                let info;
                try {
                    info = await lstat(absolute);
                }
                catch {
                    continue;
                }
                if (info.size > this.limits.maxSearchFileBytes)
                    continue;
                scannedBytes += info.size;
                if (scannedBytes > this.limits.maxSearchScanBytes) {
                    truncated = true;
                    break;
                }
                let buffer;
                try {
                    buffer = await readAll(absolute);
                }
                catch {
                    continue;
                }
                if (buffer.includes(0))
                    continue;
                let text;
                try {
                    text = new TextDecoder('utf-8', UTF8_DECODER_OPTIONS).decode(buffer);
                }
                catch {
                    continue;
                }
                const lines = text.split('\n');
                for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
                    const line = lines[lineNumber - 1].replace(/\r$/, '');
                    const hit = matcher !== undefined
                        ? matcher.exec(line)
                        : (options.caseSensitive ? line : line.toLowerCase()).indexOf(needle) >= 0
                            ? { index: (options.caseSensitive ? line : line.toLowerCase()).indexOf(needle) }
                            : null;
                    if (hit === null)
                        continue;
                    allMatches += 1;
                    if (allMatches <= options.offset)
                        continue;
                    if (matches.length >= options.limit) {
                        truncated = true;
                        break;
                    }
                    matches.push({
                        path: relativePath,
                        line: lineNumber,
                        column: byteColumn(line, hit.index),
                        text: line.length > 400 ? line.slice(0, 400) : line,
                    });
                }
                if (matches.length >= options.limit) {
                    truncated = true;
                    break;
                }
            }
            if (matches.length >= options.limit)
                break;
        }
        return { matches, truncated, filesScanned };
    }
    // ── mutation core ─────────────────────────────────────────────────────────
    /**
     * One serialized, lock-guarded, drift-checked file mutation.
     *
     * Order is deliberate: in-process serialization first, then the shared
     * WorkspaceConcurrencyGuard (refuse while a live Goal holds the lock, publish
     * a transient direct holder otherwise), then the excluded-path fingerprint
     * before and after the atomic write so a foreign change fails closed and is
     * rolled back.
     */
    async mutateFile(params) {
        const root = resolve(params.workspace.path);
        const key = toPosix(root);
        return this.withChain(key, async () => {
            const existingHolder = this.deps.guard.getLock(root);
            if (existingHolder !== undefined) {
                const active = this.isDirectWriterActive(existingHolder.sessionId) || this.deps.isLockHolderActive(existingHolder.sessionId);
                if (active) {
                    throw new DirectWorkspaceError('WORKSPACE_LOCKED', `workspace is locked by session ${existingHolder.sessionId} (goal ${existingHolder.goalId}); use dsh_start_goal/dsh_send_message for this workspace or wait for the Goal to finish`, {
                        status: 'waiting_for_workspace_lock',
                        holder_session_id: existingHolder.sessionId,
                        holder_goal_id: existingHolder.goalId,
                        workspace_path: root,
                    });
                }
            }
            const directSessionId = `direct-${randomUUID()}`;
            const acquired = this.deps.guard.acquireMutableLock(root, directSessionId, 'direct-workspace', false, false);
            if (!acquired.success) {
                throw new DirectWorkspaceError('WORKSPACE_LOCKED', 'workspace mutable lock could not be acquired', {
                    holder_session_id: acquired.holder?.sessionId,
                    workspace_path: root,
                });
            }
            this.activeWriters.add(directSessionId);
            try {
                return await this.mutateUnderLock(params, root, directSessionId);
            }
            finally {
                this.activeWriters.delete(directSessionId);
                this.deps.guard.releaseLock(directSessionId);
            }
        });
    }
    async mutateUnderLock(params, root, directSessionId) {
        const { absolute, relative: relativePath } = params.target;
        const before = await this.readPreImage(absolute, relativePath);
        if (params.createOnly === true && before !== undefined) {
            throw new DirectWorkspaceError('FILE_EXISTS', `file already exists: ${relativePath}`, { path: relativePath });
        }
        if (params.expectedSha256 !== undefined) {
            if (!/^[a-f0-9]{64}$/i.test(params.expectedSha256)) {
                throw new DirectWorkspaceError('INVALID_ARGUMENT', 'expected_sha256 must be a 64-character hex digest');
            }
            const actual = before?.sha256 ?? null;
            if (actual !== params.expectedSha256.toLowerCase()) {
                throw new DirectWorkspaceError('PRECONDITION_FAILED', `expected_sha256 does not match the current file content (current: ${actual ?? 'file does not exist'})`, { path: relativePath, expected_sha256: params.expectedSha256.toLowerCase(), actual_sha256: actual });
            }
        }
        const text = params.build({
            text: before?.text,
            sha256: before?.sha256 ?? null,
            mode: before?.mode,
        });
        this.assertWritableText(text, 'content');
        const parent = dirname(absolute);
        let parentInfo;
        try {
            parentInfo = await stat(parent);
        }
        catch {
            throw new DirectWorkspaceError('DIRECTORY_NOT_FOUND', `parent directory does not exist: ${toPosix(relative(root, parent))}`, {
                path: relativePath,
            });
        }
        if (!parentInfo.isDirectory()) {
            throw new DirectWorkspaceError('NOT_A_DIRECTORY', `parent path is not a directory: ${toPosix(relative(root, parent))}`);
        }
        if (!isPathInsideWorkspace(absolute, root)) {
            throw new DirectWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'target path resolves outside the workspace root', {
                path: relativePath,
            });
        }
        const excluded = [relativePath];
        const baselineBefore = await this.deps.guard.captureBaseline(root, { excludePaths: excluded });
        const data = Buffer.from(text, 'utf8');
        await this.atomicWrite(absolute, data, root, before?.mode);
        let committed = true;
        try {
            await this.hooks?.afterWriteBeforeFingerprint?.({ workspacePath: root, path: relativePath });
            const baselineAfter = await this.deps.guard.captureBaseline(root, { excludePaths: excluded });
            const drift = describeDrift(baselineBefore, baselineAfter);
            if (drift !== undefined) {
                await this.rollback(absolute, before, root);
                committed = false;
                throw new DirectWorkspaceError('WORKSPACE_DRIFT', `${drift}; the direct write was rolled back`, {
                    path: relativePath,
                    workspace_path: root,
                    expected_fingerprint: baselineBefore.workspaceFingerprint,
                    actual_fingerprint: baselineAfter.workspaceFingerprint,
                    expected_head: baselineBefore.headSha,
                    actual_head: baselineAfter.headSha,
                });
            }
        }
        catch (error) {
            if (committed) {
                // A failure after the bytes landed (drift hook, fingerprint capture)
                // must not leave an unverified mutation behind.
                if (!(error instanceof DirectWorkspaceError && error.code === 'WORKSPACE_DRIFT')) {
                    await this.rollback(absolute, before, root);
                }
            }
            throw error;
        }
        this.deps.guard.recordMutation(root, {
            sessionId: directSessionId,
            goalId: 'direct-workspace',
            type: params.tool,
            details: relativePath,
        });
        const newSha = sha256(data);
        return {
            workspace_id: params.workspace.id,
            workspace_path: root,
            path: relativePath,
            absolute_path: absolute,
            bytes: data.length,
            changed: before?.sha256 !== newSha,
            created: before === undefined,
            old_sha256: before?.sha256 ?? null,
            new_sha256: newSha,
            mode: octalMode(before?.mode ?? 0o644),
            dry_run: false,
        };
    }
    async readPreImage(absolute, relativePath) {
        let info;
        try {
            info = await lstat(absolute);
        }
        catch (error) {
            if (errnoOf(error) === 'ENOENT')
                return undefined;
            throw new DirectWorkspaceError('FILE_NOT_FOUND', `cannot inspect ${relativePath}: ${errnoOf(error) ?? 'unknown error'}`, {
                path: relativePath,
            });
        }
        if (info.isSymbolicLink()) {
            throw new DirectWorkspaceError('SYMLINK_NOT_WRITABLE', `refusing to write through a symlink: ${relativePath}`, {
                path: relativePath,
            });
        }
        if (info.isDirectory()) {
            throw new DirectWorkspaceError('IS_A_DIRECTORY', `not a file: ${relativePath}`, { path: relativePath });
        }
        if (!info.isFile()) {
            throw new DirectWorkspaceError('BINARY_FILE_DENIED', `not a regular file: ${relativePath}`, { path: relativePath });
        }
        if (info.size > this.limits.maxPatchBytes) {
            throw new DirectWorkspaceError('FILE_TOO_LARGE', `existing file is ${info.size} bytes; the direct write channel is limited to ${this.limits.maxPatchBytes} bytes per file`, { path: relativePath, bytes: info.size, max_bytes: this.limits.maxPatchBytes });
        }
        const buffer = await readAll(absolute);
        if (buffer.includes(0)) {
            throw new DirectWorkspaceError('BINARY_FILE_DENIED', `file is binary and cannot be patched: ${relativePath}`, {
                path: relativePath,
            });
        }
        let text;
        try {
            text = new TextDecoder('utf-8', UTF8_DECODER_OPTIONS).decode(buffer);
        }
        catch {
            throw new DirectWorkspaceError('BINARY_FILE_DENIED', `file is not valid UTF-8 text: ${relativePath}`, {
                path: relativePath,
            });
        }
        return { text, sha256: sha256(buffer), mode: info.mode };
    }
    /** Temporary file in the same directory + rename; mode is preserved. */
    async atomicWrite(absolute, data, root, mode) {
        const directory = dirname(absolute);
        const temporary = join(directory, `.dsh-direct-${randomUUID()}.tmp`);
        const effectiveMode = (mode ?? 0o644) & 0o777;
        let handle;
        try {
            handle = await open(temporary, 'wx', effectiveMode);
            await handle.writeFile(data);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await chmod(temporary, effectiveMode);
            if (!isPathInsideWorkspace(absolute, root)) {
                throw new DirectWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'target path escaped the workspace root before commit');
            }
            await rename(temporary, absolute);
        }
        catch (error) {
            try {
                if (handle !== undefined)
                    await handle.close();
            }
            catch {
                // best effort
            }
            await rm(temporary, { force: true }).catch(() => { });
            if (error instanceof DirectWorkspaceError)
                throw error;
            throw new DirectWorkspaceError('WRITE_FAILED', `atomic write failed for ${absolute}: ${redactText(error instanceof Error ? error.message : String(error))}`);
        }
        // Durability of the rename itself; not supported everywhere.
        try {
            const directoryHandle = await open(directory, fsConstants.O_RDONLY);
            try {
                await directoryHandle.sync();
            }
            finally {
                await directoryHandle.close();
            }
        }
        catch {
            // best effort
        }
    }
    async rollback(absolute, before, root) {
        try {
            if (before === undefined) {
                await rm(absolute, { force: true });
                return;
            }
            await this.atomicWrite(absolute, Buffer.from(before.text, 'utf8'), root, before.mode);
        }
        catch {
            // Rollback failure is reported through WORKSPACE_DRIFT details; never mask
            // the original refusal.
        }
    }
    withChain(key, work) {
        const previous = this.writeChains.get(key) ?? Promise.resolve();
        const run = previous.then(work, work);
        this.writeChains.set(key, run.then(() => undefined, () => undefined));
        return run;
    }
    // ── text helpers ──────────────────────────────────────────────────────────
    countOccurrences(haystack, needle) {
        let count = 0;
        let index = 0;
        for (;;) {
            const found = haystack.indexOf(needle, index);
            if (found < 0)
                return count;
            count += 1;
            index = found + needle.length;
            if (count > 1000)
                return count;
        }
    }
    offsetOfLine(text, line) {
        if (line <= 1)
            return 0;
        let current = 1;
        let index = 0;
        while (current < line) {
            const next = text.indexOf('\n', index);
            if (next < 0)
                return text.length;
            index = next + 1;
            current += 1;
        }
        return index;
    }
    endOffsetOfLine(text, line) {
        let current = 1;
        let index = 0;
        while (current <= line) {
            const next = text.indexOf('\n', index);
            if (next < 0)
                return text.length;
            index = next + 1;
            current += 1;
        }
        return index;
    }
}
/** Read a whole regular file, used only behind explicit size limits. */
async function readAll(absolute) {
    const handle = await open(absolute, 'r');
    try {
        const chunks = [];
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        return Buffer.concat(chunks);
    }
    finally {
        await handle.close();
    }
}
/** Drop the repository-root prefix so status paths stay workspace-relative. */
function stripGitPrefix(path, prefix) {
    if (prefix === '' || path === '')
        return path;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
function describeDrift(before, after) {
    const headDrifted = before.headSha !== after.headSha;
    const fingerprintDrifted = before.workspaceFingerprint !== after.workspaceFingerprint;
    if (!headDrifted && !fingerprintDrifted)
        return undefined;
    const changes = [
        ...(headDrifted ? [`Git HEAD ${before.headSha?.slice(0, 7) ?? 'none'} -> ${after.headSha?.slice(0, 7) ?? 'none'}`] : []),
        ...(fingerprintDrifted ? ['workspace fingerprint changed outside this operation'] : []),
    ];
    return `Workspace drifted while the direct write was in flight: ${changes.join('; ')}`;
}
/** Minimal `*`/`**`/`?` glob translation for the node search fallback. */
function globToRegExp(glob) {
    let pattern = '';
    for (let index = 0; index < glob.length; index += 1) {
        const character = glob[index];
        if (character === '*') {
            if (glob[index + 1] === '*') {
                pattern += '.*';
                index += 1;
            }
            else {
                pattern += '[^/]*';
            }
        }
        else if (character === '?') {
            pattern += '[^/]';
        }
        else if ('\\^$.|+()[]{}'.includes(character)) {
            pattern += `\\${character}`;
        }
        else {
            pattern += character;
        }
    }
    return new RegExp(`(^|/)${pattern}$`);
}
